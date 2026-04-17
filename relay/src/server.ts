/**
 * SGCleanRelay — Stateless routing proxy for SpAIglass VM fleet.
 *
 * Routes browser WebSocket connections to private SpAIglass VMs.
 * GitHub OAuth for identity. No secrets, files, or conversations stored.
 */

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { getRequestListener } from "@hono/node-server";
import { createServer } from "node:http";
import { createNodeWebSocket } from "@hono/node-ws";
import { getCookie } from "hono/cookie";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { marked } from "marked";
import { join as pathJoin } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  initDb,
  cleanExpiredSessions,
  getUserBySessionToken,
  getConnectorById,
  getConnectorByName,
  getConnectorBySlug,
  getConnectorsByUser,
  getSharedConnectorsForUser,
  getConnectorAccess,
  connectorDisplayName,
  updateConnectorDisplayName,
  getUserPreference,
  setUserPreference,
  createAgentKey,
  type ConnectorRole,
} from "./db.ts";
import { authRoutes, SESSION_COOKIE } from "./auth.ts";
import { connectorRoutes } from "./connectors.ts";
import { agentKeyRoutes } from "./agent-keys.ts";
import { authMiddleware, rateLimit, securityHeaders } from "./middleware.ts";
import {
  handleConnectorWs,
  createBrowserWsHandler,
  getChannelManager,
} from "./tunnel.ts";
import type { RelayEnv } from "./types.ts";

// --- Configuration ---

const PORT = parseInt(process.env.PORT || "4000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const DB_PATH = process.env.DB_PATH || "./relay.db";
// Latest spaiglass install version. Bumped on each frontend bundle release.
// Read from /opt/sgcleanrelay/release/VERSION (or RELEASE_DIR/VERSION) at startup.
// Connectors reporting an older version trigger the update banner on the dashboard.
const RELEASE_DIR = process.env.RELEASE_DIR || "/opt/sgcleanrelay/release";

// Git commit SHA the relay was built from. Set by CI (GIT_SHA env var) or via
// the `RELAY_COMMIT` env var when running locally. Exposed in /api/health so
// users can run `gh attestation verify` against a known commit.
const RELAY_COMMIT =
  process.env.RELAY_COMMIT || process.env.GIT_SHA || "unknown";
// Frontend bundle served for /vm/:slug/ pages. We serve the SPA from the relay
// instead of tunneling each page load through the connector — VMs only need
// to handle /api/* requests. Falls back to tunneled serving if this dir is
// missing, so a fresh deploy without the frontend copy still works.
const RELAY_FRONTEND_DIR =
  process.env.RELAY_FRONTEND_DIR || "/opt/sgcleanrelay/frontend";
const ARCHITECTURE_DIR =
  process.env.ARCHITECTURE_DIR || "/opt/sgcleanrelay/architecture";

if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
  console.warn(
    "WARNING: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET not set. OAuth will not work.",
  );
}

// --- Canonical role-file baseline ---
//
// Served at /roletemplate (HTML) and /roletemplate.md (raw). Referenced from
// the setup guide so a setup agent running on a fresh VM can drop a working
// role file in place without stopping to ask the human what to write. This
// is intentionally minimal — identity line, project dir, a short list of
// hard rules, and an explicit "this is a baseline, discuss with your human"
// footer. Everything else belongs in the setup guide as suggestions.
const ROLE_TEMPLATE_MD = `---
model: claude-opus-4-6
---
# <PROJECT_NAME> — Developer

IMPORTANT: You are the primary developer for **<PROJECT_NAME>** in the directory \`~/projects/<PROJECT_NAME>/\`. You are a senior engineer with a shell on this machine. Execute, don't narrate — report results, not intentions.

## Project location
\`~/projects/<PROJECT_NAME>/\`

## How to check your work
Run the project's own build / typecheck / test / lint commands before declaring work done. If none exist yet, ask the human what "done" looks like on the first turn and record those commands in this file.

## When context compacts
Preserve: modified files, pending deploys, the current task, and verification commands.

## Hard rules
- NEVER commit credentials — live tokens leak into git history permanently.
- NEVER force-push to main — other sessions and automation depend on linear history.
- NEVER run destructive operations (rm -rf, DROP TABLE, force push, sudo rm) without explicit instruction.

---

**This file is a baseline.** Talk to your human about strengthening it for SpAIglass effectiveness — see <https://spaiglass.xyz/setup> for the full guide (frontmatter schema, architecture/verification/access sections, anti-patterns). This file is also compatible with the [AGENTS.md](https://agents.md) convention — the same content works as \`AGENTS.md\` at the repo root.
`;


// --- Server-side compact name helpers (mirrors client-side abbreviate/compactName) ---

function serverAbbreviate(word: string, maxLen: number): string {
  if (word.length <= maxLen) return word;
  // Split camelCase / hyphens / underscores into parts
  const parts = word
    .replace(/([a-z])([A-Z])/g, "$1\0$2")
    .replace(/[-_]/g, "\0")
    .split("\0")
    .filter(Boolean);
  if (parts.length > 1) {
    let result = "";
    for (let i = 0; i < parts.length; i++) {
      if ((result + parts[i]).length <= maxLen) {
        result += parts[i];
      } else {
        const rem = maxLen - result.length;
        if (rem > 0) result += parts[i].slice(0, rem);
        break;
      }
    }
    return result;
  }
  if (maxLen <= 3) return word.charAt(0).toUpperCase() + word.slice(1, maxLen);
  const stripped =
    word.charAt(0).toUpperCase() + word.slice(1).replace(/[aeiou]/gi, "");
  return stripped.length <= maxLen ? stripped : stripped.slice(0, maxLen);
}

function serverCompactName(proj: string, role: string): string {
  const full = proj + "-" + role;
  if (full.length <= 10) return full;
  const budget = 9;
  let pBudget = Math.min(proj.length, Math.ceil(budget * 0.6));
  let rBudget = budget - pBudget;
  if (rBudget < 2) {
    rBudget = 2;
    pBudget = budget - 2;
  }
  if (pBudget < 2) {
    pBudget = 2;
    rBudget = budget - 2;
  }
  if (proj.length < pBudget) {
    rBudget += pBudget - proj.length;
    pBudget = proj.length;
  }
  if (role.length < rBudget) {
    pBudget += rBudget - role.length;
    rBudget = role.length;
  }
  return (
    serverAbbreviate(proj, pBudget) + "-" + serverAbbreviate(role, rBudget)
  );
}

// --- Shared HTML helpers ---

// Inline SVG favicon — SpAIglass eye icon
const FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#131318"/><g fill="#fff"><path fill-rule="evenodd" d="M2,32C7,15 20,12 32,12C44,12 57,15 62,32C57,49 44,52 32,52C20,52 7,49 2,32ZM9,32C13,21 22,17 32,17C42,17 51,21 55,32C51,43 42,47 32,47C22,47 13,43 9,32Z"/><path d="M21.5,26.5C16,28 9,30 9,32C9,34 16,36 21.5,37.5A11,11 0 0,0 21.5,26.5Z"/><path fill-rule="evenodd" d="M20,32A11,11 0 1,1 42,32A11,11 0 1,1 20,32ZM24,32A7,7 0 1,0 38,32A7,7 0 1,0 24,32Z"/><path d="M31,32L27,28A5,5 0 1,1 26,33Z"/></g></svg>')}" />`;

// --- Theme system ---
// Four themes (70s-light, 70s-dark, glass, corporate) + phosphor color selector for 70s themes.
// Persists in localStorage. Goes in <head> to apply before paint (no flash).
const THEME_HEAD = `
<link href="https://fonts.googleapis.com/css2?family=VT323&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<link href="https://api.fontshare.com/v2/css?f[]=clash-display@500,600,700&f[]=satoshi@400,500,700&display=swap" rel="stylesheet">
<script>
(function() {
  var t = localStorage.getItem('sg_theme') || 'glass';
  var p = localStorage.getItem('sg_phosphor') || 'green';
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.setAttribute('data-phosphor', p);
})();
</script>
<style>
/* Phosphor presets — apply in 70s themes */
[data-phosphor="green"] { --phosphor: #33ff33; }
[data-phosphor="amber"] { --phosphor: #ffb000; }
[data-phosphor="white"] { --phosphor: #f0f0f0; }
[data-phosphor="cyan"]  { --phosphor: #00ffff; }
[data-phosphor="red"]   { --phosphor: #ff5050; }

/* ============ GLASS THEME ============ */
[data-theme="glass"] body {
  background: #0A0A0F !important;
  background-image: radial-gradient(ellipse at top left, rgba(124,77,255,0.15), transparent 50%), radial-gradient(ellipse at bottom right, rgba(0,188,212,0.12), transparent 50%) !important;
  color: #E0E0F0 !important;
  font-family: 'Satoshi', system-ui, sans-serif !important;
  min-height: 100vh;
}
[data-theme="glass"] h1, [data-theme="glass"] h2, [data-theme="glass"] h3 {
  color: #F0F0FF !important;
  font-family: 'Clash Display', system-ui, sans-serif !important;
  font-weight: 600 !important;
}
[data-theme="glass"] h1 { background: linear-gradient(135deg, #00BCD4, #7C4DFF); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
[data-theme="glass"] p, [data-theme="glass"] li, [data-theme="glass"] .pitch, [data-theme="glass"] .subtitle { color: #C0C0D8 !important; }
[data-theme="glass"] a { color: #00BCD4 !important; }
[data-theme="glass"] a:hover { color: #4DD0E1 !important; }
[data-theme="glass"] .card, [data-theme="glass"] .features, [data-theme="glass"] .info, [data-theme="glass"] .claude-hint {
  background: rgba(255,255,255,0.04) !important;
  border: 1px solid rgba(255,255,255,0.1) !important;
  border-radius: 14px !important;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 8px 32px rgba(0,0,0,0.4) !important;
  color: #E0E0F0 !important;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
}
[data-theme="glass"] .card:hover {
  border-color: rgba(0,188,212,0.3) !important;
  box-shadow: 0 12px 40px rgba(0,188,212,0.15) !important;
  transform: translateY(-2px);
}
[data-theme="glass"] .claude-hint strong { color: #00BCD4 !important; }
[data-theme="glass"] pre, [data-theme="glass"] code, [data-theme="glass"] .copy-box {
  background: rgba(0,0,0,0.5) !important;
  color: #C0FFFF !important;
  border: 1px solid rgba(0,188,212,0.3) !important;
  font-family: 'IBM Plex Mono', ui-monospace, monospace !important;
}
[data-theme="glass"] code.block { display: block; }
[data-theme="glass"] a.btn, [data-theme="glass"] .btn-primary, [data-theme="glass"] button.btn-primary {
  background: linear-gradient(135deg, #00BCD4, #7C4DFF) !important;
  color: #0A0A0F !important;
  border: none !important;
  font-family: 'Clash Display', system-ui, sans-serif !important;
  font-weight: 600 !important;
  font-size: 0.9em !important;
  padding: 10px 20px !important;
  border-radius: 10px !important;
  box-shadow: 0 4px 16px rgba(0,188,212,0.4) !important;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
}
[data-theme="glass"] a.btn:hover, [data-theme="glass"] .btn-primary:hover, [data-theme="glass"] button.btn-primary:hover {
  transform: translateY(-2px) !important;
  box-shadow: 0 8px 24px rgba(0,188,212,0.5) !important;
}
[data-theme="glass"] .btn, [data-theme="glass"] button.btn {
  font-family: 'Satoshi', system-ui, sans-serif !important;
  font-weight: 500 !important;
  padding: 8px 16px !important;
  border-radius: 10px !important;
  font-size: 0.85em !important;
  background: rgba(255,255,255,0.08) !important;
  color: #E0E0F0 !important;
  border: 1px solid rgba(255,255,255,0.15) !important;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
}
[data-theme="glass"] .btn:hover, [data-theme="glass"] button.btn:hover {
  background: rgba(255,255,255,0.14) !important;
  border-color: rgba(0,188,212,0.4) !important;
  transform: translateY(-1px) !important;
}
[data-theme="glass"] .btn-secondary { background: rgba(255,255,255,0.08) !important; color: #E0E0F0 !important; border: 1px solid rgba(255,255,255,0.15) !important; }
[data-theme="glass"] .btn-danger {
  background: rgba(239,68,68,0.2) !important;
  color: #f87171 !important;
  border: 1px solid rgba(239,68,68,0.4) !important;
}
[data-theme="glass"] .btn-danger:hover {
  background: rgba(239,68,68,0.7) !important;
  color: #fff !important;
  border-color: transparent !important;
}
[data-theme="glass"] input {
  background: rgba(0,0,0,0.4) !important;
  color: #E0E0F0 !important;
  border: 1px solid rgba(255,255,255,0.15) !important;
  border-radius: 10px !important;
  font-family: 'Satoshi', system-ui, sans-serif !important;
}
[data-theme="glass"] input:focus {
  border-color: rgba(0,188,212,0.5) !important;
  box-shadow: 0 0 0 3px rgba(0,188,212,0.15) !important;
  outline: none !important;
}
[data-theme="glass"] .modal {
  background: rgba(15,15,25,0.85) !important;
  border: 1px solid rgba(255,255,255,0.1) !important;
  border-radius: 16px !important;
  backdrop-filter: blur(20px) !important;
  -webkit-backdrop-filter: blur(20px) !important;
  box-shadow: 0 20px 60px rgba(0,0,0,0.5) !important;
  color: #E0E0F0 !important;
}
[data-theme="glass"] .modal h2 { font-family: 'Clash Display', system-ui, sans-serif !important; color: #F0F0FF !important; }
[data-theme="glass"] .modal .modal-sub { color: #8a8aa0 !important; }
[data-theme="glass"] .modal .platform-tab { color: #8a8aa0 !important; font-family: 'Satoshi', system-ui, sans-serif !important; }
[data-theme="glass"] .modal .platform-tab.active { color: #00BCD4 !important; border-bottom-color: #00BCD4 !important; }
[data-theme="glass"] .modal .platform-tabs { border-bottom-color: rgba(255,255,255,0.1) !important; }
[data-theme="glass"] .modal .warn { background: rgba(251,191,36,0.1) !important; border-color: rgba(251,191,36,0.3) !important; color: #fbbf24 !important; }
[data-theme="glass"] .footer, [data-theme="glass"] .footer a, [data-theme="glass"] .updated, [data-theme="glass"] .note, [data-theme="glass"] .mit { color: #8a8aa0 !important; }
[data-theme="glass"] .server-row .name { font-family: 'Clash Display', system-ui, sans-serif !important; font-weight: 600 !important; }
[data-theme="glass"] .server-row .id, [data-theme="glass"] .role-row .role-url, [data-theme="glass"] .show-hidden { color: #8a8aa0 !important; }
[data-theme="glass"] .role-row:hover { background: rgba(255,255,255,0.05) !important; }
[data-theme="glass"] .role-divider { border-top-color: rgba(255,255,255,0.08) !important; }
[data-theme="glass"] .copy-box:hover { background: rgba(0,0,0,0.6) !important; }
[data-theme="glass"] .copy-btn { background: none !important; border: 1px solid #00BCD4 !important; color: #00BCD4 !important; border-radius: 6px !important; }
[data-theme="glass"] .copy-btn.copied { border-color: #22c55e !important; color: #22c55e !important; }
[data-theme="glass"] .role-row .role-name { color: #00BCD4 !important; font-family: 'Satoshi', system-ui, sans-serif !important; font-weight: 500 !important; }
[data-theme="glass"] .brand-name { font-family: 'Clash Display', system-ui, sans-serif !important; }

/* ============ 70s DARK THEME — Terminal.css philosophy: monochrome, bordered, no fills ============
   Inspired by terminalcss.xyz (MIT). Authentic VT100/Apple IIe rules:
   - Single phosphor color throughout (text, borders, accents — no second color)
   - Buttons: transparent bg + 1px border + phosphor text. Hover inverts.
   - No scanlines, no big colored fills. Subtle text glow only.
*/
[data-theme="70s-dark"] body {
  background: #0c0e0c !important;
  color: var(--phosphor, #33ff33) !important;
  font-family: 'IBM Plex Mono', 'VT323', 'Courier New', monospace !important;
  font-size: 15px !important;
  line-height: 1.5 !important;
}
[data-theme="70s-dark"] h1, [data-theme="70s-dark"] h2, [data-theme="70s-dark"] h3 {
  color: var(--phosphor, #33ff33) !important;
  font-family: 'IBM Plex Mono', monospace !important;
  font-weight: 600 !important;
  text-shadow: 0 0 2px currentColor;
  letter-spacing: 0.5px;
}
[data-theme="70s-dark"] h1 { font-size: 1.8em !important; }
[data-theme="70s-dark"] h2 { font-size: 1.25em !important; }
[data-theme="70s-dark"] p, [data-theme="70s-dark"] li {
  color: var(--phosphor, #33ff33) !important;
  font-family: 'IBM Plex Mono', monospace !important;
  text-shadow: 0 0 1px currentColor;
}
[data-theme="70s-dark"] .tagline { color: var(--phosphor, #33ff33) !important; font-family: 'IBM Plex Mono', monospace !important; font-size: 1.05em !important; opacity: 0.85; }
[data-theme="70s-dark"] .subtitle, [data-theme="70s-dark"] .pitch { color: var(--phosphor, #33ff33) !important; opacity: 0.75; }
[data-theme="70s-dark"] a { color: var(--phosphor, #33ff33) !important; text-decoration: underline; }
[data-theme="70s-dark"] a:hover { background: var(--phosphor, #33ff33) !important; color: #0c0e0c !important; text-decoration: none; }
[data-theme="70s-dark"] .card, [data-theme="70s-dark"] .features, [data-theme="70s-dark"] .info, [data-theme="70s-dark"] .claude-hint {
  background: transparent !important;
  border: 1px solid var(--phosphor, #33ff33) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  color: var(--phosphor, #33ff33) !important;
}
[data-theme="70s-dark"] pre, [data-theme="70s-dark"] code, [data-theme="70s-dark"] .copy-box {
  background: transparent !important;
  color: var(--phosphor, #33ff33) !important;
  border: 1px solid var(--phosphor, #33ff33) !important;
  border-radius: 0 !important;
  font-family: 'IBM Plex Mono', monospace !important;
}
[data-theme="70s-dark"] a.btn, [data-theme="70s-dark"] .btn-primary, [data-theme="70s-dark"] button.btn-primary,
[data-theme="70s-dark"] button:not(#theme-toggle button), [data-theme="70s-dark"] .btn {
  background: transparent !important;
  color: var(--phosphor, #33ff33) !important;
  border: 1px solid var(--phosphor, #33ff33) !important;
  border-radius: 0 !important;
  font-family: 'IBM Plex Mono', monospace !important;
  font-weight: 500 !important;
  font-size: 13px !important;
  box-shadow: none !important;
  text-shadow: 0 0 1px currentColor !important;
  padding: 6px 14px !important;
  cursor: pointer;
  transition: none !important;
}
[data-theme="70s-dark"] a.btn:hover, [data-theme="70s-dark"] .btn-primary:hover, [data-theme="70s-dark"] button.btn-primary:hover,
[data-theme="70s-dark"] button:not(#theme-toggle button):hover, [data-theme="70s-dark"] .btn:hover {
  background: var(--phosphor, #33ff33) !important;
  color: #0c0e0c !important;
  text-shadow: none !important;
}
[data-theme="70s-dark"] .btn-secondary { background: transparent !important; color: var(--phosphor, #33ff33) !important; border: 1px solid var(--phosphor, #33ff33) !important; opacity: 0.8; }
[data-theme="70s-dark"] .btn-danger { background: transparent !important; color: var(--phosphor, #33ff33) !important; border: 1px solid var(--phosphor, #33ff33) !important; }
[data-theme="70s-dark"] .btn-danger:hover { background: var(--phosphor, #33ff33) !important; color: #0c0e0c !important; }
[data-theme="70s-dark"] .btn-ghost { background: none !important; color: var(--phosphor, #33ff33) !important; box-shadow: none !important; border: 1px solid var(--phosphor, #33ff33) !important; opacity: 0.7; }
[data-theme="70s-dark"] input { background: transparent !important; color: var(--phosphor, #33ff33) !important; border: 1px solid var(--phosphor, #33ff33) !important; border-radius: 0 !important; font-family: 'IBM Plex Mono', monospace !important; }
[data-theme="70s-dark"] input::placeholder { color: var(--phosphor, #33ff33) !important; opacity: 0.4; }
[data-theme="70s-dark"] .role-row .role-name { color: var(--phosphor, #33ff33) !important; font-family: 'IBM Plex Mono', monospace !important; }
[data-theme="70s-dark"] .role-row .role-url, [data-theme="70s-dark"] .server-row .id, [data-theme="70s-dark"] .show-hidden { color: var(--phosphor, #33ff33) !important; opacity: 0.55; }
[data-theme="70s-dark"] .role-row:hover { background: rgba(51,255,51,0.06) !important; }
[data-theme="70s-dark"] .role-divider { border-top-color: var(--phosphor, #33ff33) !important; opacity: 0.2; }
[data-theme="70s-dark"] .footer, [data-theme="70s-dark"] .footer a, [data-theme="70s-dark"] .updated, [data-theme="70s-dark"] .note, [data-theme="70s-dark"] .mit { color: var(--phosphor, #33ff33) !important; opacity: 0.55; }
[data-theme="70s-dark"] .copy-btn { background: transparent !important; color: var(--phosphor, #33ff33) !important; border: 1px solid var(--phosphor, #33ff33) !important; }
[data-theme="70s-dark"] .copy-btn:hover { background: var(--phosphor, #33ff33) !important; color: #0c0e0c !important; }
[data-theme="70s-dark"] .claude-hint strong { color: var(--phosphor, #33ff33) !important; }
[data-theme="70s-dark"] .brand-name { color: var(--phosphor, #33ff33) !important; text-shadow: 0 0 2px currentColor; }

/* ============ 70s LIGHT THEME — same philosophy, parchment background ============ */
[data-theme="70s-light"] body {
  background: #f4ecd8 !important;
  color: #2d1810 !important;
  font-family: 'IBM Plex Mono', 'VT323', 'Courier New', monospace !important;
  font-size: 15px !important;
  line-height: 1.5 !important;
}
[data-theme="70s-light"] h1, [data-theme="70s-light"] h2, [data-theme="70s-light"] h3 { color: #2d1810 !important; font-family: 'IBM Plex Mono', monospace !important; font-weight: 600 !important; }
[data-theme="70s-light"] h1 { font-size: 1.8em !important; }
[data-theme="70s-light"] h2 { font-size: 1.25em !important; }
[data-theme="70s-light"] p, [data-theme="70s-light"] li { color: #3d2818 !important; font-family: 'IBM Plex Mono', monospace !important; }
[data-theme="70s-light"] .tagline { color: #6b1f0a !important; font-family: 'IBM Plex Mono', monospace !important; font-size: 1.05em !important; }
[data-theme="70s-light"] .subtitle, [data-theme="70s-light"] .pitch { color: #5a3820 !important; }
[data-theme="70s-light"] a { color: #6b1f0a !important; text-decoration: underline; }
[data-theme="70s-light"] a:hover { background: #2d1810 !important; color: #f4ecd8 !important; text-decoration: none; }
[data-theme="70s-light"] .card, [data-theme="70s-light"] .features, [data-theme="70s-light"] .info, [data-theme="70s-light"] .claude-hint {
  background: transparent !important;
  border: 1px solid #2d1810 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  color: #2d1810 !important;
}
[data-theme="70s-light"] pre, [data-theme="70s-light"] code, [data-theme="70s-light"] .copy-box {
  background: transparent !important;
  color: #2d1810 !important;
  border: 1px solid #2d1810 !important;
  border-radius: 0 !important;
  font-family: 'IBM Plex Mono', monospace !important;
}
[data-theme="70s-light"] a.btn, [data-theme="70s-light"] .btn-primary, [data-theme="70s-light"] button.btn-primary,
[data-theme="70s-light"] button:not(#theme-toggle button), [data-theme="70s-light"] .btn {
  background: transparent !important;
  color: #2d1810 !important;
  border: 1px solid #2d1810 !important;
  border-radius: 0 !important;
  font-family: 'IBM Plex Mono', monospace !important;
  font-weight: 500 !important;
  font-size: 13px !important;
  box-shadow: none !important;
  text-shadow: none !important;
  padding: 6px 14px !important;
  cursor: pointer;
  transition: none !important;
}
[data-theme="70s-light"] a.btn:hover, [data-theme="70s-light"] .btn-primary:hover, [data-theme="70s-light"] button.btn-primary:hover,
[data-theme="70s-light"] button:not(#theme-toggle button):hover, [data-theme="70s-light"] .btn:hover {
  background: #2d1810 !important;
  color: #f4ecd8 !important;
}
[data-theme="70s-light"] .btn-secondary { background: transparent !important; color: #2d1810 !important; border: 1px solid #2d1810 !important; opacity: 0.8; }
[data-theme="70s-light"] .btn-danger { background: transparent !important; color: #2d1810 !important; border: 1px solid #2d1810 !important; }
[data-theme="70s-light"] .btn-danger:hover { background: #2d1810 !important; color: #f4ecd8 !important; }
[data-theme="70s-light"] .btn-ghost { background: none !important; box-shadow: none !important; border: 1px solid #2d1810 !important; opacity: 0.7; }
[data-theme="70s-light"] input { background: transparent !important; color: #2d1810 !important; border: 1px solid #2d1810 !important; border-radius: 0 !important; font-family: 'IBM Plex Mono', monospace !important; }
[data-theme="70s-light"] input::placeholder { color: #2d1810 !important; opacity: 0.4; }
[data-theme="70s-light"] .role-row .role-name { color: #6b1f0a !important; font-family: 'IBM Plex Mono', monospace !important; }
[data-theme="70s-light"] .role-row .role-url, [data-theme="70s-light"] .server-row .id, [data-theme="70s-light"] .show-hidden { color: #2d1810 !important; opacity: 0.55; }
[data-theme="70s-light"] .role-row:hover { background: rgba(45,24,16,0.06) !important; }
[data-theme="70s-light"] .role-divider { border-top-color: #2d1810 !important; opacity: 0.2; }
[data-theme="70s-light"] .footer a, [data-theme="70s-light"] .updated, [data-theme="70s-light"] .note, [data-theme="70s-light"] .mit { color: #2d1810 !important; opacity: 0.6; }
[data-theme="70s-light"] .copy-btn { background: transparent !important; color: #2d1810 !important; border: 1px solid #2d1810 !important; }
[data-theme="70s-light"] .copy-btn:hover { background: #2d1810 !important; color: #f4ecd8 !important; }
[data-theme="70s-light"] .claude-hint strong { color: #6b1f0a !important; }
[data-theme="70s-light"] .brand-name { color: #2d1810 !important; }

/* ============ CORPORATE THEME ============ */
[data-theme="corporate"] body {
  background: #ffffff !important;
  color: #374151 !important;
  font-family: 'Satoshi', 'Helvetica Neue', Arial, sans-serif !important;
}
[data-theme="corporate"] h1, [data-theme="corporate"] h2, [data-theme="corporate"] h3 { color: #1f2937 !important; font-weight: 600 !important; font-family: 'Clash Display', 'Helvetica Neue', sans-serif !important; }
[data-theme="corporate"] p, [data-theme="corporate"] li { color: #4b5563 !important; }
[data-theme="corporate"] .tagline { color: #6b7280 !important; font-weight: 400 !important; }
[data-theme="corporate"] a { color: #1e40af !important; }
[data-theme="corporate"] .card, [data-theme="corporate"] .features, [data-theme="corporate"] .info, [data-theme="corporate"] .claude-hint {
  background: #f9fafb !important;
  border: 1px solid #e5e7eb !important;
  border-radius: 4px !important;
  box-shadow: none !important;
  color: #374151 !important;
}
[data-theme="corporate"] pre, [data-theme="corporate"] code, [data-theme="corporate"] .copy-box { background: #f3f4f6 !important; color: #374151 !important; border: 1px solid #e5e7eb !important; }
[data-theme="corporate"] a.btn, [data-theme="corporate"] .btn-primary, [data-theme="corporate"] button.btn-primary { background: #1e40af !important; color: #ffffff !important; border: none !important; font-weight: 500 !important; box-shadow: none !important; }
[data-theme="corporate"] .btn-secondary { background: #e5e7eb !important; color: #374151 !important; }
[data-theme="corporate"] .btn-danger { background: #dc2626 !important; color: #fff !important; }
[data-theme="corporate"] input { background: #fff !important; color: #374151 !important; border: 1px solid #d1d5db !important; }
[data-theme="corporate"] .footer, [data-theme="corporate"] .footer a, [data-theme="corporate"] .updated, [data-theme="corporate"] .note, [data-theme="corporate"] .mit { color: #9ca3af !important; }
[data-theme="corporate"] .role-row .role-name { color: #1e40af !important; }

/* ============ Theme toggle widget ============
   IMPORTANT: every rule here is scoped under #theme-toggle and uses !important so
   that no theme override (e.g. [data-theme="70s-dark"] button {...}) can leak in
   and recolor the swatches. The swatch backgrounds are set via the CSS rules below
   (not inline styles), one rule per phosphor color, with high specificity. */
#theme-toggle { position: fixed !important; top: 12px !important; right: 12px !important; z-index: 9999 !important; display: flex !important; flex-direction: column !important; gap: 4px !important; align-items: flex-end !important; font-family: ui-monospace, 'Menlo', monospace !important; font-size: 10px !important; user-select: none !important; }
#theme-toggle .row { display: flex !important; gap: 3px !important; background: rgba(0,0,0,0.7) !important; backdrop-filter: blur(8px) !important; -webkit-backdrop-filter: blur(8px) !important; padding: 4px !important; border-radius: 6px !important; border: 1px solid rgba(255,255,255,0.15) !important; box-shadow: 0 4px 12px rgba(0,0,0,0.3) !important; }
#theme-toggle button { all: unset !important; cursor: pointer !important; padding: 4px 8px !important; border-radius: 3px !important; color: #d0d0d0 !important; font-size: 10px !important; font-family: ui-monospace, 'Menlo', monospace !important; text-transform: lowercase !important; letter-spacing: 0.5px !important; transition: background 0.15s !important; box-shadow: none !important; text-shadow: none !important; }
#theme-toggle button[data-theme-btn]:hover { background: rgba(255,255,255,0.1) !important; color: #fff !important; }
#theme-toggle button[data-theme-btn].active { background: rgba(255,255,255,0.18) !important; color: #fff !important; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.3) !important; }
#theme-toggle .swatch { width: 18px !important; height: 18px !important; padding: 0 !important; border-radius: 50% !important; border: 2px solid rgba(255,255,255,0.2) !important; box-shadow: none !important; }
#theme-toggle .swatch[data-phosphor-btn="green"] { background: #33ff33 !important; }
#theme-toggle .swatch[data-phosphor-btn="amber"] { background: #ffb000 !important; }
#theme-toggle .swatch[data-phosphor-btn="white"] { background: #f0f0f0 !important; }
#theme-toggle .swatch[data-phosphor-btn="cyan"]  { background: #00ffff !important; }
#theme-toggle .swatch[data-phosphor-btn="red"]   { background: #ff5050 !important; }
#theme-toggle .swatch.active { border-color: #fff !important; box-shadow: 0 0 0 1px #000, 0 0 6px rgba(255,255,255,0.6) !important; }
#theme-toggle #phosphor-row { display: none !important; }
html[data-theme="70s-light"] #theme-toggle #phosphor-row,
html[data-theme="70s-dark"] #theme-toggle #phosphor-row { display: flex !important; }
</style>
`;

const THEME_TOGGLE_HTML = `
<div id="theme-toggle">
  <div class="row">
    <button data-theme-btn="70s-light" title="70s Light">70s-L</button>
    <button data-theme-btn="70s-dark" title="70s Dark">70s-D</button>
    <button data-theme-btn="glass" title="Glass UI">glass</button>
    <button data-theme-btn="corporate" title="Plain Corporate">plain</button>
  </div>
  <div class="row" id="phosphor-row">
    <button class="swatch" data-phosphor-btn="green" title="Green" style="background:#33ff33"></button>
    <button class="swatch" data-phosphor-btn="amber" title="Amber" style="background:#ffb000"></button>
    <button class="swatch" data-phosphor-btn="white" title="White" style="background:#f0f0f0"></button>
    <button class="swatch" data-phosphor-btn="cyan" title="Cyan" style="background:#00ffff"></button>
    <button class="swatch" data-phosphor-btn="red" title="Red" style="background:#ff5050"></button>
  </div>
</div>
<script>
(function() {
  function syncActive() {
    var t = document.documentElement.getAttribute('data-theme');
    var p = document.documentElement.getAttribute('data-phosphor');
    document.querySelectorAll('[data-theme-btn]').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-theme-btn') === t);
    });
    document.querySelectorAll('[data-phosphor-btn]').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-phosphor-btn') === p);
    });
  }
  document.querySelectorAll('[data-theme-btn]').forEach(function(b) {
    b.addEventListener('click', function() {
      var t = b.getAttribute('data-theme-btn');
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('sg_theme', t);
      syncActive();
    });
  });
  document.querySelectorAll('[data-phosphor-btn]').forEach(function(b) {
    b.addEventListener('click', function() {
      var p = b.getAttribute('data-phosphor-btn');
      document.documentElement.setAttribute('data-phosphor', p);
      localStorage.setItem('sg_phosphor', p);
      syncActive();
    });
  });
  syncActive();
})();
</script>
`;

// --- Initialize ---

initDb(DB_PATH);

const app = new Hono<RelayEnv>();

// Inject environment bindings (mutate, don't replace — preserves WS upgrade symbol refs)
app.use("*", async (c, next) => {
  Object.assign(c.env, {
    GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET,
    PUBLIC_URL,
    SESSION_SECRET: process.env.SESSION_SECRET || "dev-secret",
  });
  await next();
});

// Standard security headers (HSTS, X-Frame-Options, Permissions-Policy, …) on
// every response. CSP and SRI are wired up separately — see Phase 8 steps A
// and B in ROADMAP.md. Per SECURITY.md, none of these stop a compromised
// origin from serving its own malicious bundle, but they harden every other
// attack class.
app.use("*", securityHeaders());

// CORS
app.use(
  "*",
  cors({
    origin: PUBLIC_URL,
    credentials: true,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// Rate limiting
app.use("/auth/*", rateLimit(20, 60_000)); // 20/min for auth
app.use("/api/*", rateLimit(100, 60_000)); // 100/min for API

// Auth middleware (sets user, doesn't reject)
app.use("*", authMiddleware());

// --- Routes ---

// Latest spaiglass install version. Read from RELEASE_DIR/VERSION on every
// request so a new release tarball can be dropped in without restarting the
// relay. Falls back to "unknown" if the file is missing.
function getLatestSpAIglassVersion(): string {
  try {
    return (
      readFileSync(pathJoin(RELEASE_DIR, "VERSION"), "utf-8").trim() ||
      "unknown"
    );
  } catch {
    return "unknown";
  }
}

// SHA-256 of RELAY_FRONTEND_DIR/index.html. Computed once at startup and
// cached — the bundle is immutable for the lifetime of a relay process, and
// re-hashing on every /api/health hit would be wasteful.
//
// This hash is the anchor for the "is the live relay serving the JavaScript I
// expect" check documented in SECURITY.md and README.md. Pair it with
// `gh release view <tag>` to verify the live relay matches a published,
// attested release.
//
// Returns "missing" if the bundle isn't deployed yet, "error" if the file
// exists but couldn't be read.
function computeFrontendBundleSha256(): string {
  try {
    if (!existsSync(RELAY_FRONTEND_DIR)) return "missing";
    const indexPath = pathJoin(RELAY_FRONTEND_DIR, "index.html");
    if (!existsSync(indexPath)) return "missing";
    const buf = readFileSync(indexPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return "error";
  }
}
const FRONTEND_BUNDLE_SHA256 = computeFrontendBundleSha256();

// Latest frontend bundle version. Distinct from spaiglassVersion (the install
// package version) so cosmetic frontend rolls — rsyncing a new dist into
// RELAY_FRONTEND_DIR — can advance independently without false-alarming the
// per-VM "out of date" dashboard banner, which is anchored to the install
// package.
//
// Read on every request so a frontend deploy doesn't require a relay restart.
// Source of truth, in order:
//   1. RELAY_FRONTEND_DIR/VERSION  (one-line text file written by the deploy
//      procedure — semver, human-readable)
//   2. First 12 chars of a freshly-hashed RELAY_FRONTEND_DIR/index.html
//      (always changes when the bundle changes; works without any deploy-side
//      coordination, and unlike FRONTEND_BUNDLE_SHA256 it is recomputed each
//      call so cosmetic deploys do not require a relay restart)
//   3. "unknown" if the bundle itself is missing
//
// Both the in-page version-skew toast and external observers consume this via
// /api/release.frontendVersion and /api/health.frontendVersion.
function getLatestFrontendVersion(): string {
  try {
    const versionPath = pathJoin(RELAY_FRONTEND_DIR, "VERSION");
    if (existsSync(versionPath)) {
      const v = readFileSync(versionPath, "utf-8").trim();
      if (v) return v;
    }
    const indexPath = pathJoin(RELAY_FRONTEND_DIR, "index.html");
    if (existsSync(indexPath)) {
      const buf = readFileSync(indexPath);
      return createHash("sha256").update(buf).digest("hex").slice(0, 12);
    }
  } catch {
    /* fall through */
  }
  return "unknown";
}

// Health check (before auth-required routes). Includes commit SHA and frontend
// bundle hash so external observers can verify the live relay is serving a
// known, attested release without needing relay credentials.
app.get("/api/health", (c) => {
  const cm = getChannelManager();
  const stats = cm.stats();
  return c.json({
    status: "ok",
    version: "0.1.0",
    commit: RELAY_COMMIT,
    frontend_sha256: FRONTEND_BUNDLE_SHA256,
    spaiglassVersion: getLatestSpAIglassVersion(),
    frontendVersion: getLatestFrontendVersion(),
    connectors: stats.connectors,
    browsers: stats.browsers,
  });
});

// Public release info — clients can poll this to see the latest available version
// without authenticating. Used by install.sh and could be used by /api/version on
// the VM side too. `version` is the install package (used by the per-VM stale
// banner); `frontendVersion` is the served bundle (used by the in-page skew
// toast). They move independently so cosmetic frontend rolls do not false-alarm
// the per-VM banner.
app.get("/api/release", (c) => {
  return c.json({
    version: getLatestSpAIglassVersion(),
    frontendVersion: getLatestFrontendVersion(),
    tarball: `${PUBLIC_URL}/dist.tar.gz`,
    install: `${PUBLIC_URL}/install.sh`,
  });
});

// Serve install.sh — `curl -fsSL https://spaiglass.xyz/install.sh | bash`
// Reads from RELEASE_DIR/install.sh. Cache-busted via mtime.
app.get("/install.sh", (c) => {
  const path = pathJoin(RELEASE_DIR, "install.sh");
  if (!existsSync(path)) return c.text("install.sh not yet published", 503);
  const body = readFileSync(path, "utf-8");
  c.header("Content-Type", "text/x-shellscript; charset=utf-8");
  c.header("Cache-Control", "no-cache");
  return c.body(body);
});

// Serve install.ps1 — `iwr https://spaiglass.xyz/install.ps1 -useb | iex`
// Same release dir; Windows installer counterpart to install.sh.
app.get("/install.ps1", (c) => {
  const path = pathJoin(RELEASE_DIR, "install.ps1");
  if (!existsSync(path)) return c.text("install.ps1 not yet published", 503);
  const body = readFileSync(path, "utf-8");
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Cache-Control", "no-cache");
  return c.body(body);
});

// Serve the latest frontend+backend bundle tarball.
// Streamed because it's a few MB. Pinned versions can be requested via
// /dist-<version>.tar.gz once we publish multiple releases (not yet implemented).
app.get("/dist.tar.gz", (c) => {
  const path = pathJoin(RELEASE_DIR, "dist.tar.gz");
  if (!existsSync(path)) return c.text("dist.tar.gz not yet published", 503);
  const stat = statSync(path);
  c.header("Content-Type", "application/gzip");
  c.header("Content-Length", String(stat.size));
  c.header("Cache-Control", "no-cache");
  c.header("X-SpAIglass-Version", getLatestSpAIglassVersion());
  // @ts-expect-error Hono accepts a Node Readable as the body
  return c.body(createReadStream(path));
});

// Phase 3: serve per-platform single-binary tarballs at
// /releases/spaiglass-host-<target>.tar.gz. The new install.sh / install.ps1
// download from here and drop the binary + static dir under ~/spaiglass.
// Allowed targets are pinned to the build matrix to prevent path traversal.
const PHASE3_TARGETS = new Set([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "windows-x64",
]);
app.get("/releases/:filename", (c) => {
  const filename = c.req.param("filename");
  if (!filename) return c.text("Missing filename", 400);
  // Expect "spaiglass-host-<target>.tar.gz" — validate against the pinned
  // target list to prevent path traversal or serving arbitrary files from
  // RELEASE_DIR.
  const match = filename.match(/^spaiglass-host-(.+)\.tar\.gz$/);
  if (!match) return c.text("Unknown release filename", 404);
  const target = match[1];
  if (!PHASE3_TARGETS.has(target)) {
    return c.text("Unknown target", 404);
  }
  const path = pathJoin(RELEASE_DIR, filename);
  if (!existsSync(path)) {
    return c.text(`${filename} not yet published`, 503);
  }
  const stat = statSync(path);
  c.header("Content-Type", "application/gzip");
  c.header("Content-Length", String(stat.size));
  c.header("Cache-Control", "no-cache");
  c.header("X-SpAIglass-Version", getLatestSpAIglassVersion());
  // @ts-expect-error Hono accepts a Node Readable as the body
  return c.body(createReadStream(path));
});

// --- Single-source setup content ---
// Both /setup (HTML) and /api/setup (JSON) render from this.
function getSetupData() {
  return {
    project: "SpAIglass",
    description:
      "Browser-based multi-VM interface for Claude Code. SpAIglass is a stateless relay that routes browser WebSocket connections to Claude Code running on your own machines.",
    license: "MIT",
    source: "https://github.com/c0inz/spaiglass",
    relay: PUBLIC_URL,
    supportedPlatforms: {
      hosts: [
        {
          os: "Linux",
          detail:
            "Ubuntu / Debian / Fedora / Arch — anything with bash, tar, node>=20. Installs as a systemd --user service with linger.",
        },
        {
          os: "macOS",
          detail:
            "macOS 12+ on Intel or Apple Silicon. Installs as a launchd LaunchAgent under ~/Library/LaunchAgents.",
        },
        {
          os: "Windows",
          detail:
            "Windows 10 build 17063+ / Windows 11. Installs as a per-user Scheduled Task that runs at logon (no admin needed).",
        },
      ],
      claudeCli:
        "Anthropic's Claude Code CLI must be installed and authenticated on the host before running the spaiglass installer. See https://claude.ai/install.sh (Linux/macOS) or https://claude.ai/install.ps1 (Windows).",
    },
    steps: [
      {
        title: "Get an agent key (two options)",
        description:
          'You need an <code>sg_...</code> agent key before you can register a VM. Pick whichever option fits how your human user is set up:<br><br><strong>Option A — You already have your user\'s GitHub PAT.</strong> Exchange it for an agent key via the API below. This is the fastest path when you (the agent) already have credentials. A <em>classic</em> PAT needs no scopes (the relay only calls <code>GET https://api.github.com/user</code>). A <em>fine-grained</em> PAT needs <strong>Account permissions → Read profile data</strong> — no repo scopes.<br><br><strong>Option B — Ask the human to retrieve a token.</strong> Tell the user: "Go to <a href="' +
          PUBLIC_URL +
          '">' +
          PUBLIC_URL +
          '</a> and sign in with GitHub. If you have no VMs registered yet, a one-shot token will appear in a copy-box — paste it back to me." That token is a real <code>sg_...</code> agent key minted for their session. Either option produces the same kind of key; use Option B whenever you do not already have a PAT and do not want to ask for one.',
        endpoint: `POST ${PUBLIC_URL}/api/auth/token-exchange`,
        body: '{ "github_pat": "ghp_YOUR_TOKEN", "key_name": "my-agent" }',
        note: "Save the agent key — it is shown only once. Treat it like a password. All subsequent steps set the header `Authorization: Bearer sg_YOUR_KEY`.",
      },
      {
        title: "Register a VM",
        description:
          'Register a new VM connector. The <code>name</code> is a short label for your reference (used as the URL slug the human will see later). You can register one VM, or one for each project you are setting up — the agent key is reusable across VMs.',
        endpoint: `POST ${PUBLIC_URL}/api/connectors`,
        body: '{ "name": "my-vm" }',
        note: "Requires `Authorization: Bearer sg_YOUR_KEY` header. The response returns `{ id, name, token, ... }` — save the token, it is shown ONCE and you'll feed it to the installer in the next step. You do NOT need to construct or remember a VM URL; sign-in handles routing for the human automatically.",
      },
      {
        title: "Install Claude Code CLI on the host",
        description:
          "SpAIglass spawns the official Anthropic Claude Code CLI to run sessions. It must be installed and authenticated before the spaiglass installer runs.",
        requirements: [
          "Node.js >= 20",
          "Claude Code CLI authenticated (claude --version should work)",
        ],
        commands: [
          "# Linux / macOS:",
          "curl -fsSL https://claude.ai/install.sh | bash",
          "claude  # one-time interactive auth",
          "",
          "# Windows (PowerShell):",
          "irm https://claude.ai/install.ps1 | iex",
          "claude  # one-time interactive auth",
        ],
        note: "SpAIglass looks for the binary at ~/.local/bin/claude on Linux/macOS and %USERPROFILE%\\.local\\bin\\claude.exe on Windows.",
      },
      {
        title: "Install spaiglass on the host (one liner)",
        description:
          'The installer downloads a self-contained binary tarball (~30 MB) from the relay, extracts it under <code>~/spaiglass</code>, writes the <code>.env</code>, and registers a per-user service that launches the backend + relay connector at boot/logon. <strong>Idempotent.</strong> Re-running upgrades in place and preserves the existing <code>.env</code> — if setup failed partway through, you (the agent) can re-run the exact same one-liner with the original <code>--token/--id/--name</code>, or without any flags to refresh from the saved <code>.env</code>.<br><br><strong>Linux gating decision — user lingering (requires sudo).</strong> On Linux, the <code>systemd --user</code> service only survives logout if lingering is enabled for the user, and enabling lingering is a root-only operation. Before running the installer, check whether passwordless sudo is available: <code>sudo -n loginctl enable-linger $USER</code>. If that succeeds silently, you are done — proceed to install. If it fails (prompts for a password or exits non-zero), <strong>stop and ask the human user to run it manually</strong> — without linger the service will die on logout and the VM will appear to "go offline" mysteriously. The installer itself hard-fails on Linux when linger is not set, so there is no way to sleepwalk past this. macOS and Windows have no linger requirement.',
        commands: [
          "# Linux preflight (ask the user to run if this errors):",
          "sudo -n loginctl enable-linger $USER",
          "",
          "# Linux / macOS install:",
          "curl -fsSL " + PUBLIC_URL + "/install.sh | bash -s -- \\",
          "    --token=YOUR_TOKEN --id=YOUR_ID --name=YOUR_VM_NAME",
          "",
          "# Windows (PowerShell — run as your normal user, no admin needed):",
          "& ([scriptblock]::Create((iwr " +
            PUBLIC_URL +
            "/install.ps1 -useb))) `",
          "    -Token YOUR_TOKEN -Id YOUR_ID -Name YOUR_VM_NAME",
        ],
        note: "Installs a systemd --user unit on Linux, a launchd LaunchAgent on macOS, and a per-user Scheduled Task on Windows. All three start automatically and restart on crash. No inbound ports are opened — the connector dials out over WSS to the relay. If the installer bails on the linger check, fix linger and re-run the same one-liner.",
      },
      {
        title: "Add one or more roles to projects",
        description:
          'Roles are the most important part of SpAIglass. A role file defines who Claude is, what plugins and tools it has, and how it should behave. SpAIglass uses Claude Code\'s native <code>.claude/agents/</code> directory — the same convention the CLI uses with <code>claude --agent &lt;name&gt;</code>. Each <code>.md</code> file becomes a selectable role in the SpAIglass chat view.<br><br><strong>Fastest path — use the register API.</strong> One POST to the VM\'s local backend does everything: creates the project directory, the role file, registers it in Claude\'s config, and creates the project metadata directory. <strong>See <a href="/add-project">Adding Projects &amp; Roles</a> for the endpoint reference.</strong><br><br><strong>Manual path (same result).</strong> If you prefer shell commands, the block below works. After creating the file, restart the spaiglass service (<code>systemctl --user restart spaiglass</code>) so the backend re-scans.<br><br><strong>Start from the baseline.</strong> A setup agent running on a fresh VM should not stop to hand-craft a role file — there is a canonical template at <a href="/roletemplate">/roletemplate</a> (raw: <a href="/roletemplate.md"><code>/roletemplate.md</code></a>). Drop it in, finish setup, and then <em>discuss with your human user how to improve the role.md to make SpAIglass more effective</em> during the first real session.',
        commands: [
          "# ── RECOMMENDED: one-shot register via API ──",
          "curl -s -X POST http://127.0.0.1:8080/api/projects/register \\",
          "  -H 'Content-Type: application/json' \\",
          "  -d '{\"name\": \"MyProject\", \"role\": \"developer\"}'",
          "",
          "# With custom role content:",
          "curl -s -X POST http://127.0.0.1:8080/api/projects/register \\",
          "  -H 'Content-Type: application/json' \\",
          "  -d '{\"name\": \"MyProject\", \"role\": \"developer\", \"roleContent\": \"You are the developer for MyProject...\"}'",
          "",
          "# ── Manual path (if you prefer shell commands) ──",
          "PROJECT=myproject",
          "ROLE=developer",
          "mkdir -p ~/projects/$PROJECT/.claude/agents",
          "curl -fsSL " + PUBLIC_URL + "/roletemplate.md \\",
          '  | sed "s/<PROJECT_NAME>/$PROJECT/g" \\',
          "  > ~/projects/$PROJECT/.claude/agents/$ROLE.md",
          "systemctl --user restart spaiglass  # re-scan projects",
        ],
        example: `${PUBLIC_URL}/vm/octocat.dev-server/myproject-developer/`,
        note: "SpAIglass also checks the legacy agents/ directory for backward compatibility. If the same filename exists in both .claude/agents/ and agents/, the .claude/agents/ version takes precedence. The canonical baseline template is at /roletemplate — use it whenever a setup agent would otherwise block on \"what should the role file say?\".",
        roleFrontmatterSchema: {
          description:
            "Role files use YAML frontmatter (between --- delimiters) to configure plugins, tools, MCP servers, and model settings. The markdown body below the frontmatter is injected into Claude's system prompt.",
          fields: [
            {
              name: "plugins",
              type: "object",
              description:
                'Enable/disable plugins for this role: <code>"plugin-name@marketplace": true/false</code>. SpAIglass writes these to an isolated settings.json via CLAUDE_CONFIG_DIR so roles don\'t conflict.',
            },
            {
              name: "mcpServers",
              type: "object",
              description:
                "MCP tool servers to register for this role's sessions. Same format as Claude Code's mcpServers config.",
            },
            {
              name: "tools",
              type: "string[]",
              description:
                "Allowlist of tools this role can use (e.g., Read, Write, Bash, mcp__github__*).",
            },
            {
              name: "disallowedTools",
              type: "string[]",
              description: "Tools to block for this role, even in bypass mode.",
            },
            {
              name: "model",
              type: "string",
              description:
                "Claude model override (e.g., claude-opus-4-6, claude-sonnet-4-6).",
            },
            {
              name: "permissionMode",
              type: "string",
              description:
                "Permission mode override (bypassPermissions is the default in SpAIglass).",
            },
            {
              name: "maxTurns",
              type: "number",
              description: "Max conversation turns before the session stops.",
            },
            {
              name: "effort",
              type: "string",
              description: "Thinking effort level (low, medium, high).",
            },
          ],
          example: `---
plugins:
  superpowers@claude-plugins-official: true
  code-review@claude-plugins-official: true
  frontend-design@claude-plugins-official: false
mcpServers:
  github:
    command: npx
    args:
      - -y
      - "@anthropic-ai/mcp-server-github"
tools:
  - Read
  - Write
  - Edit
  - Bash
  - mcp__github__*
model: claude-opus-4-6
---
# MyProject — Backend Developer

You are the lead backend engineer...`,
        },
        roleConfigDir: {
          title: "Per-role plugin isolation (CLAUDE_CONFIG_DIR)",
          description:
            "SpAIglass creates a separate config directory for each role at <code>.claude/agent-configs/&lt;role&gt;/</code>. When a session starts, SpAIglass sets <code>CLAUDE_CONFIG_DIR</code> to this directory and writes the role's <code>enabledPlugins</code> from the frontmatter into its <code>settings.json</code>. This means a developer role and a QA role on the same project can have completely different plugins active without clobbering each other — even if sessions run concurrently. Auth credentials are symlinked from the real <code>~/.claude/</code> so sessions authenticate normally.",
        },
        roleChecklist: [
          {
            section: "Identity (put first)",
            description:
              'Who is Claude in this role? "You are the lead backend engineer for ProjectX." One strong sentence at the very top. Models attend most to the beginning and end of instructions — put identity and hard rules at those positions.',
          },
          {
            section: "Project location",
            description:
              "Where is the code? ~/projects/myproject/ — Claude needs this to find files without asking.",
          },
          {
            section: "Architecture / tech stack",
            description:
              "What's the stack? What are the key directories? Use tables — a table of 10 directories with one-line descriptions beats two paragraphs of prose. Only list things Claude can't figure out by reading the code.",
          },
          {
            section: "How things connect",
            description:
              "How do the pieces connect? How do messages flow? How is it deployed? Write this like a day-one briefing for a new developer, not a reference manual.",
          },
          {
            section: "Verification commands",
            description:
              "How does Claude check its own work? Provide the exact commands: build, test, lint, deploy-check. This is the single highest-leverage section — without it, you become the only feedback loop.",
          },
          {
            section: "Authority & access",
            description:
              "What can Claude do? sudo, git push, SSH to other machines, credentials, databases. If Claude doesn't know it has access, it won't use it. List credential file paths explicitly.",
          },
          {
            section: "Conventions",
            description:
              'Commit message style, branch strategy, test expectations, naming conventions. Only include rules that differ from defaults — don\'t tell Claude to "write clean code."',
          },
          {
            section: "Compaction instructions",
            description:
              'What must be preserved when Claude\'s context window compresses during long sessions? "Always preserve: modified file list, pending deploys, current task, verification commands." Without this, long sessions lose critical state.',
          },
          {
            section: "Hard rules (put last)",
            description:
              'What must Claude NEVER do? Use absolute language (NEVER, MUST NOT) and explain WHY for each rule. "Never force-push to main — other sessions depend on linear history." Rules with rationale are followed more reliably than bare commands.',
          },
        ],
        roleAntiPatterns: [
          'Flattery ("you are an EXTREMELY TALENTED genius engineer") — does nothing measurable, wastes tokens',
          'Step-by-step scripts — contradicts autonomous agent behavior. State what "done" looks like, not how to get there',
          "Knowledge dumps — don't paste API docs or file-by-file descriptions. Link to them or let Claude read the code",
          "Linter rules — use actual linters and hooks for formatting, not prose instructions Claude might forget",
          'Repeating what Claude already knows — standard language conventions, obvious best practices, "write tests"',
          "Over 200 lines — bloated role files cause Claude to skim or ignore your actual instructions",
        ],
        roleExample: `---
plugins:
  superpowers@claude-plugins-official: true
  code-review@claude-plugins-official: true
model: claude-opus-4-6
---
IMPORTANT: You are the lead backend engineer for MyProject, a SaaS API platform. You are a senior engineer with root access. Execute, don't narrate.

## Who you are
- You own the backend: API, database, deployment pipeline
- The human is technical and direct — report results, not intentions
- When something breaks, diagnose the root cause. Don't retry blindly

## Project
~/projects/myproject/ — GitHub: github.com/acme/myproject (main)

## Architecture
| Layer | Stack |
|-------|-------|
| API | Node.js 20, Express, TypeScript |
| Database | PostgreSQL 16 on db.internal:5432 |
| Cache | Redis on cache.internal:6379 |
| Deployment | Docker Compose via \`./scripts/deploy.sh\` |

## Key directories
| Path | What's there |
|------|-------------|
| src/routes/ | API route handlers |
| src/models/ | Database models (Drizzle ORM) |
| src/middleware/ | Auth, rate limiting, logging |
| tests/ | Vitest test suite |
| scripts/ | Deploy, migrate, seed scripts |

## Verification — check your work
| What | Command |
|------|---------|
| Types compile | \`npx tsc --noEmit\` |
| Tests pass | \`npm test\` |
| Lint clean | \`npm run lint\` |
| DB migrations | \`npm run migrate:status\` |

ALWAYS run the relevant checks before declaring done.

## Access & credentials
- \`~/credentials/db.json\` — PostgreSQL connection string
- \`~/credentials/github.json\` — PAT (git push works via credential helper)
- SSH to db.internal and cache.internal via ~/.ssh/config
- Passwordless sudo on this machine

## Conventions
- Commit messages: imperative mood ("Add user endpoint", not "Added")
- PRs target main, squash-merge only
- Migrations in src/migrations/ — never edit a shipped migration

## When context compacts
Preserve: list of modified files, pending deploys, current task, test results.

## IMPORTANT — Hard rules
- NEVER commit anything from ~/credentials/. Why: live tokens would be exposed in git history.
- NEVER force-push to main. Why: CI and other developers depend on linear history.
- NEVER drop a production table without explicit instruction. Why: data loss is irreversible.`,
      },
      {
        title: "Add architecture.json (optional)",
        description:
          "The Arch button in the chat view shows an ASCII architecture diagram for the current project. It reads from architecture/architecture.json inside the project directory.",
        commands: ["mkdir -p ~/projects/myproject/architecture"],
        example: JSON.stringify(
          {
            project: {
              name: "MyProject",
              summary: "Brief description of what this project does",
            },
            components: [
              {
                id: "api",
                name: "API Server",
                type: "service",
                runsOn: ["vm1"],
                status: "active",
              },
              {
                id: "db",
                name: "Database",
                type: "datastore",
                runsOn: ["vm1"],
              },
            ],
            connections: [{ from: "api", to: "db", purpose: "queries" }],
            infrastructure: [{ id: "vm1", name: "Production VM", type: "vm" }],
            architectureRules: ["All traffic must go through the API gateway"],
          },
          null,
          2,
        ),
        note: "Save the JSON above as ~/projects/myproject/architecture/architecture.json. The Arch button in the chat UI reads this file and renders it as an ASCII diagram. Without this file, the Arch button shows a link to this setup guide.",
      },
    ],
    addMoreVms:
      "The agent key is reusable. To add another VM, repeat steps 2-4 with the same key — each VM gets its own connector token. Mix and match Linux, macOS, and Windows hosts under the same account.",
    shortcut:
      "If you already have a token/id/name from a previous registration, skip straight to the install step.",
    finalStep: {
      title: "Tell the human user you're done",
      description:
        "Once the service is running and at least one role file exists, setup is finished. Report success to your human user and tell them: \"Setup complete. Go to " +
        PUBLIC_URL +
        " and sign in with GitHub — you'll land directly in your chat.\" They do not need a URL, a VM name, or a role name; sign-in routes them to the right place automatically. Do not construct or share <code>/vm/&lt;login&gt;.&lt;vm&gt;/</code> URLs — that detail is now internal. If something failed partway through, say so plainly and tell the user what you need from them (typically: `sudo loginctl enable-linger $USER`, then re-run the install one-liner).",
    },
    features: [
      "Chat with Claude Code from any browser — laptop, phone, tablet",
      "Project file browser — see and edit your files while you chat",
      "Markdown editor — Monaco-powered, syntax highlighted, Ctrl+S to save",
      "Six themes including 70s amber/green CRT phosphor + corporate plain",
      "Role-based sessions — define agent roles per project via .claude/agents/*.md files — per-role plugin isolation via CLAUDE_CONFIG_DIR",
      "Architecture viewer — ASCII diagrams from architecture.json",
      "Multi-VM fleet management — one dashboard for all your machines, across Linux/macOS/Windows",
      "Frontend served by the relay — your VMs only ship the backend; UI updates ship without VM redeploys",
      "Version-skew banner — the dashboard tells you when a VM is running an older spaiglass build than the relay",
    ],
    security: {
      summary:
        "Open source, risk-avoidance architecture, fully auditable, full encryption",
      details: [
        "Open source — MIT licensed, every line auditable on GitHub",
        "Risk-avoidance architecture — the relay routes traffic, never stores code, conversations, or files",
        "Full encryption — all relay traffic is TLS-encrypted end to end (HTTPS/WSS)",
        "Fully auditable — relay is ~800 lines of TypeScript with minimal dependencies",
        "Outbound-only — VMs connect out to the relay, no inbound ports or firewall holes needed",
        "Your data stays on your machine — Claude Code runs locally, project files never leave the VM",
      ],
    },
  };
}

// ── Adding Projects & Roles — standalone reference page ──
// Linked from /setup step 5 and from setup agents. This is THE document an
// uninformed agent reads to register a project. Keep it dead simple.
app.get("/add-project", (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><title>Adding Projects &amp; Roles — SpAIglass</title>
${FAVICON}
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1a1a2e;background:#f0f0f5;line-height:1.6}
h1{color:#1a1a2e;border-bottom:2px solid #6366f1;padding-bottom:8px}
h2{color:#4338ca;margin-top:2em}
code{background:#e4e4ec;padding:2px 6px;border-radius:4px;font-size:0.9em}
pre{background:#1e1e2e;color:#cdd6f4;padding:16px;border-radius:8px;overflow-x:auto;font-size:0.85em;line-height:1.5}
.endpoint{background:#1e293b;color:#38bdf8;padding:12px 16px;border-radius:8px;font-family:monospace;font-size:0.95em;margin:12px 0}
.field{margin:6px 0;padding-left:16px}
.field strong{color:#4338ca}
.note{background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0}
table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{text-align:left;padding:8px 12px;border:1px solid #cbd5e1}
th{background:#e2e8f0}
a{color:#4338ca}
</style>
</head><body>
<h1>Adding Projects &amp; Roles</h1>

<p><strong>One API call</strong> creates everything needed for a project to appear in the SpAIglass dropdown. No manual file creation, no config editing, no service restart.</p>

<h2>Register Endpoint</h2>

<div class="endpoint">POST http://127.0.0.1:8080/api/projects/register</div>

<p>This runs on the <strong>VM's local backend</strong> (port 8080), not the relay.</p>

<h2>Request Body (JSON)</h2>

<table>
<tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr>
<tr><td><code>name</code></td><td>string</td><td>yes</td><td>Project directory name. Alphanumeric, hyphens, underscores, dots. Example: <code>BHMarketing</code></td></tr>
<tr><td><code>role</code></td><td>string</td><td>yes</td><td>Role filename (without .md). Example: <code>developer</code></td></tr>
<tr><td><code>roleContent</code></td><td>string</td><td>no</td><td>Markdown content for the role file. If omitted, a default template is written.</td></tr>
</table>

<h2>What It Does</h2>
<ol>
<li>Creates <code>~/projects/{name}/</code></li>
<li>Creates <code>~/projects/{name}/.claude/agents/{role}.md</code></li>
<li>Registers the project in <code>~/.claude.json</code></li>
<li>Creates <code>~/.claude/projects/{encoded-name}/</code></li>
</ol>
<p>The project appears in the dropdown <strong>immediately</strong> — no restart needed.</p>

<h2>Examples</h2>

<p><strong>Minimal — default role template:</strong></p>
<pre>curl -s -X POST http://127.0.0.1:8080/api/projects/register \\
  -H 'Content-Type: application/json' \\
  -d '{"name": "BHMarketing", "role": "developer"}'</pre>

<p><strong>With custom role content:</strong></p>
<pre>curl -s -X POST http://127.0.0.1:8080/api/projects/register \\
  -H 'Content-Type: application/json' \\
  -d '{
  "name": "BHMarketing",
  "role": "developer",
  "roleContent": "You are the developer for BHMarketing.\\n\\n## Project Location\\n~/projects/BHMarketing/\\n\\n## Tech Stack\\n- Node.js / TypeScript\\n- PostgreSQL"
}'</pre>

<p><strong>Add a second role to the same project:</strong></p>
<pre>curl -s -X POST http://127.0.0.1:8080/api/projects/register \\
  -H 'Content-Type: application/json' \\
  -d '{"name": "BHMarketing", "role": "qa-lead"}'</pre>

<h2>Response</h2>
<pre>{
  "ok": true,
  "project": "BHMarketing",
  "role": "developer",
  "roleFile": "/home/readystack/projects/BHMarketing/.claude/agents/developer.md",
  "projectDir": "/home/readystack/projects/BHMarketing"
}</pre>

<div class="note">
<strong>Idempotent.</strong> Calling again with the same name/role overwrites the role file but doesn't break anything else. Safe to retry.
</div>

<h2>For a richer role file</h2>
<p>The default template is bare-minimum. For a real role file, use the <a href="/roletemplate">role template</a> as a starting point, or see the <a href="/setup">full setup guide</a> for the frontmatter schema, checklist, and examples.</p>

<p style="margin-top:2em;color:#64748b;font-size:0.85em">
<a href="/setup">← Back to full setup guide</a>
</p>
</body></html>`);
});

// Raw role template — curl target for setup agents
//   curl -fsSL https://spaiglass.xyz/roletemplate.md \
//     | sed "s/<PROJECT_NAME>/TrendZion/g" \
//     > ~/projects/TrendZion/.claude/agents/developer.md
app.get("/roletemplate.md", (c) => {
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Cache-Control", "public, max-age=300");
  return c.body(ROLE_TEMPLATE_MD);
});

// Role template page — HTML view of the canonical baseline role file.
// Linked from /setup step "Add a role to a project".
app.get("/roletemplate", (c) => {
  // HTML-escape the template body for <pre> display.
  const escaped = ROLE_TEMPLATE_MD
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return c.html(`<!DOCTYPE html>
<html><head><title>Role Template — SpAIglass</title>
${FAVICON}
${THEME_HEAD}
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1a1a2e; background: #f0f0f5; line-height: 1.55; }
  h1 { font-size: 1.8em; }
  h2 { margin-top: 28px; font-size: 1.2em; }
  .card { background: white; border-radius: 8px; padding: 16px 20px; margin: 12px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  pre { background: #1e293b; color: #e2e8f0; padding: 14px 18px; border-radius: 6px; overflow-x: auto; font-size: 0.85em; white-space: pre-wrap; }
  code { background: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  .note { font-size: 0.9em; color: #475569; }
  .info { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 16px; margin: 12px 0; font-size: 0.9em; }
  .subtitle { color: #666; }
  a { color: #3b82f6; }
  .nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
</style>
</head><body>
${THEME_TOGGLE_HTML}
<div class="nav">
  <a href="/setup">&larr; Setup guide</a>
  <a href="/">Home</a>
</div>
<h1>Canonical Role Template</h1>
<p class="subtitle">A minimal, working <code>.claude/agents/&lt;role&gt;.md</code> baseline. Don't stop to perfect it — drop it in, start the session, then iterate.</p>

<div class="info">
  <strong>This is a baseline, not a finished role file.</strong> It exists so a setup agent never has to stop and ask "what should I write?" Once the session is live, discuss with your LLM user how to strengthen it — see the <a href="/setup#role">checklist and anti-patterns</a> on the setup guide for where to go next.
</div>

<h2>The template</h2>
<pre>${escaped}</pre>

<h2>How to use it</h2>
<p>Replace <code>&lt;PROJECT_NAME&gt;</code> with your actual project name and save it to <code>~/projects/&lt;PROJECT_NAME&gt;/.claude/agents/&lt;role&gt;.md</code>. The setup agent on a fresh VM can do this in one command:</p>
<pre>PROJECT=TrendZion
ROLE=developer
mkdir -p ~/projects/$PROJECT/.claude/agents
curl -fsSL ${PUBLIC_URL}/roletemplate.md \\
  | sed "s/&lt;PROJECT_NAME&gt;/$PROJECT/g" \\
  &gt; ~/projects/$PROJECT/.claude/agents/$ROLE.md</pre>

<h2>What to add after the session is alive</h2>
<p class="note">The baseline gives you an identity line, a project dir, verification discipline, and hard rules. The setup guide's <a href="/setup">role checklist</a> covers the higher-leverage additions:</p>
<ul>
  <li><strong>Architecture / tech stack table</strong> — only list what Claude can't figure out by reading the code</li>
  <li><strong>Key directories table</strong> — beats two paragraphs of prose</li>
  <li><strong>Verification commands</strong> — exact build / test / lint / deploy-check commands (highest-leverage section)</li>
  <li><strong>Access &amp; credentials paths</strong> — list <code>~/credentials/*.json</code> files explicitly; if Claude doesn't know it has access, it won't use it</li>
  <li><strong>Conventions</strong> — commit message style, branch strategy, naming rules <em>that differ from defaults</em></li>
  <li><strong>Per-project hard rules</strong> — absolute language (NEVER, MUST NOT) with <em>a reason</em> for each rule, because rules with rationale are followed more reliably</li>
</ul>
<p class="note">Avoid: flattery, step-by-step scripts, knowledge dumps, repeating what Claude already knows, or going over ~200 lines.</p>

<h2>Related</h2>
<ul>
  <li><a href="/roletemplate.md">Raw <code>roletemplate.md</code></a> (for curl)</li>
  <li><a href="/setup">Full setup guide</a> — frontmatter schema, full checklist, example role file</li>
  <li><a href="https://agents.md">AGENTS.md convention</a> — this template is also compatible with the cross-tool <code>AGENTS.md</code> standard; the same content works at the repo root for any agent that reads it</li>
</ul>

<p style="margin-top: 24px;"><a href="/setup">&larr; Back to Setup</a></p>
</body></html>`);
});

// Setup page — HTML for browsers
app.get("/setup", (c) => {
  const data = getSetupData();
  const stepsHtml = data.steps
    .map((s, i) => {
      const roleFrontmatterHtml = s.roleFrontmatterSchema
        ? `
      <h4 style="margin: 16px 0 8px; font-size: 1em;">Frontmatter schema (YAML between --- delimiters):</h4>
      <p style="font-size: 0.9em; color: #475569; margin: 4px 0 8px;">${s.roleFrontmatterSchema.description}</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 0.9em; margin: 8px 0 12px;">
        <thead><tr style="border-bottom: 2px solid #e2e8f0; text-align: left;">
          <th style="padding: 6px 12px; width: 20%;">Field</th>
          <th style="padding: 6px 12px; width: 15%;">Type</th>
          <th style="padding: 6px 12px;">Description</th>
        </tr></thead>
        <tbody>${s.roleFrontmatterSchema.fields
          .map(
            (f: { name: string; type: string; description: string }) => `
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 6px 12px; font-family: monospace; font-weight: 600; vertical-align: top;">${f.name}</td>
            <td style="padding: 6px 12px; font-family: monospace; font-size: 0.85em; color: #64748b; vertical-align: top;">${f.type}</td>
            <td style="padding: 6px 12px; color: #475569;">${f.description}</td>
          </tr>`,
          )
          .join("")}
        </tbody>
      </table>
      <details style="margin: 8px 0 16px;">
        <summary style="cursor: pointer; font-weight: 600; color: #3b82f6; font-size: 0.9em;">Frontmatter example</summary>
        <pre style="margin-top: 8px;">${s.roleFrontmatterSchema.example}</pre>
      </details>`
        : "";
      const roleConfigDirHtml = s.roleConfigDir
        ? `
      <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 16px; margin: 12px 0;">
        <strong>${s.roleConfigDir.title}</strong>
        <p style="margin: 8px 0 0; font-size: 0.9em; color: #1e40af;">${s.roleConfigDir.description}</p>
      </div>`
        : "";
      const roleChecklistHtml = s.roleChecklist
        ? `
      <h4 style="margin: 16px 0 8px; font-size: 1em;">What to include in a role file:</h4>
      <table style="width: 100%; border-collapse: collapse; font-size: 0.9em; margin: 8px 0 16px;">
        <thead><tr style="border-bottom: 2px solid #e2e8f0; text-align: left;">
          <th style="padding: 6px 12px; width: 25%;">Section</th>
          <th style="padding: 6px 12px;">Why it matters</th>
        </tr></thead>
        <tbody>${s.roleChecklist
          .map(
            (r: { section: string; description: string }) => `
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 6px 12px; font-weight: 600; vertical-align: top;">${r.section}</td>
            <td style="padding: 6px 12px; color: #475569;">${r.description}</td>
          </tr>`,
          )
          .join("")}
        </tbody>
      </table>`
        : "";
      const roleAntiPatternsHtml = s.roleAntiPatterns
        ? `
      <h4 style="margin: 16px 0 8px; font-size: 1em; color: #dc2626;">Common mistakes that make agents worse:</h4>
      <ul style="margin: 4px 0 16px; padding-left: 20px; font-size: 0.9em; color: #475569; line-height: 1.7;">
        ${s.roleAntiPatterns.map((p: string) => `<li>${p}</li>`).join("")}
      </ul>`
        : "";
      const roleExampleHtml = s.roleExample
        ? `
      <details style="margin: 12px 0;">
        <summary style="cursor: pointer; font-weight: 600; color: #3b82f6; font-size: 0.95em;">Example role file (click to expand)</summary>
        <pre style="margin-top: 8px;">${s.roleExample}</pre>
      </details>`
        : "";
      return `
    <div class="card">
      <h3>${i + 1}. ${s.title}</h3>
      <p>${s.description}</p>
      ${s.endpoint ? `<code class="block">${s.endpoint}</code>` : ""}
      ${s.body ? `<pre>${s.body}</pre>` : ""}
      ${s.requirements ? `<p><strong>Requirements:</strong> ${s.requirements.join(", ")}</p>` : ""}
      ${s.commands ? `<pre>${s.commands.join("\n")}</pre>` : ""}
      ${s.example ? (s.example.includes("\n") ? `<p>Example:</p><pre>${s.example}</pre>` : `<p>Example: <code>${s.example}</code></p>`) : ""}
      ${roleFrontmatterHtml}
      ${roleConfigDirHtml}
      ${roleChecklistHtml}
      ${roleAntiPatternsHtml}
      ${roleExampleHtml}
      ${s.note ? `<p class="note">${s.note}</p>` : ""}
    </div>`;
    })
    .join("");

  return c.html(`<!DOCTYPE html>
<html><head><title>Setup — SpAIglass</title>
${FAVICON}
${THEME_HEAD}
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1a1a2e; background: #f0f0f5; }
  h1 { font-size: 1.8em; }
  h2 { margin-top: 32px; }
  h3 { margin: 0 0 8px; }
  .card { background: white; border-radius: 8px; padding: 16px 20px; margin: 12px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  pre { background: #1e293b; color: #e2e8f0; padding: 12px 16px; border-radius: 6px; overflow-x: auto; font-size: 0.85em; white-space: pre-wrap; }
  code { background: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  code.block { display: block; background: #e2e8f0; padding: 8px 12px; border-radius: 6px; margin: 8px 0; }
  .note { font-size: 0.9em; color: #666; margin-top: 8px; }
  .subtitle { color: #666; }
  a { color: #3b82f6; }
  .info { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 16px; margin: 12px 0; font-size: 0.9em; }
  .features { background: white; border-radius: 8px; padding: 20px 24px; margin: 16px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .features h2 { margin-top: 0; font-size: 1.3em; }
  .features ul { margin: 8px 0; padding-left: 20px; line-height: 1.7; }
  .features li { margin: 4px 0; }
  .nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .nav a { font-size: 0.95em; }
</style>
</head><body>
${THEME_TOGGLE_HTML}
<div class="nav">
  <a href="/">&larr; Home</a>
  <a href="https://github.com/c0inz/spaiglass">GitHub</a>
</div>
<h1>SpAIglass Setup Guide</h1>
<p class="subtitle">${data.description}</p>

<div class="card" style="border-left: 4px solid #3b82f6; background: #eff6ff;">
  <h3 style="margin-top: 0;">Reading this as an agent?</h3>
  <p style="margin: 8px 0;">If parsing this HTML is awkward, fetch <a href="/api/setup"><code>${PUBLIC_URL}/api/setup</code></a> instead — exact same content, structured JSON, no CSS/markup noise. Both endpoints stay in sync (they're rendered from one source).</p>
  <p style="margin: 8px 0 0; font-size: 0.9em; color: #475569;">Use whichever format is easier for your tools. The numbered steps, decision trees, and final instructions are identical.</p>
</div>

<div class="features">
  <h2>Supported Platforms</h2>
  <p style="margin: 4px 0 10px; font-size: 0.92em; color: #475569;">SpAIglass runs anywhere the Anthropic Claude Code CLI runs. Mix and match in the same fleet.</p>
  <ul>
    <li><strong>Linux</strong> — Ubuntu, Debian, Fedora, Arch, etc. Installs as a <code>systemd --user</code> service with linger so it survives logout.</li>
    <li><strong>macOS</strong> 12+ (Intel or Apple Silicon) — installs as a launchd LaunchAgent under <code>~/Library/LaunchAgents</code>.</li>
    <li><strong>Windows</strong> 10 (build 17063+) and 11 — installs as a per-user Scheduled Task that runs at logon, no admin required.</li>
  </ul>
  <p style="margin: 10px 0 0; font-size: 0.88em; color: #64748b;">Install the official Anthropic Claude Code CLI first (<a href="https://claude.ai">claude.ai</a>), then run the spaiglass installer for your platform.</p>

  <h2>What You Get</h2>
  <ul>
    <li><strong>Chat with Claude Code</strong> from any browser — laptop, phone, tablet</li>
    <li><strong>Project file browser</strong> — see and edit your files while you chat</li>
    <li><strong>Markdown editor</strong> — Monaco-powered, syntax highlighted, Ctrl+S to save</li>
    <li><strong>Six themes</strong> including 70s amber/green CRT phosphor and corporate plain</li>
    <li><strong>Role-based sessions</strong> — define agent roles per project via .claude/agents/*.md files — per-role plugin isolation via CLAUDE_CONFIG_DIR</li>
    <li><strong>Architecture viewer</strong> — ASCII diagrams from architecture.json</li>
    <li><strong>Multi-VM fleet management</strong> — one dashboard for all your machines, across Linux/macOS/Windows</li>
    <li><strong>Frontend served by the relay</strong> — your VMs ship only the backend, so UI updates roll out without redeploying every VM</li>
    <li><strong>Version-skew banner</strong> — the dashboard warns when a VM is running an older build than the relay</li>
  </ul>
  <h2>Security &amp; Trust</h2>
  <ul>
    <li><strong>Open source</strong> — MIT licensed, every line auditable on <a href="https://github.com/c0inz/spaiglass">GitHub</a></li>
    <li><strong>Risk-avoidance architecture</strong> — the relay routes traffic, it never stores your code, conversations, or files</li>
    <li><strong>Full encryption</strong> — all relay traffic is TLS-encrypted end to end (HTTPS/WSS)</li>
    <li><strong>Fully auditable</strong> — relay source is ~800 lines of TypeScript, no dependencies beyond Hono and SQLite</li>
    <li><strong>Outbound-only</strong> — VMs connect out to the relay, no inbound ports or firewall holes needed</li>
    <li><strong>Your data stays on your machine</strong> — the relay stores only GitHub identity and connector tokens</li>
  </ul>
</div>

<div class="info">
  <strong>Shortcut:</strong> ${data.shortcut}
</div>
<div class="info">
  <strong>Adding more VMs:</strong> ${data.addMoreVms}
</div>

${stepsHtml}

<div class="card" style="border-left: 4px solid #22c55e;">
  <h3>${data.steps.length + 1}. ${data.finalStep.title}</h3>
  <p>${data.finalStep.description}</p>
</div>

<div class="card" style="border-left: 4px solid #f59e0b; background: #fffbeb;">
  <h3 style="margin-top: 0;">Architecture Manifest (required for every project)</h3>
  <p>Every project registered through this setup produces one file: <code>architecture/architecture.json</code>. That single file is the <strong>operational snapshot</strong> of what the project is doing &mdash; a human coming back after months away should be able to open it and rebuild full mental context without touching the code.</p>
  <p><strong>This is not a breadcrumb diagram.</strong> Shallow architecture files are worse than none: they create the illusion of documentation while hiding the risks they should be surfacing. A manifest that doesn&rsquo;t list orphaned routes won&rsquo;t help you find the 2024 signup form still live at <code>/old-signup</code>. A manifest that doesn&rsquo;t list database schemas and their row counts won&rsquo;t help you notice the tenant that stopped getting writes three weeks ago. A manifest that doesn&rsquo;t list unauthenticated endpoints can&rsquo;t be used as a security baseline.</p>
  <p style="font-size: 1.05em; font-weight: 600; margin: 16px 0 8px;"><strong>Full instructions &mdash; and they are long by design &mdash; are at:</strong></p>
  <p style="font-size: 1.1em; margin: 4px 0 16px;">&rarr; <a href="/architecture-manual"><code>${PUBLIC_URL}/architecture-manual</code></a></p>
  <p style="font-size: 0.9em; color: #475569;">Read the whole thing before you write a single field. The manual covers: the sourcing rules (never use docs as source-of-truth), the JSON schema, the site-map requirements (every route, every form, every orphan), the database-layer requirements (schemas, tables, grants, row counts), the security surface (unauthenticated endpoints, exceptions with rationale, open CVEs), and the ASCII-art rendering conventions the SpAIglass viewer uses.</p>
  <p style="font-size: 0.9em; color: #475569;">The manual includes a self-check list at the end. An <code>architecture.json</code> that fails any of the checks is <strong>not done</strong>.</p>
  <p style="font-size: 0.88em; color: #92400e; margin-top: 12px;"><strong>&#9888; Agent directive:</strong> do not produce a partial manifest. If you cannot verify a field (a process is unreachable, a database rejects your connection, a repo is unreadable), write <code>"unknown"</code> with a <code>statusSource</code> explaining why. An honest unknown is the correct output when the ground truth can&rsquo;t be observed.</p>
</div>

<h2>Machine-readable</h2>
<p>Agents and scripts can fetch <a href="/api/setup"><code>/api/setup</code></a> for the same content as JSON.</p>
<p style="margin-top: 24px;"><a href="/">&larr; Back to Home</a></p>
</body></html>`);
});

// Setup JSON endpoint (machine-readable for agents)
app.get("/api/setup", (c) => {
  const user = c.get("user");
  const data = getSetupData();
  return c.json({
    ...data,
    authenticated: !!user,
    user: user ? { login: user.github_login } : null,
  });
});

// Architecture manual — the generation spec for architecture.json.
// Source markdown lives in ARCHITECTURE_DIR/MANUAL.md + MANUAL-REFERENCE.md,
// deployed alongside the relay. Rendered to HTML at request time via `marked`.
// The /api/ endpoint returns raw markdown for agents.
function readManualMarkdown(): { core: string; reference: string } | null {
  const corePath = pathJoin(ARCHITECTURE_DIR, "MANUAL.md");
  const refPath = pathJoin(ARCHITECTURE_DIR, "MANUAL-REFERENCE.md");
  if (!existsSync(corePath)) return null;
  return {
    core: readFileSync(corePath, "utf-8"),
    reference: existsSync(refPath) ? readFileSync(refPath, "utf-8") : "",
  };
}

app.get("/architecture-manual", (c) => {
  const md = readManualMarkdown();
  if (!md) {
    return c.html(
      `<html><body><h1>Not found</h1><p>Architecture manual not deployed yet.</p></body></html>`,
      404,
    );
  }

  const coreHtml = marked.parse(md.core) as string;
  const referenceHtml = md.reference
    ? (marked.parse(md.reference) as string)
    : "";

  return c.html(`<!DOCTYPE html>
<html><head><title>Architecture Manual — SpAIglass</title>
${FAVICON}
${THEME_HEAD}
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui; max-width: 860px; margin: 40px auto; padding: 0 20px; color: #1a1a2e; background: #f0f0f5; line-height: 1.7; }
  h1 { font-size: 1.8em; margin-bottom: 4px; }
  h2 { margin-top: 32px; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; }
  h3 { margin-top: 24px; }
  pre { background: #1e293b; color: #e2e8f0; padding: 14px 18px; border-radius: 6px; overflow-x: auto; font-size: 0.85em; white-space: pre-wrap; }
  code { background: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #3b82f6; margin: 12px 0; padding: 8px 16px; background: #eff6ff; border-radius: 0 8px 8px 0; color: #1e40af; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9em; margin: 12px 0; }
  th, td { padding: 6px 12px; border-bottom: 1px solid #e2e8f0; text-align: left; }
  th { font-weight: 600; border-bottom: 2px solid #cbd5e1; }
  a { color: #3b82f6; }
  .nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .nav a { font-size: 0.95em; }
  .subtitle { color: #666; font-size: 0.95em; }
  ul.contains-task-list { list-style: none; padding-left: 4px; }
  .reference { margin-top: 48px; border-top: 3px solid #3b82f6; padding-top: 24px; }
  .info { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 16px; margin: 16px 0; font-size: 0.9em; }
</style>
</head><body>
${THEME_TOGGLE_HTML}
<div class="nav">
  <a href="/setup">&larr; Setup guide</a>
  <a href="/api/architecture-manual">Raw markdown (for agents)</a>
</div>
<p class="subtitle">Spec: <code>spaiglass-architecture/1</code> &mdash; Published at <code>${PUBLIC_URL}/architecture-manual</code></p>
<div class="info">
  <strong>Reading this as an agent?</strong> Fetch <a href="/api/architecture-manual"><code>${PUBLIC_URL}/api/architecture-manual</code></a> for the raw markdown &mdash; easier to parse, same content. Read the <strong>entire</strong> core manual before writing any field.
</div>
${coreHtml}
${referenceHtml ? `<div class="reference"><h1>Reference Appendix</h1>${referenceHtml}</div>` : ""}
<p style="margin-top: 32px;"><a href="/setup">&larr; Back to Setup</a></p>
</body></html>`);
});

app.get("/api/architecture-manual", (c) => {
  const md = readManualMarkdown();
  if (!md) {
    return c.json({ error: "Architecture manual not deployed" }, 404);
  }
  c.header("Content-Type", "text/markdown; charset=utf-8");
  return c.body(md.core + (md.reference ? "\n\n---\n\n" + md.reference : ""));
});

// Terms of Service
app.get("/terms", (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><title>Terms of Service - SpAIglass</title>
${FAVICON}
${THEME_HEAD}
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui; max-width: 700px; margin: 60px auto; padding: 0 20px; color: #1a1a2e; background: #f0f0f5; line-height: 1.6; }
  h1 { font-size: 1.8em; }
  h2 { font-size: 1.2em; margin-top: 28px; }
  a { color: #3b82f6; }
  .updated { color: #666; font-size: 0.9em; }
</style>
</head><body>
${THEME_TOGGLE_HTML}
<h1>Terms of Service</h1>
<p class="updated">Last updated: April 9, 2026</p>

<h2>1. Service Description</h2>
<p>SpAIglass ("the Service") is a browser-based interface that routes connections to your virtual machines through a relay server. The Service is operated by ReadyStack.dev.</p>

<h2>2. Eligibility</h2>
<p>You must have a valid GitHub account to use the Service. By signing in, you agree to these terms.</p>

<h2>3. Acceptable Use</h2>
<p>You agree not to:</p>
<ul>
  <li>Use the Service for any unlawful purpose</li>
  <li>Attempt to gain unauthorized access to other users' VMs or data</li>
  <li>Interfere with or disrupt the Service infrastructure</li>
  <li>Reverse engineer or probe the relay beyond documented APIs</li>
</ul>

<h2>4. Your VMs and Data</h2>
<p>You are solely responsible for the content and activity on VMs you connect through the Service. The relay routes traffic but does not store, inspect, or modify your VM sessions.</p>

<h2>5. Availability</h2>
<p>The Service is provided "as is" without warranty. We do not guarantee uptime or availability and may modify or discontinue the Service at any time.</p>

<h2>6. Limitation of Liability</h2>
<p>To the maximum extent permitted by law, ReadyStack.dev shall not be liable for any indirect, incidental, or consequential damages arising from your use of the Service.</p>

<h2>7. Termination</h2>
<p>We may suspend or terminate your access at any time for violation of these terms. You may stop using the Service at any time.</p>

<h2>8. Open Source</h2>
<p>SpAIglass is open source software released under the <a href="https://github.com/c0inz/spaiglass/blob/main/LICENSE">MIT License</a>. The complete source code is available at <a href="https://github.com/c0inz/spaiglass">github.com/c0inz/spaiglass</a>.</p>

<h2>9. Changes</h2>
<p>We may update these terms. Continued use after changes constitutes acceptance.</p>

<p><a href="/">&larr; Back to SpAIglass</a></p>
</body></html>`);
});

// Privacy Policy
app.get("/privacy", (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><title>Privacy Policy - SpAIglass</title>
${FAVICON}
${THEME_HEAD}
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui; max-width: 700px; margin: 60px auto; padding: 0 20px; color: #1a1a2e; background: #f0f0f5; line-height: 1.6; }
  h1 { font-size: 1.8em; }
  h2 { font-size: 1.2em; margin-top: 28px; }
  a { color: #3b82f6; }
  .updated { color: #666; font-size: 0.9em; }
</style>
</head><body>
${THEME_TOGGLE_HTML}
<h1>Privacy Policy</h1>
<p class="updated">Last updated: April 9, 2026</p>

<h2>1. What We Collect</h2>
<p>When you sign in with GitHub, we store:</p>
<ul>
  <li><strong>GitHub profile info:</strong> username, display name, avatar URL, and GitHub user ID</li>
  <li><strong>Session tokens:</strong> random tokens used to keep you signed in</li>
  <li><strong>Connector records:</strong> names and tokens for VMs you register</li>
  <li><strong>Agent API keys:</strong> stored as hashed values only</li>
</ul>

<h2>2. What We Do NOT Collect</h2>
<ul>
  <li>We do not store, log, or inspect any traffic between your browser and your VMs</li>
  <li>We do not store your GitHub password or OAuth tokens long-term</li>
  <li>We do not use cookies for tracking or analytics</li>
  <li>We do not sell or share your data with third parties</li>
</ul>

<h2>3. How Data Flows</h2>
<p>The relay acts as a stateless routing proxy. Browser-to-VM WebSocket traffic passes through the relay in real time and is not stored. The relay only persists the minimal metadata needed to authenticate you and route connections to the correct VM.</p>

<h2>4. Data Storage</h2>
<p>All data is stored in a SQLite database on the relay server. Session tokens expire automatically and are cleaned up periodically.</p>

<h2>5. Data Deletion</h2>
<p>You can delete your connectors and agent keys from the dashboard at any time. To request full account deletion, contact us and we will remove all associated records.</p>

<h2>6. Third-Party Services</h2>
<p>We use GitHub OAuth for authentication. GitHub's privacy policy applies to data they collect during the sign-in process. We use Cloudflare for DNS and Caddy for TLS — standard infrastructure that does not process your VM traffic.</p>

<h2>7. Open Source</h2>
<p>SpAIglass is open source under the <a href="https://github.com/c0inz/spaiglass/blob/main/LICENSE">MIT License</a>. You can audit the complete relay source code at <a href="https://github.com/c0inz/spaiglass/tree/main/relay/src">github.com/c0inz/spaiglass</a> to verify exactly what data is collected and how it flows.</p>

<h2>8. Changes</h2>
<p>We may update this policy. Material changes will be noted on this page with an updated date.</p>

<p><a href="/">&larr; Back to SpAIglass</a></p>
</body></html>`);
});

// Auth routes
app.route("/", authRoutes());

// Connector management (has its own requireAuth)
app.route("/", connectorRoutes());

// Agent key management (has its own requireAuth)
app.route("/", agentKeyRoutes());

// Fleet Relay (canonical at /fleetrelay; / is also served for back-compat).
// Authenticated users get the fleet management UI; anonymous users get the
// landing/marketing page from the same handler.
// Unauthenticated landing page — marketing copy + "Sign in with GitHub" CTA.
// Split out so renderFleetRelay stays focused on the redirect decision.
function renderLanding(c: Context<RelayEnv>) {
  return c.html(`<!DOCTYPE html>
<html><head><title>SpAIglass</title>
${FAVICON}
${THEME_HEAD}
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: 'Satoshi', system-ui, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; color: #1a1a2e; background: #f0f0f5; }
  h1 { font-family: 'Clash Display', system-ui, sans-serif; font-size: 2.4em; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.5px; }
  .tagline { font-family: 'Clash Display', system-ui, sans-serif; font-size: 1.3em; color: #3b82f6; font-weight: 500; margin: 0 0 24px; }
  .pitch { font-size: 1.05em; line-height: 1.7; color: #444; margin-bottom: 24px; }
  .claude-hint { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 14px; padding: 16px 20px; margin-bottom: 24px; font-size: 1em; }
  .claude-hint strong { color: #1e40af; }
  .claude-hint a { color: #3b82f6; font-weight: 600; }
  .copy-box { position: relative; background: #1e293b; border-radius: 12px; padding: 16px 48px 16px 18px; margin-bottom: 24px; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 0.9em; color: #e2e8f0; line-height: 1.5; cursor: pointer; transition: all 0.2s ease; }
  .copy-box:hover { background: #263548; }
  .copy-btn { position: absolute; top: 50%; right: 12px; transform: translateY(-50%); background: none; border: 1px solid #475569; border-radius: 6px; color: #94a3b8; cursor: pointer; padding: 4px 8px; font-size: 0.85em; line-height: 1; transition: all 0.15s; }
  .copy-btn:hover { border-color: #94a3b8; color: #e2e8f0; }
  .copy-btn.copied { border-color: #22c55e; color: #22c55e; }
  a.btn { display: inline-block; padding: 14px 28px; background: #24292e; color: white; text-decoration: none; border-radius: 12px; font-family: 'Clash Display', system-ui, sans-serif; font-size: 1.05em; font-weight: 600; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); }
  a.btn:hover { background: #444d56; transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.15); }
  .footer { margin-top: 40px; font-size: 0.85em; color: #999; }
  .footer a { color: #999; }
  .mit { margin-top: 16px; font-size: 0.9em; color: #666; }
</style>
</head><body>
${THEME_TOGGLE_HTML}
<div style="display:flex;align-items:center;justify-content:center;gap:14px;">
  <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="width:48px;height:48px;">
    <g fill="currentColor">
      <path fill-rule="evenodd" d="M2,32C7,15 20,12 32,12C44,12 57,15 62,32C57,49 44,52 32,52C20,52 7,49 2,32ZM9,32C13,21 22,17 32,17C42,17 51,21 55,32C51,43 42,47 32,47C22,47 13,43 9,32Z"/>
      <path d="M21.5,26.5C16,28 9,30 9,32C9,34 16,36 21.5,37.5A11,11 0 0,0 21.5,26.5Z"/>
      <path fill-rule="evenodd" d="M20,32A11,11 0 1,1 42,32A11,11 0 1,1 20,32ZM24,32A7,7 0 1,0 38,32A7,7 0 1,0 24,32Z"/>
      <path d="M31,32L27,28A5,5 0 1,1 26,33Z"/>
    </g>
  </svg>
  <h1 style="margin:0;">SpAIglass</h1>
</div>
<p class="tagline">Claude chat--markdown access--one interface--ANYWHERE</p>
<p class="pitch">Browser-based interface for Claude Code across your machines. See your project files, edit markdown, run tools, and chat with Claude — from any device, anywhere. Open source. Fully auditable. Your code never leaves your machine.</p>
<p class="pitch" style="font-size: 0.95em; color: #475569;">Runs anywhere the Claude Code CLI runs: <strong>Linux</strong>, <strong>macOS</strong> (Intel + Apple Silicon), and <strong>Windows&nbsp;10/11</strong>. One dashboard, mixed fleet, one-line installer per platform.</p>
<div class="copy-box" onclick="copyPrompt(this)">
  <span id="prompt-text">Claude, tell me what spaiglass.xyz does, if its safe and how long it would take you to configure</span>
  <button class="copy-btn" onclick="event.stopPropagation();copyPrompt(this.parentElement);" title="Copy to clipboard">&#x1F4CB;</button>
</div>
<script>
function copyPrompt(el) {
  var text = document.getElementById('prompt-text').textContent;
  navigator.clipboard.writeText(text).then(function() {
    var btn = el.querySelector('.copy-btn');
    btn.classList.add('copied');
    btn.innerHTML = '&#x2713;';
    setTimeout(function() { btn.classList.remove('copied'); btn.innerHTML = '&#x1F4CB;'; }, 2000);
  });
}
</script>
<div class="claude-hint"><strong>Claude, start here &rarr;</strong> <a href="/setup">Setup</a></div>
<a class="btn" href="/auth/github">Sign in with GitHub</a>
<p class="mit">Released under the <a href="https://github.com/c0inz/spaiglass/blob/main/LICENSE" style="color: #3b82f6;">MIT License</a>. Full source on <a href="https://github.com/c0inz/spaiglass" style="color: #3b82f6;">GitHub</a>.</p>
<div class="footer"><a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="https://github.com/c0inz/spaiglass">github.com/c0inz/spaiglass</a></div>
</body></html>`);
}

// Authenticated user hit `/` but has no fleet (no owned connectors and no
// shared connectors). We can't land them on a chat window so instead:
// mint a fresh single-use agent key for this user, display it in a copy-box,
// and tell the human user to hand it to their setup agent. The agent runs
// /setup from there and — when done — the human signs in again and lands
// straight on chat (the `renderFleetRelay` path).
//
// A new key is minted on EVERY visit. Unused keys are harmless; used keys
// are still listed under /api/agent-keys where the user can revoke them.
function renderNoFleetWithToken(c: Context<RelayEnv>, userId: string) {
  const rawKey = randomBytes(32).toString("hex");
  const key = `sg_${rawKey}`;
  const keyHash = createHash("sha256").update(key).digest("hex");
  const prefix = `sg_${rawKey.slice(0, 8)}...`;
  const keyName = `browser-signon-${Date.now()}`;
  createAgentKey(userId, keyName, keyHash, prefix);

  return c.html(`<!DOCTYPE html>
<html><head><title>SpAIglass — Give this token to your agent</title>
${FAVICON}
${THEME_HEAD}
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: 'Satoshi', system-ui, sans-serif; max-width: 680px; margin: 60px auto; padding: 0 20px; color: #1a1a2e; background: #f0f0f5; }
  h1 { font-family: 'Clash Display', system-ui, sans-serif; font-size: 1.8em; font-weight: 700; margin-bottom: 8px; }
  .card { background: white; border-radius: 14px; padding: 28px 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border: 1px solid rgba(0,0,0,0.06); }
  p { line-height: 1.6; color: #444; }
  a { color: #3b82f6; font-weight: 600; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: #94a3b8; font-size: 0.9em; margin-top: 24px; }
  .token-box { position: relative; background: #1e293b; color: #e2e8f0; border-radius: 10px; padding: 16px 52px 16px 18px; margin: 16px 0 8px; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 0.95em; word-break: break-all; cursor: pointer; }
  .token-box:hover { background: #263548; }
  .copy-btn { position: absolute; top: 50%; right: 12px; transform: translateY(-50%); background: none; border: 1px solid #475569; border-radius: 6px; color: #94a3b8; cursor: pointer; padding: 5px 10px; font-size: 0.85em; line-height: 1; transition: all 0.15s; }
  .copy-btn:hover { border-color: #94a3b8; color: #e2e8f0; }
  .copy-btn.copied { border-color: #22c55e; color: #22c55e; }
  .prompt-box { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 14px 18px; margin: 16px 0; font-size: 0.92em; color: #1e3a8a; }
  code { background: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
</style>
</head><body>
${THEME_TOGGLE_HTML}
<div class="card">
  <h1>Give this token to your agent</h1>
  <p>You are signed in, but no VMs are registered to your account yet. Hand the token below to the Claude Code agent running on the machine you want to add — it will use the token to register the VM and set itself up.</p>
  <div class="token-box" onclick="copyToken(this)">
    <span id="sg-token">${key}</span>
    <button class="copy-btn" onclick="event.stopPropagation();copyToken(this.parentElement);" title="Copy to clipboard">&#x1F4CB;</button>
  </div>
  <p class="muted" style="margin-top: 4px;">Shown once per page load. If you lose it, refresh — a fresh token will replace it. Unused tokens are harmless; revoke any you don't need under <a href="/api/agent-keys">/api/agent-keys</a>.</p>
  <div class="prompt-box">
    <strong>What to tell your agent:</strong><br>
    Paste this into your agent's chat (copy/paste ready):
    <div class="token-box" style="margin-top: 10px;" onclick="copyPrompt(this)">
      <span id="agent-prompt">Follow <a href="${PUBLIC_URL}/setup" style="color:#93c5fd;">${PUBLIC_URL}/setup</a> and register this machine. Use this token for Option A / token-exchange: <strong>${key}</strong>. When setup is complete, tell me to sign in again at ${PUBLIC_URL} and I'll land in chat.</span>
      <button class="copy-btn" onclick="event.stopPropagation();copyPrompt(this.parentElement);" title="Copy to clipboard">&#x1F4CB;</button>
    </div>
  </div>
  <p class="muted">Once your agent reports "setup complete", refresh this page. You'll land directly in your chat window.</p>
  <p class="muted"><a href="/auth/logout" onclick="fetch('/auth/logout',{method:'POST'}).then(function(){location.href='/'});return false;">Sign out</a></p>
</div>
<script>
function copyToken(el) {
  var text = document.getElementById('sg-token').textContent;
  navigator.clipboard.writeText(text).then(function() {
    var btn = el.querySelector('.copy-btn');
    btn.classList.add('copied');
    btn.innerHTML = '&#x2713;';
    setTimeout(function() { btn.classList.remove('copied'); btn.innerHTML = '&#x1F4CB;'; }, 2000);
  });
}
function copyPrompt(el) {
  var text = document.getElementById('agent-prompt').innerText;
  navigator.clipboard.writeText(text).then(function() {
    var btn = el.querySelector('.copy-btn');
    btn.classList.add('copied');
    btn.innerHTML = '&#x2713;';
    setTimeout(function() { btn.classList.remove('copied'); btn.innerHTML = '&#x1F4CB;'; }, 2000);
  });
}
</script>
</body></html>`);
}

// Root route. Authenticated users go straight to a chat window — either the
// last agent they used, or the first owned (or shared) connector. No more
// fleet dashboard; the agent switcher in the chat header is the only fleet
// navigation surface. Unauthenticated users see the marketing landing page.
function renderFleetRelay(c: Context<RelayEnv>) {
  const user = c.get("user");
  if (!user) {
    return renderLanding(c);
  }

  // Prefer the user's last-used agent URL if we have one.
  const lastAgent = getUserPreference(user.id, "last_agent_url");
  if (lastAgent?.startsWith("/")) {
    return c.redirect(lastAgent);
  }

  // Otherwise fall back to the first owned connector, then the first shared
  // connector. For owned, use bare connector name (resolveVmSlug accepts it);
  // for shared, use owner_login.name so the slug resolves against the right
  // owner.
  const owned = getConnectorsByUser(user.id);
  if (owned.length > 0) {
    return c.redirect(`/vm/${owned[0].name}/`);
  }
  const shared = getSharedConnectorsForUser(user.id);
  if (shared.length > 0) {
    return c.redirect(`/vm/${shared[0].owner_login}.${shared[0].name}/`);
  }

  // Signed in, but no fleet configured (no owned + no shared). Show the
  // token-minting no-fleet page.
  return renderNoFleetWithToken(c, user.id);
}

// Root route. Authenticated users are redirected straight into a chat window
// (last-used agent, or first owned/shared connector). Unauthenticated users
// see the marketing landing page. There is no fleet dashboard UI anymore —
// the agent switcher in the chat header replaces it. The `/fleetrelay` path
// is kept as an alias so any bookmarks or stale links still land somewhere
// sensible rather than 404.
app.get("/", renderFleetRelay);
app.get("/fleetrelay", renderFleetRelay);

// --- WebSocket Setup ---

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// VM connector WebSocket
const connectorHandler = handleConnectorWs();
app.get(
  "/connector",
  upgradeWebSocket(() => ({
    onMessage(event, ws) {
      connectorHandler.onMessage(ws, event);
    },
    onClose(_event, ws) {
      connectorHandler.onClose(ws);
    },
    onError(_event, ws) {
      connectorHandler.onError(ws);
    },
  })),
);

// Resolve VM slug (githubLogin.vmName), connector name, or raw connector ID to a connector
function resolveVmSlug(slug: string): ReturnType<typeof getConnectorById> {
  // Try slug format: githubLogin.vmName
  const dotIndex = slug.indexOf(".");
  if (dotIndex > 0) {
    const login = slug.slice(0, dotIndex);
    const name = slug.slice(dotIndex + 1);
    return getConnectorBySlug(login, name);
  }
  // Try by connector name (case-insensitive)
  const byName = getConnectorByName(slug);
  if (byName) return byName;
  // Fallback: raw connector ID (for backwards compat)
  return getConnectorById(slug);
}

// Browser → VM WebSocket tunnel (must be before wildcard proxy route)
// The frontend connects to /api/ws; the inject script rewrites it to /vm/:slug/api/ws
app.get(
  "/vm/:slug/api/ws",
  upgradeWebSocket((c) => {
    const slug = c.req.param("slug")!;
    const sessionToken = getCookie(c, SESSION_COOKIE);

    const user = sessionToken ? getUserBySessionToken(sessionToken) : undefined;
    if (!user) {
      return {
        onOpen(_event, ws) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Authentication required",
            }),
          );
          ws.close();
        },
      };
    }

    const connector = resolveVmSlug(slug);
    if (!connector) {
      return {
        onOpen(_event, ws) {
          ws.send(
            JSON.stringify({ type: "error", message: "Connector not found" }),
          );
          ws.close();
        },
      };
    }
    // Phase 2: owner OR explicit collaborator may attach. Role decides whether
    // the relay forwards write-type frames to the VM (see tunnel.ts viewer mode).
    const role = getConnectorAccess(connector.id, user.id);
    if (!role) {
      return {
        onOpen(_event, ws) {
          ws.send(
            JSON.stringify({ type: "error", message: "Connector not found" }),
          );
          ws.close();
        },
      };
    }

    const handler = createBrowserWsHandler(
      connector.id,
      user.id,
      role,
      user.github_login,
    );
    return {
      onOpen(event, ws) {
        handler.onOpen(ws);
      },
      onMessage(event, ws) {
        handler.onMessage(ws, event);
      },
      onClose() {
        handler.onClose();
      },
      onError() {
        handler.onError();
      },
    };
  }),
);

// Auth + resolve middleware for all /vm/:slug routes
async function vmAuth(
  c: Context<RelayEnv>,
): Promise<
  | {
      user: NonNullable<ReturnType<typeof getUserBySessionToken>>;
      connector: NonNullable<ReturnType<typeof resolveVmSlug>>;
      role: ConnectorRole;
    }
  | Response
> {
  const slug = c.req.param("slug")!;
  // Use the user already resolved by authMiddleware (supports both session cookie and agent key)
  const user = c.get("user");

  if (!user) {
    const isApi =
      c.req.path.includes("/api/") ||
      c.req.header("accept")?.includes("application/json") ||
      c.req.header("x-requested-with") === "XMLHttpRequest";
    if (isApi) return c.json({ error: "Authentication required" }, 401);
    // Only redirect to auth for HTML page navigations; strip any trailing /api/... from redirect
    const redirectPath = c.req.path.replace(/\/api\/.*$/, "/");
    return c.redirect(
      `/auth/github?redirect=${encodeURIComponent(redirectPath)}`,
    );
  }

  const connector = resolveVmSlug(slug);
  // Phase 2: any user with owner/editor/viewer role can pass; downstream
  // handlers must consult `role` before permitting write operations.
  const role = connector ? getConnectorAccess(connector.id, user.id) : null;
  if (!connector || !role) {
    return c.html(
      `<!DOCTYPE html>
<html><head><title>VM Not Found</title>
${FAVICON}
<style>body{font-family:system-ui;max-width:600px;margin:80px auto;padding:0 20px;color:#1a1a2e;background:#f0f0f5;}</style>
</head><body><h1>VM not found</h1>
<p>No VM matching "${slug}" was found on your account.</p>
<p><a href="/fleetrelay">Back to fleet relay</a></p></body></html>`,
      404,
    );
  }

  // Phase 2: viewer mode is read-only at the HTTP layer.
  // Any non-safe method against /vm/:slug/* is rejected.
  if (role === "viewer") {
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      return c.json({ error: "Read-only access (viewer role)" }, 403);
    }
  }

  return { user, connector, role };
}

// MIME types for files we serve from RELAY_FRONTEND_DIR. Anything not in this
// table falls back to application/octet-stream.
const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return (
    STATIC_MIME[filePath.slice(dot).toLowerCase()] || "application/octet-stream"
  );
}

/**
 * Resolve a request path inside RELAY_FRONTEND_DIR safely.
 * Returns null if the path escapes the dir or doesn't exist.
 * Treats trailing slash as index.html (SPA root).
 */
function resolveFrontendFile(relPath: string): string | null {
  // Strip query string defensively (Hono usually does this, but just in case)
  const clean = relPath.split("?")[0];
  // Treat root and any trailing-slash directory request as index.html
  let rel =
    clean === "" || clean === "/" || clean.endsWith("/")
      ? "/index.html"
      : clean;
  // Reject anything containing .. segments
  if (rel.includes("..")) return null;
  // Strip leading slash so pathJoin doesn't treat it as absolute
  rel = rel.replace(/^\/+/, "");
  const full = pathJoin(RELAY_FRONTEND_DIR, rel);
  // Ensure resolved path is still inside the frontend dir
  if (!full.startsWith(RELAY_FRONTEND_DIR + "/") && full !== RELAY_FRONTEND_DIR)
    return null;
  if (!existsSync(full)) return null;
  const st = statSync(full);
  if (!st.isFile()) return null;
  return full;
}

/**
 * Try to serve a /vm/:slug/<vmPath> request from the relay's local frontend
 * bundle. Returns a Response on hit, undefined to fall through to the tunnel.
 *
 * Routing rules:
 *   /api/*           → undefined (caller tunnels)
 *   /assets/*        → serve the asset file (404 if missing)
 *   /favicon.svg etc → serve the file
 *   anything else    → SPA fallback: serve index.html with inject script
 *
 * If RELAY_FRONTEND_DIR is missing entirely we return undefined for ALL paths
 * so the legacy tunneled flow keeps working — that way a fresh relay deploy
 * without the frontend copy doesn't break the fleet.
 */
function tryServeFromRelayFrontend(
  c: Context<RelayEnv>,
  slug: string,
  vmPath: string,
  connectorName: string,
  customDisplayName: string | null,
): Response | undefined {
  if (vmPath.startsWith("/api/") || vmPath === "/api") return undefined;
  if (!existsSync(RELAY_FRONTEND_DIR)) return undefined;

  // Asset / static file path: try to serve directly. 404 if missing.
  const isAssetPath =
    vmPath.startsWith("/assets/") ||
    /^\/[^/]+\.(svg|png|jpg|jpeg|gif|ico|webp|woff2?|css|js|map|txt)$/i.test(
      vmPath,
    );
  if (isAssetPath) {
    const file = resolveFrontendFile(vmPath);
    if (!file) return new Response("Not found", { status: 404 });
    const buf = readFileSync(file);
    c.header("Content-Type", mimeFor(file));
    // Vite asset filenames are content-hashed → safe to cache aggressively
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(buf, { status: 200, headers: c.res.headers });
  }

  // SPA fallback: serve index.html with inject script + tab title rewrite.
  const indexFile = resolveFrontendFile("/index.html");
  if (!indexFile) return undefined; // no index.html → fall through to tunnel
  let html = readFileSync(indexFile, "utf-8");

  // Per-request CSP nonce. Every inline <script> tag we emit on this page
  // gets this nonce; the strict CSP header below only allows inline scripts
  // that carry it. The Vite-built script tag is loaded via src= and is
  // covered by 'self' — no nonce needed.
  const nonce = createHash("sha256")
    .update(crypto.randomUUID() + ":" + Date.now())
    .digest("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 22);

  // Tab title. When the owner has set a custom display name (via Settings →
  // Browser Tab Title), that wins over the auto-computed project-role label.
  // Otherwise fall back to compacting the /vm/:slug/<project>-<role>/ segment.
  const afterSlug = vmPath.replace(/^\//, "").replace(/\/$/, "");
  const segment = afterSlug.split("/")[0] || "";
  const lastHyphen = segment.lastIndexOf("-");
  const project = lastHyphen > 0 ? segment.slice(0, lastHyphen) : segment;
  const role = lastHyphen > 0 ? segment.slice(lastHyphen + 1) : "";
  let tabTitle: string;
  if (customDisplayName) tabTitle = customDisplayName;
  else if (project && role) tabTitle = serverCompactName(project, role);
  else if (project) tabTitle = serverAbbreviate(project, 8);
  else tabTitle = connectorName;

  const prefix = `/vm/${slug}`;
  const relayVersion = getLatestSpAIglassVersion();
  const frontendVersion = getLatestFrontendVersion();
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${tabTitle}</title>`);
  html = html.replace(/<link rel="icon"[^>]*>/, FAVICON);
  // Embed served versions + skew detector + URL inject. Order matters: the
  // skew detector must run BEFORE makeInjectScript so it captures the
  // original (unpatched) fetch before the inject script rewrites it.
  //
  // Two distinct versions are embedded:
  //   - <meta spaiglass-version>     install package (matches /api/release.version)
  //   - <meta spaiglass-frontend-version> + window.__SG_VERSION
  //                                  served bundle (matches /api/release.frontendVersion)
  // The skew toast reads __SG_VERSION and compares against frontendVersion so
  // cosmetic frontend deploys trigger the reload prompt without disturbing
  // the install-package-anchored per-VM dashboard banner.
  html = html.replace(
    "<head>",
    "<head>" +
      `<meta name="spaiglass-version" content="${relayVersion}">` +
      `<meta name="spaiglass-frontend-version" content="${frontendVersion}">` +
      `<script nonce="${nonce}">window.__SG_VERSION=${JSON.stringify(frontendVersion)}</script>` +
      makeVersionSkewScript(nonce) +
      makeInjectScript(slug, nonce),
  );
  // Rewrite absolute src/href paths so /assets/... becomes /vm/:slug/assets/...
  // (We serve those via the asset branch above.)
  html = html.replace(/((?:src|href|action)=["'])\/(?!\/)/g, `$1${prefix}/`);

  // Strict CSP for the SPA. Notes on each directive:
  //   default-src 'none'              — deny everything not explicitly allowed
  //   script-src 'self' 'nonce-...'   — same-origin Vite bundle + our 3 inline blocks
  //   style-src 'self' 'unsafe-inline'— React inline styles + Tailwind/Vite CSS
  //                                     bundle. Inline styles are far less
  //                                     dangerous than inline scripts; tightening
  //                                     this further would require restyling
  //                                     several components.
  //   img-src 'self' data: blob:      — favicon, embedded SVG icons, blob previews
  //   font-src 'self' data:           — bundled fonts + base64 fallbacks
  //   connect-src 'self' ws: wss:     — fetch + WebSocket back to the relay
  //   worker-src 'self' blob:         — Monaco language workers. Vite ?worker
  //                                     imports are served from /assets/<hash>.js
  //                                     (same-origin, covered by 'self'). blob:
  //                                     covers any future inline-worker fallbacks
  //                                     (e.g. mermaid). Without this, Monaco
  //                                     falls back to jsdelivr and the file
  //                                     editor hangs on "Loading..." forever.
  //   frame-ancestors 'none'          — overlap with X-Frame-Options DENY
  //   form-action 'self'              — no third-party form posting
  //   base-uri 'none'                 — block <base href> hijacks
  //   object-src 'none'               — no Flash/applet embeds
  //   upgrade-insecure-requests       — force https on any stray http:// asset
  const csp = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Content-Security-Policy", csp);
  c.header("X-SpAIglass-Version", relayVersion);
  return new Response(html, { status: 200, headers: c.res.headers });
}

// Frontend version-skew detector. Polls /api/release every 5 minutes; when
// the relay's served frontend bundle rolls forward past the version we were
// served with, shows a small "reload to update" banner. Pure inline JS — no
// React deps.
//
// Compares window.__SG_VERSION (the frontend bundle version baked into the
// HTML at serve time) against /api/release.frontendVersion (the live relay's
// current bundle version). It is intentionally decoupled from the install
// package version (`/api/release.version`) so cosmetic frontend deploys can
// trigger this reload prompt WITHOUT advancing the install-package version
// that drives the per-VM dashboard "out of date" banner.
//
// IMPORTANT: must run BEFORE makeInjectScript so it captures the original
// (unpatched) fetch reference. After that the page-level fetch wrapper
// rewrites /api/* to /vm/:slug/api/* (which would tunnel to the VM and 404).
function makeVersionSkewScript(nonce: string): string {
  return `<script nonce="${nonce}">(function(){
var _origFetch=window.fetch.bind(window);
var SHOWN=false;
function show(latest){
  if(SHOWN)return;SHOWN=true;
  var b=document.createElement('div');
  b.id='sg-skew-banner';
  b.style.cssText='position:fixed;bottom:16px;right:16px;z-index:99999;background:#1a1a2e;color:#f0f0f5;padding:10px 14px;border-radius:8px;font:13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);border:1px solid #4a4a6e;max-width:320px';
  b.innerHTML='<div style="margin-bottom:6px;font-weight:600">Update available</div>'+
    '<div style="opacity:.8;margin-bottom:8px">A new SpAIglass frontend ('+latest+') is available. Reload to refresh this page.</div>'+
    '<button id="sg-skew-reload" style="background:#5a9ee0;color:#fff;border:0;padding:5px 12px;border-radius:5px;cursor:pointer;font:inherit;margin-right:6px">Reload</button>'+
    '<button id="sg-skew-dismiss" style="background:transparent;color:#aaa;border:0;padding:5px 8px;cursor:pointer;font:inherit">Dismiss</button>';
  document.body.appendChild(b);
  document.getElementById('sg-skew-reload').onclick=function(){location.reload()};
  document.getElementById('sg-skew-dismiss').onclick=function(){b.remove()};
}
function check(){
  var have=window.__SG_VERSION;
  if(!have||have==='unknown')return;
  // Use the captured original fetch so the request goes to the relay,
  // not through the /vm/:slug rewrite that the inject script installs.
  _origFetch('/api/release',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
    if(d&&d.frontendVersion&&d.frontendVersion!==have&&d.frontendVersion!=='unknown')show(d.frontendVersion);
  }).catch(function(){});
}
setTimeout(check,30000);
setInterval(check,5*60*1000);
})()</script>`;
}

// URL rewriting script injected into HTML responses from the VM backend.
// Patches fetch() and WebSocket() to prepend /vm/:slug so requests route through the relay.
function makeInjectScript(slug: string, nonce: string): string {
  const prefix = `/vm/${slug}`;
  return (
    `<script nonce="${nonce}">(function(){` +
    `var B='${prefix}';` +
    `var H=location.origin;` +
    // Tell React Router's BrowserRouter to use this basename
    `window.__SG_BASE=B;` +
    // Parse project-role context from URL: /vm/:slug/<project>-<role>/
    `var inner=location.pathname.slice(B.length).replace(/^\\/+/,'');` +
    `var seg=inner.split('/').filter(Boolean)[0]||'';` +
    `var di=seg.lastIndexOf('-');` +
    `var proj=di>0?seg.slice(0,di):'';` +
    `var role=di>0?seg.slice(di+1):'';` +
    `window.__SG={slug:'${slug}',project:proj,role:role,segment:seg};` +
    // URL rewrite helper — adds /vm/:slug prefix to same-origin paths
    `function rw(u){` +
    `if(typeof u!=='string')return u;` +
    `if(u[0]==='/'&&u.indexOf(B)!==0)return B+u;` +
    `if(u.indexOf(H)===0){var q=u.slice(H.length);if(q[0]==='/'&&q.indexOf(B)!==0)return H+B+q;}` +
    `return u;` +
    `}` +
    // Patch fetch
    `var _F=window.fetch;window.fetch=function(u,o){` +
    `if(typeof u==='string')u=rw(u);` +
    `else if(u instanceof Request){var nu=rw(u.url);if(nu!==u.url)u=new Request(nu,u);}` +
    `return _F.call(this,u,o)};` +
    // Patch WebSocket
    `var _W=window.WebSocket;window.WebSocket=function(u,pr){` +
    `if(typeof u==='string'){` +
    `if(u.indexOf('ws://')===0||u.indexOf('wss://')===0){` +
    `try{var x=new URL(u);if(x.host===location.host&&x.pathname.indexOf(B)!==0){x.pathname=B+x.pathname;u=x.toString();}}catch(e){}}` +
    `else{u=rw(u);}` +
    `}` +
    `return new _W(u,pr)};` +
    `window.WebSocket.prototype=_W.prototype;` +
    `window.WebSocket.CONNECTING=_W.CONNECTING;window.WebSocket.OPEN=_W.OPEN;window.WebSocket.CLOSING=_W.CLOSING;window.WebSocket.CLOSED=_W.CLOSED;` +
    `})()</script>`
  );
}

// Helper: GET JSON from a VM backend through the tunnel
async function proxyGetJson(
  cm: ReturnType<typeof getChannelManager>,
  connectorId: string,
  path: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  try {
    const resp = await cm.httpRequest(connectorId, "GET", path, {
      Accept: "application/json",
    });
    if (resp.status >= 400) return null;
    if (resp.kind !== "buffered") return null;
    return JSON.parse(resp.body);
  } catch {
    return null;
  }
}

// Relay-level fleet data API, accessible from within a VM context.
// The frontend's fetch() is patched to prepend /vm/:slug, so a call to
// /api/__relay/fleet becomes /vm/:slug/api/__relay/fleet. This route
// intercepts it before the catch-all VM proxy and returns fleet data
// (connectors + roles) for the authenticated user.
app.get("/vm/:slug/api/__relay/fleet", async (c) => {
  const auth = await vmAuth(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const ownedConns = getConnectorsByUser(user.id);
  const sharedConns = getSharedConnectorsForUser(user.id);
  const cm = getChannelManager();

  const allConns = [
    ...ownedConns.map((conn) => ({
      id: conn.id,
      name: conn.name,
      displayName: connectorDisplayName(conn),
      role: "owner" as const,
      online: cm.isOnline(conn.id),
    })),
    ...sharedConns.map((conn) => ({
      id: conn.id,
      name: conn.name,
      displayName: connectorDisplayName(conn),
      role: conn.role,
      online: cm.isOnline(conn.id),
    })),
  ];

  return c.json({ connectors: allConns });
});

// Read the current connector's id, name, and custom display name. The chat
// UI uses this to populate the "Browser tab title" editor in the settings
// modal — we can't just send the connector name because the owner may have
// set a human-friendly override via the old pencil / fleet dashboard.
app.get("/vm/:slug/api/__relay/self", async (c) => {
  const auth = await vmAuth(c);
  if (auth instanceof Response) return auth;
  const { user, connector, role } = auth;
  return c.json({
    id: connector.id,
    name: connector.name,
    displayName: connectorDisplayName(connector),
    // Raw column — distinguishes "user set an override" from "fell back to
    // connector name". The modal pre-fills the input with this value so the
    // user can clear it to revert to the default.
    customDisplayName: connector.display_name ?? null,
    role,
    ownerLogin: user.github_login,
  });
});

// Update the current connector's custom display name. Owner-only — the
// underlying helper silently no-ops if user.id is not the owner. The chat UI
// shows this field as "Browser tab title" in the project/role settings
// modal; it drives the tab title on the relay's served SPA bundle (see
// `tryServeFromRelayFrontend` which calls `connectorDisplayName`).
app.put("/vm/:slug/api/__relay/self/display-name", async (c) => {
  const auth = await vmAuth(c);
  if (auth instanceof Response) return auth;
  const { user, connector, role } = auth;
  if (role !== "owner") {
    return c.json({ error: "Only the owner can edit the tab title" }, 403);
  }
  const body = await c
    .req.json<{ displayName?: string | null }>()
    .catch(() => null);
  if (!body || !("displayName" in body)) {
    return c.json({ error: "displayName field required" }, 400);
  }
  const next = body.displayName?.trim() || null;
  if (next && next.length > 100) {
    return c.json({ error: "Display name max 100 chars" }, 400);
  }
  const updated = updateConnectorDisplayName(connector.id, user.id, next);
  if (!updated) {
    return c.json({ error: "Connector not found" }, 404);
  }
  return c.json({ ok: true, displayName: next });
});

// Save last-used agent URL for post-auth redirect
app.put("/vm/:slug/api/__relay/last-agent", async (c) => {
  const auth = await vmAuth(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const body = await c.req.json<{ url: string }>().catch(() => null);
  if (!body?.url || typeof body.url !== "string") {
    return c.json({ error: "url is required" }, 400);
  }
  // Only allow relative paths
  if (!body.url.startsWith("/")) {
    return c.json({ error: "url must be a relative path" }, 400);
  }

  setUserPreference(user.id, "last_agent_url", body.url);
  return c.json({ ok: true });
});

// Relay-level: fetch roles for a specific connector (by slug), accessible from VM context.
app.get("/vm/:slug/api/__relay/fleet/:targetSlug/roles", async (c) => {
  const auth = await vmAuth(c);
  if (auth instanceof Response) return auth;

  const targetSlug = c.req.param("targetSlug")!;
  const targetConn = resolveVmSlug(targetSlug);
  if (!targetConn) return c.json({ roles: [] });

  const cm = getChannelManager();
  if (!cm.isOnline(targetConn.id)) return c.json({ roles: [] });

  // Proxy /api/projects and /api/projects/contexts to the target VM
  try {
    const projRes = await proxyGetJson(cm, targetConn.id, "/api/projects");
    if (!projRes?.projects) return c.json({ roles: [] });

    const roles: Array<{
      project: string;
      displayName: string | null;
      projectPath: string;
      roleFile: string;
      roleName: string;
      segment: string;
      url: string;
    }> = [];

    // Fetch project display names (one call per VM, not per project)
    const dnRes = await proxyGetJson(
      cm,
      targetConn.id,
      "/api/settings/project-display-names",
    );
    const displayNames: Record<string, string> =
      dnRes?.displayNames || {};

    for (const proj of projRes.projects) {
      const ctxRes = await proxyGetJson(
        cm,
        targetConn.id,
        `/api/projects/contexts?path=${encodeURIComponent(proj.path)}`,
      );
      if (!ctxRes?.contexts) continue;
      const projBase =
        proj.path.split("/").filter(Boolean).pop() || proj.encodedName;
      for (const ctx of ctxRes.contexts) {
        const roleBase = ctx.filename.replace(/\.md$/, "");
        const segment = `${projBase}-${roleBase}`;
        roles.push({
          project: projBase,
          displayName: displayNames[projBase] || null,
          projectPath: proj.path,
          roleFile: ctx.filename,
          roleName: ctx.name,
          segment,
          url: `/vm/${targetSlug}/${segment}/`,
        });
      }
    }

    return c.json({ roles });
  } catch {
    return c.json({ roles: [] });
  }
});

// Redirect /vm/:slug (no trailing slash) to /vm/:slug/
app.get("/vm/:slug", (c) => {
  return c.redirect(`/vm/${c.req.param("slug")}/`);
});

// HTTP proxy: all /vm/:slug/* requests are forwarded to the VM backend
// via HTTP-over-WebSocket through the connector tunnel
app.all("/vm/:slug/*", async (c) => {
  const slug = c.req.param("slug")!;
  const auth = await vmAuth(c);
  if (auth instanceof Response) return auth;
  const { connector } = auth;

  const cm = getChannelManager();
  if (!cm.isOnline(connector.id)) {
    return c.html(
      `<!DOCTYPE html>
<html><head><title>VM Offline</title>
${FAVICON}
<style>body{font-family:system-ui;max-width:600px;margin:80px auto;padding:0 20px;color:#1a1a2e;background:#f0f0f5;}</style>
</head><body><h1>VM offline</h1>
<p>${connector.display_name || connector.name} is not connected to the relay.</p>
<p>Start the connector on the VM to bring it online.</p>
<p><a href="/fleetrelay">Back to fleet relay</a></p></body></html>`,
      503,
    );
  }

  // Strip /vm/:slug prefix — the VM backend serves from root
  const vmPath = c.req.path.replace(`/vm/${slug}`, "") || "/";
  const queryString = new URL(c.req.url).search;
  const fullVmPath = vmPath + queryString;

  // Try the relay's local frontend bundle first. HTML pages and Vite assets
  // are served straight from /opt/sgcleanrelay/frontend so the browser doesn't
  // have to round-trip every page load through the connector tunnel. /api/*
  // requests (and anything else the helper can't satisfy) fall through to the
  // tunneled flow below.
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    const localResp = tryServeFromRelayFrontend(
      c,
      slug,
      vmPath,
      connector.name,
      connector.display_name,
    );
    if (localResp) return localResp;
  }

  // Forward relevant request headers
  const fwdHeaders: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (
      ![
        "host",
        "connection",
        "upgrade",
        "transfer-encoding",
        "keep-alive",
      ].includes(lk)
    ) {
      fwdHeaders[key] = value;
    }
  });

  // Read body as binary and base64-encode for the WS tunnel (preserves multipart/form-data)
  let body: string | undefined;
  let bodyEncoding: "utf-8" | "base64" | undefined;
  if (!["GET", "HEAD"].includes(c.req.method)) {
    const contentType = c.req.header("content-type") || "";
    const isText = /text|json|xml|x-www-form-urlencoded/.test(contentType);
    if (isText) {
      body = await c.req.text();
      bodyEncoding = "utf-8";
    } else {
      const buf = Buffer.from(await c.req.arrayBuffer());
      body = buf.toString("base64");
      bodyEncoding = "base64";
    }
  }

  try {
    const resp = await cm.httpRequest(
      connector.id,
      c.req.method,
      fullVmPath,
      fwdHeaders,
      body,
      bodyEncoding,
    );

    // Set response headers (skip hop-by-hop)
    for (const [key, value] of Object.entries(resp.headers)) {
      const lk = key.toLowerCase();
      if (!["transfer-encoding", "content-length", "connection"].includes(lk)) {
        c.header(key, value);
      }
    }

    // Streaming response path — the VM opted into http_stream_start/chunk/end.
    // Pipe the ReadableStream straight through to the browser without buffering
    // so chat NDJSON lines arrive incrementally. HTML injection only applies
    // to buffered text responses below.
    if (resp.kind === "stream") {
      c.header("Cache-Control", "no-cache, no-transform");
      c.header("X-Accel-Buffering", "no");
      return new Response(resp.stream, {
        status: resp.status,
        headers: c.res.headers,
      });
    }

    const isHtml = resp.headers["content-type"]?.includes("text/html");

    if (isHtml && resp.bodyEncoding !== "base64") {
      // Inject URL rewriting into HTML responses
      let html = resp.body;
      const prefix = `/vm/${slug}`;

      // Parse project-role from the path for tab title
      // URL format: /vm/:slug/<project>-<role>/ (single segment)
      const afterSlug = vmPath.replace(/^\//, "").replace(/\/$/, "");
      const segment = afterSlug.split("/")[0] || "";
      const lastHyphen = segment.lastIndexOf("-");
      const project = lastHyphen > 0 ? segment.slice(0, lastHyphen) : segment;
      const role = lastHyphen > 0 ? segment.slice(lastHyphen + 1) : "";

      // Build compact tab title
      let tabTitle: string;
      if (project && role) {
        tabTitle = serverCompactName(project, role);
      } else if (project) {
        tabTitle = serverAbbreviate(project, 8);
      } else {
        tabTitle = connector.display_name || connector.name;
      }

      // Rewrite <title>
      html = html.replace(
        /<title>[^<]*<\/title>/,
        `<title>${tabTitle}</title>`,
      );
      // Inject relay favicon
      html = html.replace(/<link rel="icon"[^>]*>/, FAVICON);
      // Inject the fetch/WebSocket patching script at the very top of <head>.
      // MUST execute before any other scripts (including deferred modules).
      // The legacy tunneled-HTML path also gets a per-request CSP nonce so
      // the inject script can run under the strict policy. Note: we cannot
      // easily nonce inline scripts already in the tunneled HTML body — if
      // the VM backend serves any inline <script>, this CSP will block it.
      // The Vite build pipeline does not produce inline scripts so this is
      // fine in practice.
      const tunnelNonce = createHash("sha256")
        .update(crypto.randomUUID() + ":" + Date.now())
        .digest("base64")
        .replace(/[+/=]/g, "")
        .slice(0, 22);
      html = html.replace(
        "<head>",
        "<head>" + makeInjectScript(slug, tunnelNonce),
      );
      // Rewrite absolute src/href paths in HTML tags (after inject so inject isn't affected)
      html = html.replace(
        /((?:src|href|action)=["'])\/(?!\/)/g,
        `$1${prefix}/`,
      );
      // Don't cache HTML — always get fresh inject script
      c.header("Cache-Control", "no-cache, no-store, must-revalidate");
      const tunnelCsp = [
        "default-src 'none'",
        `script-src 'self' 'nonce-${tunnelNonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "upgrade-insecure-requests",
      ].join("; ");
      c.header("Content-Security-Policy", tunnelCsp);
      return c.html(html, resp.status as any);
    }

    if (resp.bodyEncoding === "base64") {
      const buf = Buffer.from(resp.body, "base64");
      c.header("Content-Length", buf.length.toString());
      return new Response(buf, { status: resp.status, headers: c.res.headers });
    }

    return c.body(resp.body, resp.status as any);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Proxy error";
    return c.html(
      `<!DOCTYPE html>
<html><head><title>Proxy Error</title>
${FAVICON}
<style>body{font-family:system-ui;max-width:600px;margin:80px auto;padding:0 20px;color:#1a1a2e;background:#f0f0f5;}</style>
</head><body><h1>Proxy error</h1>
<p>${message}</p>
<p><a href="/fleetrelay">Back to fleet relay</a></p></body></html>`,
      502,
    );
  }
});

// --- Start Server ---

console.log(`SGCleanRelay starting on ${HOST}:${PORT}`);
console.log(`Public URL: ${PUBLIC_URL}`);

const server = createServer();
injectWebSocket(server);
server.on("request", getRequestListener(app.fetch));
server.listen(PORT, HOST, () => {
  console.log(`Listening on ${HOST}:${PORT}`);
});

// Session cleanup every hour
setInterval(
  () => {
    const cleaned = cleanExpiredSessions();
    if (cleaned > 0) console.log(`Cleaned ${cleaned} expired sessions`);
  },
  60 * 60 * 1000,
);

console.log("SGCleanRelay ready.");
