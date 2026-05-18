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
  getUserById,
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
/* Brand wordmark: keep "ai" gold across every theme. Required because the
 * glass theme paints the whole h1 with a transparent-fill gradient, which
 * cascades into descendants — without this override the span inherits the
 * gradient and the gold is lost. */
h1 .brand-ai, [data-theme] h1 .brand-ai { color: #f59e0b !important; background: none !important; -webkit-text-fill-color: #f59e0b !important; -webkit-background-clip: initial !important; background-clip: initial !important; }
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
    bestPractice: {
      title: "Running the integrity check is the #1 best practice",
      summary:
        "Every setup you perform MUST end with the six-gate integrity check in the \"Verify the setup actually works\" step. Do not declare success until all six gates are green. A setup where the installer exited 0 and the connector shows online can still be silently broken — the gates exist because these failures have shipped to real users.",
      failuresCaught: [
        "Orphan connectors — installer wired up a different connector than the one just registered; the new row stays permanently online:false and clutters every user's dropdown.",
        "Role-less dead chats — directory has no agents/*.md, so session_start rejects every message while the UI looks connected.",
        "Duplicate-VM fleet pollution — leftover connectors from prior setup attempts masquerading as separate servers in the dropdown.",
      ],
      rule:
        "If any integrity gate fails, do not report success. Fix it and re-run the check. The contract: installer exit 0 is not proof; all six gates green is proof.",
      universalFixPattern:
        "The best universal recipe for almost any failed integrity gate is \"delete bad record + re-add correctly\". Every configurable surface supports it: DELETE /api/connectors/:id then POST /api/connectors (relay), DELETE /api/roles/:name?path=X then POST /api/roles?path=X (VM), POST /api/projects/unregister then POST /api/projects/register (VM). Re-running the installer is just a convenience wrapper over the same pattern.",
      perGateFix: [
        "Gate 1 (relay health) — infrastructure; redeploy relay if failing.",
        "Gate 2 (connector offline) — DELETE /api/connectors/:id then re-run installer (POSTs a fresh connector with valid token).",
        "Gate 3 (project missing) — POST /api/projects/register on the VM (idempotent; re-registering same path is safe). Use POST /api/projects/unregister first if the entry is corrupt.",
        "Gate 4 (no role file) — DELETE /api/roles/:name?path=<project> then POST /api/roles?path=<project>. Or drop /roletemplate.md into <project>/.claude/agents/developer.md.",
        "Gate 5 (CONNECTOR_ID mismatch) — DELETE /api/connectors/:id on the orphan, then re-run installer so the live service writes the correct UUID to ~/spaiglass/.env.",
        "Gate 6 (duplicate/legacy connectors) — DELETE /api/connectors/:id on each orphan; keep the one whose UUID matches the live ~/spaiglass/.env.",
      ],
    },
    model: {
      title: "Mental model: Server + Directory (read this first)",
      summary:
        "SpAIglass now works on two concepts — Server and Directory. Everything below assumes this model. If you are an agent reading this to configure a new user, internalize the terms before touching any endpoints.",
      points: [
        "<strong>Server</strong> = one connector = one machine. The user picks a server from a dropdown in the UI. Internally each server has a connector <code>name</code> (URL slug) and a <code>displayName</code> (human label). The fleet API calls these rows \"connectors\"; the UI calls them \"Servers\". Same thing. One agent key can own many servers.",
        "<strong>Directory</strong> = one project folder on a server. In the UI this is a dropdown populated from the server's <code>GET /api/projects</code> (Claude Code's own project registry at <code>~/.claude.json</code>). One server can have many directories — a user is no longer forced into one-connector-per-project. <strong>The UI term is always \"Directory\", never \"Folder\" — do not rename it in user-facing copy.</strong>",
        "<strong>Role is optional.</strong> A role file (<code>.claude/agents/&lt;role&gt;.md</code>) defines persistent Claude persona + plugins + tool allowlist for a directory. If a directory has no role, chat still works — you just get the default Claude Code behavior. Add roles when the user wants persistent persona or plugin pinning; skip them for casual exploration.",
        "<strong>URL shapes.</strong> <code>/vm/&lt;login&gt;.&lt;server&gt;/</code> → Server+Directory picker. <code>/vm/&lt;login&gt;.&lt;server&gt;/&lt;directory-basename&gt;/</code> → chat for that directory (role-less; primary flow). <code>/vm/&lt;login&gt;.&lt;server&gt;/&lt;directory&gt;-&lt;role&gt;/</code> → chat with a specific role (legacy but still supported for links/bookmarks). The human never needs to know any of these — they use dropdowns.",
        "<strong>Migration from old single-project connectors.</strong> Existing connectors keep working as-is. They just become \"servers\" in the new vocabulary. The old one-connector-per-project habit is no longer necessary — consolidate by pointing one connector at a server with several <code>~/projects/*</code> directories. Nothing in the DB needs migrating.",
      ],
    },
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
        title: "Check what already exists (do this FIRST)",
        description:
          'Before registering anything, find out whether this user already has a connector set up. This step prevents the #1 fleet-maintenance bug: agents re-registering a VM the user already owns, leaving duplicate or stale connectors behind.<br><br><strong>1. Do you already have an agent key?</strong> If your human user has handed you an <code>sg_...</code> key, use it. If not, skip to Step 2 to mint one — you need it to call <code>GET /api/connectors</code>.<br><br><strong>2. List existing connectors.</strong> Call <code>GET ' +
          PUBLIC_URL +
          '/api/connectors</code> with your agent key. If the VM you are being asked to configure already appears in the list, do NOT create a new one — reuse it. If only the human-friendly name is wrong, use <code>PATCH /api/connectors/:id</code> with <code>{"name": "new-slug"}</code> to rename in place (preserves id + token, VM keeps running).<br><br><strong>3. Ask the human when in doubt.</strong> If the list has a connector that <em>might</em> be the target VM (same prefix, similar name), ask the human before touching it — do not guess.',
        endpoint: `GET ${PUBLIC_URL}/api/connectors`,
        note: "Requires `Authorization: Bearer sg_YOUR_KEY` header. Response is a flat array of `{id, name, displayName, role, online, lastSeen, ...}`. This is the source of truth for the fleet dropdown — anything in it is real, anything not in it does not exist.",
      },
      {
        title: "Get an agent key (two options)",
        description:
          'You need an <code>sg_...</code> agent key before you can register a VM. Pick whichever option fits how your human user is set up:<br><br><strong>Option A — You already have your user\'s GitHub PAT.</strong> Exchange it for an agent key via the API below. This is the fastest path when you (the agent) already have credentials. A <em>classic</em> PAT needs no scopes (the relay only calls <code>GET https://api.github.com/user</code>). A <em>fine-grained</em> PAT needs <strong>Account permissions → Read profile data</strong> — no repo scopes.<br><br><strong>Option B — Ask the human to retrieve a token.</strong> Tell the user: "Go to <a href="' +
          PUBLIC_URL +
          '">' +
          PUBLIC_URL +
          '</a> and sign in with GitHub. If you have no VMs registered yet, a one-shot token will appear in a copy-box — paste it back to me." That token is a real <code>sg_...</code> agent key minted for their session. Either option produces the same kind of key; use Option B whenever you do not already have a PAT and do not want to ask for one.',
        endpoint: `POST ${PUBLIC_URL}/api/auth/token-exchange`,
        body: '{ "github_pat": "github_pat_YOUR_TOKEN", "key_name": "my-agent" }',
        note: "Token prefix: fine-grained PATs start with `github_pat_` (the default when you create one in GitHub today); classic PATs start with `ghp_`. Either one is accepted — send the string you have, whichever prefix it has. Save the returned agent key — it is shown only once. Treat it like a password. All subsequent steps set the header `Authorization: Bearer sg_YOUR_KEY`.",
      },
      {
        title: "Register a VM",
        description:
          'Register a new VM connector. The <code>name</code> is a short label for your reference (used as the URL slug the human will see later). You can register one VM, or one for each project you are setting up — the agent key is reusable across VMs.<br><br><strong>Name rules (enforced on create AND rename — same contract):</strong> must start alphanumeric, can contain letters, digits, dots, hyphens, underscores; max 100 chars; cannot be a reserved relay route (e.g. <code>api</code>, <code>vm</code>, <code>setup</code>, <code>auth</code>, <code>install</code>, <code>releases</code>, <code>dashboard</code>). Whitespace-only or empty names are rejected. A 409 means you (the same user) already have a connector with that name — check Step 1\'s list and reuse it, or pick a different name.<br><br><strong>Want a different name later?</strong> Use <code>PATCH /api/connectors/:id</code> with <code>{"name": "new-slug"}</code>. That preserves the id and token so the VM-side connector keeps working without reconfig — see the Fleet Management API section below.',
        endpoint: `POST ${PUBLIC_URL}/api/connectors`,
        body: '{ "name": "my-vm" }',
        note:
          "Requires `Authorization: Bearer sg_YOUR_KEY` header. The response returns `{ id, name, token, ... }` — save all three, `token` is shown ONCE and you'll feed all three to the installer in the next step. `id` and `token` are both UUIDs (no prefix); `name` is the slug you just chose.\n\n" +
          'Worked example mapping this response to Step 5 flags:\n' +
          '  Response:  { "id": "4f5e...", "name": "my-vm", "token": "8a9b..." }\n' +
          '  Step 5:    --id=4f5e... --name=my-vm --token=8a9b...\n' +
          "Copy each field verbatim. Do not invent values. Do not reuse the agent key (sg_...) as the connector token — they are different credentials. You do NOT need to construct or remember a VM URL; sign-in handles routing for the human automatically.",
      },
      {
        title: "Install Claude Code CLI on the host",
        description:
          "SpAIglass spawns the official Anthropic Claude Code CLI to run sessions. It must be installed AND authenticated before the spaiglass installer runs.<br><br><strong>Auth model — read this first.</strong> Both auth patterns below use your existing Claude <strong>subscription via OAuth</strong>. Neither one generates or uses an <code>ANTHROPIC_API_KEY</code>; nothing here switches you to API-key billing. The terms \"headless\" and \"setup-token\" sound like API-key flows but they are not — they are just OAuth tokens stored on disk so non-interactive subprocesses can read them. SpAIglass spawns <code>claude</code> as a subprocess; it inherits whichever credentials file you produce here.<br><br><strong>Pick the right pattern for the host:</strong><br><br><strong>Pattern A — Desktop with a browser (Windows, macOS, Linux desktop).</strong> Run <code>claude login</code> once. The CLI opens your default browser, you complete OAuth, the credentials persist to <code>~/.claude/.credentials.json</code> (Linux/macOS) or <code>%USERPROFILE%\\.claude\\.credentials.json</code> (Windows). Use this on any machine where you can reach the browser yourself.<br><br><strong>Pattern B — Headless VM (no desktop, SSH-only).</strong> Plain <code>claude login</code> hangs waiting for a TTY/browser that is not there. Run <code>claude setup-token</code> on the VM instead — it prints a URL, you open it in a browser on any other machine, complete OAuth, paste the code back into the VM terminal. Same OAuth subscription, just a one-round-trip flow that doesn't need a browser on the VM itself.<br><br><strong>Pattern C — Cloning credentials (fleet rollouts).</strong> If you already authenticated on another machine, copy <code>~/.claude/.credentials.json</code> to the new host (same path, mode 600 on Linux/macOS). Same OAuth subscription, no second login.<br><br>Verify with <code>claude --version</code> AND a trivial round-trip (<code>echo hi | claude -p 'say ok'</code>) before continuing. A claude binary that responds to <code>--version</code> but 401s on <code>-p</code> will cause the spaiglass installer to look fine while every chat session dies on first message.",
        requirements: [
          "Node.js >= 20",
          "Claude Code CLI installed (~/.local/bin/claude on Linux/macOS, %USERPROFILE%\\.local\\bin\\claude.exe on Windows)",
          "Claude Code CLI authenticated via OAuth (subscription) — verify with: echo hi | claude -p 'say ok'",
        ],
        commands: [
          "# ── Install ──",
          "# Linux / macOS:",
          "curl -fsSL https://claude.ai/install.sh | bash",
          "",
          "# Windows (PowerShell):",
          "irm https://claude.ai/install.ps1 | iex",
          "",
          "# ── Authenticate (pick ONE; both are OAuth subscription, NOT API key) ──",
          "",
          "# Pattern A — Desktop with a browser (Windows, macOS, Linux desktop):",
          "claude login",
          "# Opens your default browser, complete OAuth, done.",
          "",
          "# Pattern B — Headless VM (SSH-only, no GUI):",
          "claude setup-token",
          "# Prints a URL. Open on any machine with a browser, complete OAuth,",
          "# paste the returned code back into the VM terminal.",
          "",
          "# ── Verify auth actually works (not just that the binary exists) ──",
          "claude --version",
          "echo hi | claude -p 'say ok'   # should print an assistant reply",
        ],
        note: "SpAIglass looks for the binary at ~/.local/bin/claude on Linux/macOS and %USERPROFILE%\\.local\\bin\\claude.exe on Windows. If `claude -p` fails with 401/403, re-run `claude login` (desktop) or `claude setup-token` (headless) — tokens occasionally expire before paste. Do NOT set ANTHROPIC_API_KEY; SpAIglass uses your OAuth subscription. Do NOT run plain `claude login` on a headless VM expecting it to auth — it needs a TTY and a local browser. Use `claude setup-token` there instead.",
      },
      {
        title: "Install spaiglass on the host (one liner)",
        description:
          'The installer downloads a self-contained binary tarball (~30 MB) from the relay, extracts it under <code>~/spaiglass</code>, writes the <code>.env</code>, and registers a per-user service that launches the backend + relay connector at boot/logon. <strong>Idempotent.</strong> Re-running upgrades in place and preserves the existing <code>.env</code> — if setup failed partway through, you (the agent) can re-run the exact same one-liner with the original <code>--token/--id/--name</code>, or without any flags to refresh from the saved <code>.env</code>.<br><br><strong>Linux gating decision — user lingering (requires sudo).</strong> On Linux, the <code>systemd --user</code> service only survives logout if lingering is enabled for the user, and enabling lingering is a root-only operation. Before running the installer, check whether passwordless sudo is available: <code>sudo -n loginctl enable-linger $USER</code>. If that succeeds silently, you are done — proceed to install. If it fails (prompts for a password or exits non-zero), <strong>stop and ask the human user to run it manually</strong> — without linger the service will die on logout and the VM will appear to "go offline" mysteriously. The installer itself hard-fails on Linux when linger is not set, so there is no way to sleepwalk past this. macOS and Windows have no linger requirement.',
        commands: [
          "# Linux preflight (ask the user to run if this errors):",
          "sudo -n loginctl enable-linger $USER",
          "",
          "# Field mapping — use the EXACT values from Step 3's response:",
          "#   --id=<id from response>       (UUID)",
          "#   --name=<name from response>   (the slug you chose)",
          "#   --token=<token from response> (UUID, shown once)",
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
        note: "Installs a systemd --user unit on Linux, a launchd LaunchAgent on macOS, and a per-user Scheduled Task on Windows. All three start automatically and restart on crash. No inbound ports are opened — the connector dials out over WSS to the relay. If the installer bails on the linger check, fix linger and re-run the same one-liner.\n\nSupported hosts: Linux x64/arm64, macOS x64/arm64, and Windows x64 — five native binaries, no WSL2 required. The PowerShell installer pulls the matching windows-x64 build automatically. Files land under %USERPROFILE%\\spaiglass\\ on Windows (env file: %USERPROFILE%\\spaiglass\\.env).",
      },
      {
        title: "Optional: add a role file to a directory",
        description:
          '<strong>Roles are optional in the Server+Directory model.</strong> A directory without a role works fine — chat uses default Claude Code behavior for that <code>cwd</code>. Add a role when the user wants a persistent persona, a pinned plugin set, or a restricted tool allowlist for that directory. If the user has not asked for one, skip this step — do not hand-craft a role file unprompted.<br><br><strong>When you do add a role:</strong> SpAIglass uses Claude Code\'s native <code>.claude/agents/</code> directory — the same convention the CLI uses with <code>claude --agent &lt;name&gt;</code>. Each <code>.md</code> file becomes a selectable role for that directory in the SpAIglass chat view.<br><br><strong>Fastest path — use the register API.</strong> One POST to the VM\'s local backend creates the directory, role file, Claude config entry, and project metadata directory in one shot. <strong>See <a href="/add-project">Adding Projects &amp; Roles</a> for the endpoint reference.</strong><br><br><strong>Manual path (same result).</strong> If you prefer shell commands, the block below works. After creating the file, restart the spaiglass service (<code>systemctl --user restart spaiglass</code>) so the backend re-scans.<br><br><strong>Start from the baseline.</strong> Do not block on hand-crafting a role. There is a canonical template at <a href="/roletemplate">/roletemplate</a> (raw: <a href="/roletemplate.md"><code>/roletemplate.md</code></a>). Drop it in, finish setup, and then <em>discuss with the human how to improve the role.md</em> during the first real session.',
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
                'Enable/disable plugins for this role: <code>"plugin-name@marketplace": true/false</code>. Parsed from role frontmatter and surfaced in the role editor UI.',
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
          title: "Plugin enablement per role",
          description:
            "SpAIglass parses the <code>enabledPlugins</code> map from each role's frontmatter and surfaces it in the role editor UI. Sessions for all roles currently share the host's <code>~/.claude/</code> config — per-role plugin settings aren't physically isolated yet, so if two roles enable conflicting plugins, the last-written settings win. Keep plugin sets aligned across roles on the same project for now.",
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
        title: "Managing the Directory dropdown (hide / add / rename)",
        description:
          'The Directory dropdown in the SpAIglass chat header is a live view of Claude Code\'s <code>~/.claude.json</code> <code>projects</code> map on this VM — SpAIglass does not maintain its own separate list. To change what the human sees in the dropdown, mutate <code>~/.claude.json</code> via the three VM-local endpoints below. The user will typically ask you in chat (e.g. <em>"hide the workspace directory"</em>, <em>"add ~/code/foo"</em>, <em>"rename that one to Acme API"</em>) — make the matching API call and confirm. The next page reload on the user\'s side picks up the change; no restart needed.<br><br><strong>Hide a directory</strong> — removes the entry from <code>~/.claude.json</code> but keeps its encoded session history on disk, so re-registering later restores prior chats.<br><br><strong>Add a directory</strong> — the same <code>register</code> endpoint used at setup time. Role is optional in the Server+Directory model; pass <code>{"name": "..."}</code> alone to just create the directory entry.<br><br><strong>Rename (cosmetic label only)</strong> — the directory\'s real path never changes; this just overrides the display name in the dropdown.<br><br>These calls are VM-local (<code>127.0.0.1:8080</code>) and require no auth — only the VM-side agent can reach them.',
        commands: [
          "# ── Hide a directory from the dropdown ──",
          "curl -s -X POST http://127.0.0.1:8080/api/projects/unregister \\",
          "  -H 'Content-Type: application/json' \\",
          "  -d '{\"path\": \"/home/user/workspace\"}'",
          "# → {\"ok\":true,\"removed\":true,\"path\":\"/home/user/workspace\"}",
          "# Idempotent: removed:false if the path was not registered.",
          "",
          "# ── Add a directory to the dropdown ──",
          "curl -s -X POST http://127.0.0.1:8080/api/projects/register \\",
          "  -H 'Content-Type: application/json' \\",
          "  -d '{\"name\": \"foo\"}'            # ~/projects/foo, no role",
          "",
          "# Add with an explicit absolute path (anywhere on disk):",
          "curl -s -X POST http://127.0.0.1:8080/api/projects/register \\",
          "  -H 'Content-Type: application/json' \\",
          "  -d '{\"name\": \"foo\", \"path\": \"/home/user/code/foo\"}'",
          "",
          "# ── Rename the dropdown label (cosmetic) ──",
          "# `project` is the directory basename (e.g. 'foo' for /home/user/code/foo),",
          "# NOT the full path. Pass displayName:null to clear the override.",
          "curl -s -X PUT http://127.0.0.1:8080/api/settings/project-display-name \\",
          "  -H 'Content-Type: application/json' \\",
          "  -d '{\"project\": \"foo\", \"displayName\": \"Acme API\"}'",
          "",
          "# ── See what is currently in the dropdown ──",
          "curl -s http://127.0.0.1:8080/api/projects | jq",
        ],
        note: "These mutate ~/.claude.json directly. Hide preserves session transcripts under ~/.claude/projects/<encoded>/ so re-adding the same path restores history. Directories under ~/spaiglass, ~/.spaiglass, and ~/.claude are filtered from the dropdown automatically — do not try to hide those, they are already invisible.",
      },
      {
        title: "Verify the setup actually works",
        description:
          'Do NOT trust \"installer exited 0\" as proof of working. The service can fail to start, the connector token can be wrong, linger can silently revert — all of which leave the installer happy but the VM absent from the fleet.<br><br><strong>1. Relay health (public).</strong> <code>GET ' +
          PUBLIC_URL +
          '/api/health</code> — returns <code>{"status":"ok", "spaiglassVersion":"..."}</code>. No auth required. Confirms the relay is reachable from wherever you are calling from.<br><br><strong>2. Connector online (authenticated).</strong> <code>GET ' +
          PUBLIC_URL +
          '/api/connectors</code> and look for your <code>id</code> with <code>online: true</code>. If <code>online: false</code> 30 seconds after the installer finished, the service did not attach — see troubleshooting.<br><br><strong>3. Project visible (on the VM).</strong> <code>GET http://127.0.0.1:8080/api/projects</code> on the VM itself should return the project you just registered. If it does not, either the backend is not running on port 8080 or the project was written to the wrong directory.<br><br><strong>4. Directory has a resolvable role.</strong> <code>GET http://127.0.0.1:8080/api/roles?path=&lt;projectPath&gt;</code> must return a non-empty <code>roles</code> array. The backend session store is keyed by <code>(projectPath, roleFile)</code> — a directory with zero role files cannot start a session even though chat URLs resolve and the connector looks online. The browser\'s role-less URL flow (<code>/vm/&lt;server&gt;/&lt;directory&gt;/</code>) auto-picks <code>developer.md</code> if present, else the first available file; if the list is empty, chat silently dies at session_start. If this check returns <code>{ "roles": [] }</code>, either (a) call <code>POST /api/projects/register</code> with a <code>role</code> name to create one, or (b) drop <code>/roletemplate.md</code> into <code>&lt;projectPath&gt;/.claude/agents/developer.md</code> and re-run the check.<br><br><strong>5. Installed CONNECTOR_ID matches the one you just registered.</strong> Read <code>CONNECTOR_ID</code> from <code>~/spaiglass/.env</code> on the VM and compare it to the <code>id</code> returned by Step 3\'s <code>POST /api/connectors</code>. <strong>They must be the same UUID.</strong> If they differ, the installer was run with flags from a <em>previous</em> registration, leaving the connector you just created as an orphan (visible in <code>GET /api/connectors</code>, permanently <code>online: false</code>, never seen by the relay) while the service is actually authenticated as a different one. Fix by calling <code>DELETE /api/connectors/:id</code> on the orphan — do not leave it in the fleet, it shows up in every user\'s dropdown as a broken server.<br><br><strong>6. No other orphaned connectors for this host.</strong> List owned connectors via <code>GET /api/connectors</code> and inspect any entry with <code>online: false</code> AND a <code>lastSeen</code> either <code>null</code> or older than 24h. If more than one owned connector is authenticated-but-silent and they plausibly map to the same VM (same display name stem, same human&rsquo;s machine), they are leftovers from a prior failed setup. <strong>One machine should equal one connector</strong> — duplicate registrations fracture the recent-URL list in the UI and make the dropdown surface dead entries. Delete the orphans with <code>DELETE /api/connectors/:id</code>; the live service keeps working because its token points at the row you are keeping.<br><br>Only after all six pass should you report "setup complete" to the human.',
        commands: [
          "# From anywhere (no auth):",
          "curl -fsSL " + PUBLIC_URL + "/api/health | jq",
          "",
          "# With your agent key (confirm connector is online):",
          "curl -fsSL -H 'Authorization: Bearer sg_YOUR_KEY' \\",
          "     " + PUBLIC_URL + "/api/connectors \\",
          "  | jq '.[] | select(.id==\"YOUR_CONNECTOR_ID\") | {name, online, spaiglassVersion}'",
          "",
          "# On the VM (confirm project was registered):",
          "curl -fsSL http://127.0.0.1:8080/api/projects | jq",
          "",
          "# On the VM (confirm the directory has at least one role file —",
          "# chat silently dies at session_start if this list is empty):",
          "curl -fsSL 'http://127.0.0.1:8080/api/roles?path=/home/USER/projects/myproject' \\",
          "  | jq '.roles | length'   # must be >= 1",
          "",
          "# Fix pattern if gate 4 fails — delete bad role + re-add. On the VM:",
          "#   curl -X DELETE 'http://127.0.0.1:8080/api/roles/<name>?path=<project>'",
          "#   curl -X POST   'http://127.0.0.1:8080/api/roles?path=<project>' \\",
          "#        -H 'Content-Type: application/json' \\",
          "#        -d '{\"name\":\"developer\",\"description\":\"...\"}'",
          "",
          "# On the VM (confirm the installer actually wired up the connector",
          "# you just registered — mismatch = orphan row in the relay DB):",
          "grep '^CONNECTOR_ID=' ~/spaiglass/.env",
          "# The UUID printed here MUST equal the `id` from Step 3's response.",
          "",
          "# Orphan sweep — any owned connector that never came online, or",
          "# last saw the relay >24h ago, that maps to this same host is dead",
          "# weight in the dropdown. Delete each one with:",
          "#   curl -X DELETE -H 'Authorization: Bearer sg_YOUR_KEY' \\",
          "#        " + PUBLIC_URL + "/api/connectors/<ORPHAN_ID>",
          "curl -fsSL -H 'Authorization: Bearer sg_YOUR_KEY' \\",
          "     " + PUBLIC_URL + "/api/connectors \\",
          "  | jq '.[] | select(.online==false and (.lastSeen==null or (now - (.lastSeen/1000) > 86400))) | {id, name, displayName, lastSeen}'",
        ],
        note: "If any of the six checks fail, stop and consult the troubleshooting section — do not ship an unverified setup. Check #4 catches the \"everything looks green but first message never gets a reply\" failure mode (online connector, registered project, but no role file so session_start rejects). Check #5 catches the \"running service authenticates as connector X while the agent thought it set up connector Y\" split — the .env is authoritative for which row is live, anything else with the agent's user_id is dead weight. Check #6 catches older orphans from prior setup attempts — one machine equals one connector, and duplicates surface in the fleet dropdown as permanently-offline servers users keep clicking.",
      },
      {
        title: "Add architecture.json (strongly recommended)",
        description:
          '<strong>Do not skip this step.</strong> <code>architecture/architecture.json</code> is the single most valuable artifact you will produce during setup. It is an <em>operational snapshot</em> of the project — when Claude (or a human returning after months away) opens a session, the Arch button renders this file and gives them full mental context without reading code. A project without one is a project every new session re-discovers from scratch.<br><br>Pick one of the two paths below based on how much the user has ready right now:<br><br><strong>Path A — Quick start (≈5 minutes).</strong> Use the minimal template below. Fills components, connections, and infrastructure with placeholder values the user can refine later. Good when the user wants to move on to chat and promises to improve the file "soon". Set the expectation: this unblocks the Arch button but produces a <em>breadcrumb</em>, not an operational document. Schedule a follow-up to graduate it to Path B within the week.<br><br><strong>Path B — Comprehensive (recommended; ≈30-60 minutes).</strong> <strong>Fetch the full manual first</strong> at <a href="/api/architecture-manual"><code>' +
          PUBLIC_URL +
          '/api/architecture-manual</code></a> (raw markdown; easy to parse) and read it <em>end-to-end before writing any field</em>. The manual lays out the eight non-negotiable rules — snapshot over design doc, measured status with <code>statusSource</code>, complete site map including orphans, redacted secrets preserving shapes, etc. Then generate the manifest by observing the running system (code at HEAD, running processes, the DB, URLs that actually respond), not by reading README. <strong>This is the default path; only fall back to Path A if the user explicitly opts for the quick start.</strong>',
        commands: [
          "mkdir -p ~/projects/myproject/architecture",
          "",
          "# ── Path B: Fetch the manual (READ END-TO-END before writing) ──",
          "curl -fsSL " + PUBLIC_URL + "/api/architecture-manual -o /tmp/architecture-manual.md",
          "# Manual is ~5 pages of core rules + reference appendix. Do not skim.",
          "",
          "# After reading, generate architecture.json from OBSERVATION:",
          "#   git rev-parse HEAD                 # code as checked out",
          "#   systemctl --user list-units         # processes actually running",
          "#   psql -c '\\d'  /  mongosh --eval ... # DB as it currently exists",
          "#   curl -sSf <public-url>              # routes that actually respond",
          "#   du -sh / ls                         # filesystem as it currently exists",
          "# Write the manifest as a SNAPSHOT, not a design doc.",
          "",
          "# ── Path A: Quick-start minimal template (placeholder only) ──",
          "# Use only if the user explicitly opted out of the comprehensive path.",
        ],
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
                statusSource: {
                  command: "systemctl --user is-active myproject-api",
                  output: "active",
                  observedAt: "2026-04-20T00:00:00Z",
                },
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
        note: "Save at ~/projects/myproject/architecture/architecture.json. The Arch button in the chat UI renders this file; without it, Arch links here. Path A is a placeholder — it unblocks the Arch button but does not substitute for Path B. The manual explains why shallow manifests are worse than no manifest.",
      },
    ],
    addMoreVms:
      "The agent key is reusable. To add another VM, repeat steps 2-4 with the same key — each VM gets its own connector token. Mix and match Linux, macOS, and Windows hosts under the same account.",
    configuring: {
      title: "Configuring SpAIglass (day-2 operations)",
      summary:
        'SpAIglass is a browser UI for Claude Code — it does not launch Claude for the user, and it never asks the user about "absolute paths" or "relay vs VM". When the user says <em>"rename my server to Foo"</em> or <em>"add ~/code/bar to my directory list"</em>, you (the install agent on this VM) make the API call on their behalf. Confirm the plain-English settings you are about to change before firing, then do it. Never instruct the user to reinstall to make a change.',
      vocab: [
        {
          term: "Server Display Name",
          scope:
            "Top-left server name on the chat page, Server dropdown entries, Server segment of the 'last used' buttons, Agent Picker on mobile. Cosmetic — the real connector slug in the URL does not change.",
          editableBy: "User via Settings wheel OR agent via relay API.",
        },
        {
          term: "Project Directory Display Name",
          scope:
            "Top-left project label on the chat page, Directory dropdown entries (shown as '<Display Name> — <working directory>'), Agent Picker on mobile. Cosmetic — the real filesystem path does not change.",
          editableBy: "User via Settings wheel OR agent via VM-local API.",
        },
        {
          term: "Project Directory Tab Name",
          scope:
            "Browser tab title (and therefore the text saved when the user bookmarks the page). Falls back to Project Directory Display Name, then to the directory basename. Nothing in-app uses this string.",
          editableBy: "User via Settings wheel OR agent via VM-local API.",
        },
        {
          term: "Working Directory (real)",
          scope:
            "The absolute path on the VM's filesystem, used as Claude Code's cwd for the session. Appears top-left of the chat page alongside the Display Name, and on every Directory dropdown entry. This never changes via a rename — only via unregister + re-register.",
          editableBy: "Agent only, via register/unregister. No UI path.",
        },
        {
          term: "Connector Slug (real)",
          scope:
            "The segment in the URL /vm/<login>.<slug>/. Stable identity. Changing it invalidates bookmarks and saved 'last used' entries.",
          editableBy: "Agent only, via installer; never via UI.",
        },
      ],
      playbook: [
        {
          userAsks:
            '"Rename this server to X" / "Change my server name to X" / "Call this server X"',
          confirmBefore:
            'Read back: "I\'ll change the Server Display Name to X. The URL and bookmarks stay the same. OK to proceed?"',
          api: {
            method: "PUT",
            url: PUBLIC_URL + "/vm/<slug>/api/__relay/self/display-name",
            body: '{ "displayName": "X" }',
            auth: "Owner-only — must be called from a session that owns the connector. The VM-side agent can curl this with the user's relay cookie or agent key.",
          },
          consequences:
            "Cosmetic. No session history lost. No re-sign-in needed. Dropdown updates on next page refresh.",
          clearOverride: 'Pass { "displayName": null } to revert to the raw slug.',
        },
        {
          userAsks:
            '"Rename this directory to X" / "Call this folder X in the dropdown"',
          confirmBefore:
            'Read back: "I\'ll change the Project Directory Display Name for <basename> to X. The real path <path> does not change. OK?"',
          api: {
            method: "PUT",
            url: "http://127.0.0.1:8080/api/settings/project-display-name",
            body: '{ "project": "<directory basename>", "displayName": "X" }',
            auth: "VM-local — no auth. Only callable from inside the VM.",
          },
          consequences:
            "Cosmetic. No session history lost. Dropdown + top-left label update on refresh.",
          clearOverride: 'Pass displayName:null to revert to the basename.',
        },
        {
          userAsks:
            '"Change the browser tab title to X" / "I want the tab to say X when I\'m on this project"',
          confirmBefore:
            'Read back: "I\'ll change the Project Directory Tab Name for <basename> to X. That only affects the browser tab title, nothing else. OK?"',
          api: {
            method: "PUT",
            url: "http://127.0.0.1:8080/api/settings/project-directory-tab-name",
            body: '{ "project": "<directory basename>", "tabName": "X" }',
            auth: "VM-local — no auth.",
          },
          consequences:
            "Cosmetic. Tab title updates on next navigation / refresh.",
          clearOverride:
            'Pass tabName:null to fall back to the Display Name (and then to the basename).',
        },
        {
          userAsks:
            '"Add <directory> to my dropdown" / "Put ~/code/foo in the picker"',
          confirmBefore:
            'Read back: "I\'ll add <resolved absolute path> to your Directory dropdown. It\'ll show up with the label \'<basename>\' unless you want a different Display Name. OK?" If the path does not exist yet, say so — do not silently create a stray directory far from where the user meant.',
          api: {
            method: "POST",
            url: "http://127.0.0.1:8080/api/projects/register",
            body:
              '{ "name": "<basename>" }  // or { "name":"foo", "path":"/home/user/code/foo" } for an explicit path\n' +
              '// role is optional; include { "role": "<name>" } only if the user asked for a persona',
            auth: "VM-local — no auth.",
          },
          consequences:
            "No session history touched. Dropdown updates on next page refresh. If a hidden entry for the same path existed before, prior session transcripts under ~/.claude/projects/<encoded>/ are restored automatically.",
        },
        {
          userAsks:
            '"Hide <directory>" / "Remove <directory> from the dropdown" / "I don\'t want to see <directory> in the picker"',
          confirmBefore:
            'Read back: "I\'ll remove <absolute path> from your Directory dropdown. Session transcripts stay on disk, so if you change your mind later I can re-add it and your history comes back. OK?"',
          api: {
            method: "POST",
            url: "http://127.0.0.1:8080/api/projects/unregister",
            body: '{ "path": "<absolute path exactly as in ~/.claude.json>" }',
            auth: "VM-local — no auth.",
          },
          consequences:
            "Dropdown entry disappears on next page refresh. Session transcripts under ~/.claude/projects/<encoded>/ are preserved. Idempotent: removing an already-removed path returns removed:false.",
        },
        {
          userAsks:
            '"What\'s in my Directory dropdown?" / "List my directories" / "Show me my registered paths"',
          confirmBefore: "Read-only. No confirmation needed.",
          api: {
            method: "GET",
            url: "http://127.0.0.1:8080/api/projects",
            body: "(none)",
            auth: "VM-local — no auth.",
          },
          consequences:
            "Returns { projects: [{ path, encodedName }] }. The path is the real filesystem directory; the dropdown shows it with any Display Name override applied on top.",
        },
        {
          userAsks:
            '"What Project Directory Display Names are set?" / "Which directories have custom names?"',
          confirmBefore: "Read-only. No confirmation needed.",
          api: {
            method: "GET",
            url: "http://127.0.0.1:8080/api/settings/project-display-names",
            body: "(none)",
            auth: "VM-local — no auth.",
          },
          consequences:
            "Returns { displayNames: { '<basename>': '<label>' } }. Only directories with an override appear — absence means 'using the directory basename'. Pair this with /api/projects to report full state.",
        },
        {
          userAsks:
            '"What Project Directory Tab Names are set?" / "Which directories have custom browser tab titles?"',
          confirmBefore: "Read-only. No confirmation needed.",
          api: {
            method: "GET",
            url: "http://127.0.0.1:8080/api/settings/project-directory-tab-names",
            body: "(none)",
            auth: "VM-local — no auth.",
          },
          consequences:
            "Returns { tabNames: { '<basename>': '<tab title>' } }. Only directories with an override appear — absence means 'falls back to Project Directory Display Name, then to basename'.",
        },
        {
          userAsks:
            '"What\'s THIS server\'s name?" / "What connector am I on?" / "What is my Server Display Name?" / "List ALL my servers" / "Show my whole fleet"',
          confirmBefore:
            'Read-only, but needs an agent key (sg_...) — even to read THIS server\'s own Server Display Name, because there is no VM-local endpoint for it. If you do not already have one on disk, ask the user: "To read your Server Display Name (this server or any other) I need an agent key. You can mint one at ' +
            PUBLIC_URL +
            "/dashboard (Agent Keys → New). Paste it here and I won't store it beyond this session.\" If they decline, you can still read Project Directory info (reads above) and tell the user the Server Display Name requires an agent key to fetch.",
          api: {
            method: "GET",
            url: PUBLIC_URL + "/api/connectors",
            body: "(none)",
            auth:
              "Authorization: Bearer sg_<agent-key>. A CONNECTOR_TOKEN (the one in ~/spaiglass/.env) is NOT the same thing and will 401 here.",
          },
          consequences:
            "Returns an array of connectors the user owns: [{ id, name (slug), displayName, customDisplayName, online, spaiglassVersion, ... }]. Each id can be passed to DELETE /api/connectors/<id> or PATCH-equivalents.",
        },
        {
          userAsks:
            '"What\'s my full configuration?" / "Give me a report of everything (every server AND every directory on every server)"',
          confirmBefore:
            "Read-only. An agent key (sg_...) is required to enumerate servers and to reach OTHER servers\u2019 directories. If you do not already have one, mint one via Step 2 of this guide (POST /api/auth/token-exchange) — the same key works for every read below. Without a key you can only report the three VM-local reads for THIS server.",
          api: {
            method: "GET (multi) — do this in two passes",
            url:
              "Pass 1 — enumerate the fleet (one call):\n" +
              "  " +
              PUBLIC_URL +
              "/api/connectors\n" +
              "  \u2192 gives you every connector\u2019s slug (`name`) and Server Display Name (`displayName`).\n\n" +
              "Pass 2 — for EACH connector slug from Pass 1, call ONE combined endpoint that proxies through that VM\u2019s connector tunnel and returns its directories with Display Name AND Tab Name already merged:\n" +
              "  " +
              PUBLIC_URL +
              "/vm/<any-online-slug>/api/__relay/fleet/<targetSlug>/roles\n" +
              "  \u2192 response includes `directories: [{ name, path, displayName, tabName, ... }]`.\n\n" +
              "Notes:\n" +
              "  \u2022 `<any-online-slug>` is just the slug you are routed through — use your current VM\u2019s slug (e.g. `<login>.<your-connector>`). The `<targetSlug>` is the connector you want to read (bare name is fine).\n" +
              "  \u2022 The target VM must be online (its connector tunnel must be attached). If `directories` comes back empty AND the connector is listed as offline in Pass 1, report it as offline — don\u2019t claim zero directories.\n" +
              "  \u2022 For THIS server only (no agent key, no fleet-wide read), fall back to the three VM-local endpoints listed above.",
            body: "(none)",
            auth:
              "Both passes: Authorization: Bearer sg_<agent-key>. Same key for all calls.",
          },
          consequences:
            "Output format to send back to the user — one block per server:\n\nServer: <Server Display Name> (slug <slug>, <online|offline>)\n  Directories:\n    - <Project Directory Display Name or basename> \u2014 <working directory path> [Tab: <Project Directory Tab Name or \u201cdefault\u201d>]\n    - ...\n\nAlways use the plain-English field names (Server Display Name, Project Directory Display Name, Project Directory Tab Name) when speaking to the user. If a field is unset, say \u201cdefault\u201d rather than \u201cnull\u201d.",
        },
        {
          userAsks:
            '"Run SpAIglass doctor" / "Audit my config" / "What\u2019s wrong with my setup?" / "Check everything"',
          confirmBefore:
            "Read-only audit. No confirmation needed to RUN. If you plan to act on any issue, stop and confirm with the human first — doctor reports issues, it does not auto-fix them.",
          api: {
            method: "GET",
            url:
              "Two scopes:\n" +
              "  \u2022 Just THIS VM:  http://127.0.0.1:8080/api/doctor  (no auth, loopback)\n" +
              "  \u2022 Whole fleet:   " +
              PUBLIC_URL +
              "/vm/<any-online-slug>/api/__relay/doctor  (agent key; fans out to every online connector you can see)",
            body: "(none)",
            auth:
              "VM-local: no auth. Fleet-wide: Authorization: Bearer sg_<agent-key>.",
          },
          consequences:
            "Response shape (VM-local): { ok, checkedAt, counts, issues:[{ id, code, severity, message, details, fixable, fixHint }] }. Fleet-wide wraps that as { servers:[{ server:{slug, displayName, online, role}, issues, counts }] }. Checks in v1: directory.missing (registered path gone from disk), directory.duplicate-case (two entries differ only in case), directory.home-root ($HOME registered as a project — usually accidental), displayName.orphan / tabName.orphan (override for a basename that isn\u2019t registered anymore). severity is info | warn | error. Offline servers are returned with issues=[] and skipped='offline'. Report issues grouped by server, in severity order, and for each one read the `message` verbatim plus the `fixHint` — then ASK the human before touching anything.",
        },
        {
          userAsks:
            '"Add another server" / "I want to connect my laptop too"',
          confirmBefore:
            'The user adds servers by running the installer on the new machine. Do NOT try to add a server from this VM. Tell them: "Adding a server is a one-shot installer you run on the new machine itself. I can\'t do it from this VM. Open ' +
            PUBLIC_URL +
            '/setup on the new machine and follow the installer step — or I can give you the exact one-liner for your OS."',
          api: {
            method: "N/A",
            url: "(installer only — runs on the target machine)",
            body: "(see the 'Install the connector' step in this guide)",
            auth: "Agent key + connector token generated during install.",
          },
          consequences:
            "Creates a new connector row in the relay DB. Does not touch this VM.",
        },
        {
          userAsks:
            '"Remove this server" / "Delete this connector" / "Take this VM out of my fleet"',
          confirmBefore:
            'This is destructive on the relay side. Read back exactly: "Removing this server unlists it from your Server dropdown and ends this connector\'s ability to attach. Nothing on the VM itself is deleted. If you later reinstall with the same name you\'ll get a fresh connector — old session history stays on disk here regardless. Proceed?"',
          api: {
            method: "DELETE",
            url: PUBLIC_URL + "/api/connectors/<connector-id>",
            body: "(none)",
            auth: "Owner-authenticated via relay session / agent key.",
          },
          consequences:
            "Relay row removed; this VM can no longer attach as that connector. Local files, ~/.claude.json, and session transcripts are untouched. Users will need to sign in again only if their session was pinned to this connector.",
        },
      ],
      agentRules: [
        'Use the user-facing names — "Server Display Name", "Project Directory Display Name", "Project Directory Tab Name" — when you confirm changes. Do not say "connector display name" or "basename override".',
        "Never require or request a reinstall to change a name. All renames are API calls.",
        "Never ask the user for absolute paths, `~/.claude.json` keys, or connector IDs. You are on the VM — look them up yourself (GET /api/projects for paths, relay GET /api/connectors for IDs).",
        "Confirm the plain-English setting you are about to change before firing, in one sentence. Do not dump curl output at the user mid-confirmation.",
        "After a change, report what you did in plain English and mention the user may need to refresh the page for the UI to pick it up.",
        "If a user asks for something the UI already exposes (Settings wheel for the three display fields), you may do it via the API OR point them at the Settings wheel — either is fine. Pick whichever is faster in context. For anything structural (add/remove directory, add/remove server), always do it via API; the UI no longer exposes those.",
      ],
    },
    troubleshooting: {
      summary:
        "If you are an agent and a setup step failed, match the symptom here before guessing. These are the real failure modes we have seen — fix the root cause, do not paper over it with retries or SQL.",
      entries: [
        {
          symptom: "POST /api/auth/token-exchange → 401 Invalid GitHub token",
          causes: [
            "PAT expired, revoked, or never had the right scope. Classic PATs need no scopes (the relay only reads /user). Fine-grained PATs need 'Account permissions → Read profile data'.",
            "You pasted the token with surrounding whitespace or quotes — check for trailing \\n.",
          ],
          fix: "Ask the human for a fresh PAT (or switch to Option B — send them to PUBLIC_URL/ and have them hand you the one-shot token). Do not retry with the same PAT expecting a different result.",
        },
        {
          symptom: "POST /api/connectors → 401 Unauthorized",
          causes: [
            "Missing or malformed Authorization header.",
            "Agent key was deleted, or you are hitting the wrong relay.",
          ],
          fix: "Confirm the header is exactly `Authorization: Bearer sg_...` (no quotes, no leading 'Bearer:'). Run GET /api/auth/me with the same key — if that also 401s, the key is dead; mint a new one via token-exchange.",
        },
        {
          symptom: "POST /api/connectors → 409 You already have a connector named '…'",
          causes: ["You skipped Step 1 and registered a duplicate of a connector you already own."],
          fix: "Use the existing connector from GET /api/connectors (the response body includes its id). If the name is wrong, PATCH it — do not create a second one.",
        },
        {
          symptom: "POST /api/connectors → 400 'name' contains reserved slug / control chars / invalid format",
          causes: ["Name picked a reserved route prefix (api, vm, setup, auth, install, ...) or contains disallowed characters."],
          fix: "Rename with only [A-Za-z0-9._-], starting alphanumeric, ≤100 chars. Examples that work: 'production-vm', 'dev.alice', 'Staging_2'.",
        },
        {
          symptom: "Installer exits 0 but GET /api/connectors shows online: false",
          causes: [
            "systemd --user linger is off (service dies at logout). Installer should have hard-failed on this but check `loginctl show-user $USER | grep Linger`.",
            "CONNECTOR_TOKEN in ~/spaiglass/.env does not match the token shown at create time.",
            "Backend crashed at startup — check `systemctl --user status spaiglass` and `journalctl --user -u spaiglass -n 50`.",
          ],
          fix: "Enable linger (`sudo loginctl enable-linger $USER`), verify the token in .env matches the one from POST /api/connectors, then `systemctl --user restart spaiglass` and re-check GET /api/connectors. If the token really is lost, DELETE the connector and POST a new one — do not edit the DB.",
        },
        {
          symptom: "POST http://127.0.0.1:8080/api/projects/register → connection refused",
          causes: [
            "The local backend is not running (service failed to start).",
            "PORT in the .env was changed from 8080 and you are hitting the wrong port.",
          ],
          fix: "Check `systemctl --user status spaiglass`, start/restart it, and confirm PORT in ~/spaiglass/.env. The local backend is what hosts the project-register endpoint — it is NOT served by the relay.",
        },
        {
          symptom: "Human signs in at PUBLIC_URL but lands on /fleetrelay instead of their VM",
          causes: ["No connectors exist yet for this user (fresh account, or they deleted them all)."],
          fix: "This is the expected empty-state page — it carries a one-shot sg_ token for you to use in Option A. Complete Steps 2-4 to register their first VM; next sign-in will route them to chat.",
        },
      ],
    },
    fleetManagementApi: {
      summary:
        "After initial setup, the connector fleet is managed entirely through the relay API. If the API cannot express an operation you need, update the API — never edit the relay database directly. Every endpoint below requires `Authorization: Bearer sg_YOUR_KEY` and operates on connectors owned by the caller.",
      endpoints: [
        {
          method: "GET",
          path: "/api/connectors",
          purpose:
            "List all connectors owned by the caller, plus any shared with them. Returns `{ id, name, displayName, role, online, lastSeen, createdAt, spaiglassVersion }` per connector. Use this as the source of truth for what's in the fleet — it is what the fleet dropdown reads.",
        },
        {
          method: "POST",
          path: "/api/connectors",
          purpose:
            "Register a new connector. Body: `{ \"name\": \"my-vm\" }`. Returns `{ id, name, token, ... }`; the raw token is shown once — store it, then supply it to the VM installer. Preferred over any manual DB entry.",
        },
        {
          method: "PATCH",
          path: "/api/connectors/:id",
          purpose:
            "Update a connector. Body accepts `displayName` (free-form label) and/or `name` (slug — changes /vm/<login>.<name>/ URL). Both preserve the connector id and token, so the VM-side connector keeps its existing .env and does NOT need reconfiguration. Use this to rename — never rename via SQL.",
        },
        {
          method: "DELETE",
          path: "/api/connectors/:id",
          purpose:
            "Remove a connector. Disconnects the live tunnel if the VM is online and deletes the connector record. The VM-side spaiglass service will fail to reauth until you POST a replacement and update its .env with the new token/id.",
        },
        {
          method: "GET",
          path: "/api/connectors/:id/config",
          purpose:
            "Download a .env scaffold for the connector (the raw token is NOT embedded — tokens are hashed at rest; you must keep your own copy from the create call).",
        },
        {
          method: "GET / POST / PATCH / DELETE",
          path: "/api/connectors/:id/collaborators[/:userId]",
          purpose:
            "Share a connector with another signed-in spaiglass user at role `editor` or `viewer`. Owner-only except for GET, which any collaborator can call to see who else has access.",
        },
        {
          method: "PUT",
          path: "/api/connectors/:id/labels",
          purpose:
            "Set or clear a custom human-readable label for a role file on this connector. Owner only. Use this instead of renaming role files on disk when a human wants a friendlier name in the UI.",
        },
      ],
      principles: [
        "Use the API, not the DB. If the API cannot express an operation, the correct fix is to add/extend the endpoint — not to run SQL against /opt/sgcleanrelay/relay.db.",
        "Renames preserve identity. `PATCH /api/connectors/:id` with `{ name }` keeps the same id and token — the VM-side connector keeps working. The customer agent does not need to restart or reconfigure the service.",
        "Tokens are held by the customer. The connector token lives in the VM's .env (`CONNECTOR_TOKEN`). The relay stores only the SHA-256 hash. Treat the customer-side .env as the authoritative source.",
        "The fleet dropdown reflects `GET /api/connectors`. If something looks wrong in the fleet list, verify against this endpoint first — that is the user-facing registry.",
      ],
    },
    shortcut:
      "If you already have a token/id/name from a previous registration, skip straight to the install step.",
    finalStep: {
      title: "Tell the human user you're done",
      description:
        "Report success ONLY after the <strong>full six-gate integrity check</strong> passed (see step \"Verify the setup actually works\"). All six gates must be green: relay health, <code>online: true</code> for the connector, project visible in <code>/api/projects</code>, at least one role file via <code>/api/roles?path=…</code>, <code>CONNECTOR_ID</code> in <code>~/spaiglass/.env</code> matches the id you registered in Step 3, and no orphan connectors left behind for this host. <strong>Running the integrity check is not optional — it is the contract that separates a finished setup from a broken one that only looks finished.</strong> If any gate fails, do not declare success; fix it (delete orphans with <code>DELETE /api/connectors/:id</code>, add a role file, re-run the installer, etc.) and re-run the check until every gate is green. Once verified, tell the human: \"Setup complete. Go to " +
        PUBLIC_URL +
        " and sign in with GitHub — you'll land directly in your chat.\" They do not need a URL, a VM name, or a role name; sign-in routes them to the right place automatically. Do not construct or share <code>/vm/&lt;login&gt;.&lt;vm&gt;/</code> URLs — that detail is now internal. If something failed partway through, say so plainly and tell the user what you need from them (typically: `sudo loginctl enable-linger $USER`, then re-run the install one-liner).",
    },
    features: [
      "Server + Directory picker — one connector per machine, many directories per server, role is optional",
      "Rich session picker — first-message intent, turn counts, files touched, model, and duration for every past session",
      "Chat with Claude Code from any browser — laptop, phone, tablet",
      "Directory file browser — see and edit your files while you chat",
      "Markdown editor — Monaco-powered, syntax highlighted, Ctrl+S to save",
      "Six themes including 70s amber/green CRT phosphor + corporate plain",
      "Optional roles — define agent personas per directory via .claude/agents/*.md files",
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

<div class="card" style="border-left: 4px solid #dc2626; background: #fef2f2;">
  <h3 style="margin-top: 0; color: #991b1b;">&#9888; Integrity check is mandatory &mdash; this is the single most important best practice in this guide</h3>
  <p style="margin: 8px 0;">Every setup you perform MUST end with the full integrity check in the "Verify the setup actually works" step below. <strong>Do not declare success until all six gates are green.</strong> A setup where the installer exited 0 and the connector shows online can still be silently broken &mdash; the failure modes the gates catch are real ones we have shipped to users:</p>
  <ul style="margin: 8px 0 8px 20px; font-size: 0.95em; color: #7f1d1d;">
    <li><strong>Orphan connectors</strong> &mdash; the installer wired up a different connector than the one you just registered, leaving a permanently-offline row in every user's dropdown</li>
    <li><strong>Role-less dead chats</strong> &mdash; the directory has no <code>agents/*.md</code>, so <code>session_start</code> rejects every message while the UI looks connected</li>
    <li><strong>Duplicate-VM fleet pollution</strong> &mdash; leftovers from prior setup attempts masquerading as separate servers in the dropdown</li>
  </ul>
  <p style="margin: 8px 0 0; font-size: 0.9em; color: #7f1d1d;">Integrity-check failures are not optional to investigate. If you skip them, the user will come back with "it doesn't work" and neither of us will know where the break is. <strong>Run all six checks, paste the jq output if anything looks off, and fix before reporting done.</strong></p>
  <p style="margin: 10px 0 4px; font-size: 0.92em; color: #7f1d1d;"><strong>Universal fix pattern:</strong> <em>delete bad record + re-add correctly</em>. Every configurable surface supports it:</p>
  <ul style="margin: 4px 0 8px 20px; font-size: 0.9em; color: #7f1d1d;">
    <li>Connector: <code>DELETE /api/connectors/:id</code> then <code>POST /api/connectors</code></li>
    <li>Role file: <code>DELETE /api/roles/:name?path=X</code> then <code>POST /api/roles?path=X</code></li>
    <li>Project entry: <code>POST /api/projects/unregister</code> then <code>POST /api/projects/register</code> (idempotent)</li>
  </ul>
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
    <li><strong>Server + Directory picker</strong> — one connector per machine, many directories per server, role is optional</li>
    <li><strong>Rich session picker</strong> — first-message intent, turn counts, files touched, model, and duration for every past session</li>
    <li><strong>Chat with Claude Code</strong> from any browser — laptop, phone, tablet</li>
    <li><strong>Directory file browser</strong> — see and edit your files while you chat</li>
    <li><strong>Markdown editor</strong> — Monaco-powered, syntax highlighted, Ctrl+S to save</li>
    <li><strong>Six themes</strong> including 70s amber/green CRT phosphor and corporate plain</li>
    <li><strong>Optional roles</strong> — define agent personas per directory via .claude/agents/*.md files</li>
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

<div class="card" style="border-left: 4px solid #8b5cf6;">
  <h3 style="margin-top: 0;">${data.model.title}</h3>
  <p>${data.model.summary}</p>
  <ul>${data.model.points.map((p) => `<li style="margin-bottom: 8px;">${p}</li>`).join("")}</ul>
</div>

${stepsHtml}

<div class="card" style="border-left: 4px solid #22c55e;">
  <h3>${data.steps.length + 1}. ${data.finalStep.title}</h3>
  <p>${data.finalStep.description}</p>
</div>

<div class="card" style="border-left: 4px solid #6366f1;">
  <h3 style="margin-top: 0;">Fleet Management API</h3>
  <p>${data.fleetManagementApi.summary}</p>
  <table style="width: 100%; border-collapse: collapse; font-size: 0.9em; margin: 8px 0 16px;">
    <thead><tr style="border-bottom: 2px solid #e2e8f0; text-align: left;">
      <th style="padding: 6px 12px; width: 22%;">Method / Path</th>
      <th style="padding: 6px 12px;">Purpose</th>
    </tr></thead>
    <tbody>${data.fleetManagementApi.endpoints
      .map(
        (e) => `
      <tr style="border-bottom: 1px solid #f1f5f9;">
        <td style="padding: 6px 12px; font-family: monospace; vertical-align: top;"><strong>${e.method}</strong> ${e.path}</td>
        <td style="padding: 6px 12px; color: #475569;">${e.purpose}</td>
      </tr>`,
      )
      .join("")}
    </tbody>
  </table>
  <h4 style="margin: 16px 0 8px; font-size: 1em;">Principles</h4>
  <ul style="margin: 4px 0 4px; padding-left: 20px; font-size: 0.92em; color: #475569; line-height: 1.7;">
    ${data.fleetManagementApi.principles.map((p) => `<li>${p}</li>`).join("")}
  </ul>
</div>

<div class="card" style="border-left: 4px solid #0ea5e9;">
  <h3 style="margin-top: 0;">${data.configuring.title}</h3>
  <p>${data.configuring.summary}</p>

  <h4 style="margin: 16px 0 6px; font-size: 1em;">Vocabulary — use these exact names with users</h4>
  <table style="width: 100%; border-collapse: collapse; font-size: 0.9em; margin: 0 0 16px;">
    <thead><tr style="border-bottom: 2px solid #e2e8f0; text-align: left;">
      <th style="padding: 6px 10px; width: 24%;">Name</th>
      <th style="padding: 6px 10px;">What it controls</th>
      <th style="padding: 6px 10px; width: 22%;">Editable by</th>
    </tr></thead>
    <tbody>${data.configuring.vocab
      .map(
        (v) => `
      <tr style="border-bottom: 1px solid #f1f5f9; vertical-align: top;">
        <td style="padding: 6px 10px; font-weight: 600; color: #0369a1;">${v.term}</td>
        <td style="padding: 6px 10px; color: #475569;">${v.scope}</td>
        <td style="padding: 6px 10px; color: #475569;">${v.editableBy}</td>
      </tr>`,
      )
      .join("")}
    </tbody>
  </table>

  <h4 style="margin: 16px 0 6px; font-size: 1em;">Playbook — user request → agent action</h4>
  ${data.configuring.playbook
    .map(
      (p) => `
    <details style="margin: 10px 0; padding: 10px 14px; background: #f0f9ff; border-radius: 6px;">
      <summary style="cursor: pointer; font-weight: 600; color: #075985;">${p.userAsks}</summary>
      <div style="margin-top: 10px; font-size: 0.92em;">
        <p style="margin: 4px 0;"><strong style="color: #075985;">Confirm first:</strong> ${p.confirmBefore}</p>
        <table style="width: 100%; border-collapse: collapse; margin: 6px 0 8px; background: #fff; border-radius: 4px;">
          <tbody>
            <tr><td style="padding: 4px 8px; color: #64748b; width: 90px;">Method</td><td style="padding: 4px 8px; font-family: monospace;">${p.api.method}</td></tr>
            <tr><td style="padding: 4px 8px; color: #64748b;">URL</td><td style="padding: 4px 8px; font-family: monospace; word-break: break-all;">${p.api.url}</td></tr>
            <tr><td style="padding: 4px 8px; color: #64748b;">Body</td><td style="padding: 4px 8px; font-family: monospace; white-space: pre-wrap;">${p.api.body}</td></tr>
            <tr><td style="padding: 4px 8px; color: #64748b;">Auth</td><td style="padding: 4px 8px; color: #475569;">${p.api.auth}</td></tr>
          </tbody>
        </table>
        <p style="margin: 4px 0;"><strong style="color: #047857;">Consequences:</strong> ${p.consequences}</p>
        ${p.clearOverride ? `<p style="margin: 4px 0; color: #64748b;"><strong>Clear:</strong> ${p.clearOverride}</p>` : ""}
      </div>
    </details>`,
    )
    .join("")}

  <h4 style="margin: 16px 0 6px; font-size: 1em;">Rules of engagement (agent, not user)</h4>
  <ul style="margin: 4px 0; padding-left: 20px; font-size: 0.92em; color: #475569; line-height: 1.7;">
    ${data.configuring.agentRules.map((r) => `<li>${r}</li>`).join("")}
  </ul>
</div>

<div class="card" style="border-left: 4px solid #dc2626;">
  <h3 style="margin-top: 0;">Troubleshooting</h3>
  <p>${data.troubleshooting.summary}</p>
  ${data.troubleshooting.entries
    .map(
      (t) => `
    <details style="margin: 10px 0; padding: 8px 12px; background: #fef2f2; border-radius: 6px;">
      <summary style="cursor: pointer; font-weight: 600; color: #991b1b;">${t.symptom}</summary>
      <div style="margin-top: 10px; font-size: 0.92em;">
        <strong style="color: #475569;">Causes:</strong>
        <ul style="margin: 4px 0 10px; padding-left: 20px; color: #475569; line-height: 1.6;">
          ${t.causes.map((c) => `<li>${c}</li>`).join("")}
        </ul>
        <strong style="color: #047857;">Fix:</strong>
        <p style="margin: 4px 0 4px; color: #1f2937;">${t.fix}</p>
      </div>
    </details>`,
    )
    .join("")}
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
<html><head><title>SpaiGlass</title>
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
  <h1 style="margin:0;">Sp<span class="brand-ai">ai</span>Glass</h1>
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

  // Explicit escape hatch: the VM-offline page's "Back to fleet relay" link
  // passes ?skip_last_used=1 so this handler doesn't auto-redirect the user
  // right back to the same offline VM they just came from.
  const skipLastUsed = c.req.query("skip_last_used") === "1";

  // Prefer the user's last-used agent URL if we have one — but only if the
  // connector it references still exists. Preferences stored before a rename
  // or delete would otherwise redirect every load to a broken /vm/<old>/ URL
  // that the relay can't route, leaving the user permanently stuck.
  const owned = getConnectorsByUser(user.id);
  const shared = getSharedConnectorsForUser(user.id);
  const allConnectors: { name: string; id: string }[] = [
    ...owned.map((c) => ({ name: c.name, id: c.id })),
    ...shared.map((c) => ({ name: `${c.owner_login}.${c.name}`, id: c.id })),
    ...shared.map((c) => ({ name: c.name, id: c.id })),
  ];
  const cm = getChannelManager();
  const lastAgent = getUserPreference(user.id, "last_agent_url");
  if (!skipLastUsed && lastAgent?.startsWith("/vm/")) {
    const firstSeg = lastAgent.slice(4).split("/")[0] || "";
    const connectorPart = firstSeg.includes(".")
      ? firstSeg.slice(firstSeg.indexOf(".") + 1)
      : firstSeg;
    const match = allConnectors.find(
      (c) => c.name.toLowerCase() === connectorPart.toLowerCase(),
    );
    // Only honor the last-used redirect when the target connector is
    // currently ONLINE. Redirecting into an offline VM produces a dead-end
    // page whose "Back to fleet relay" link bounces right back here — the
    // exact loop that prompted this guard.
    if (match && cm.isOnline(match.id)) return c.redirect(lastAgent);
    // Stale preference OR offline target: fall through to first-available.
    // Don't mutate the preference here — it'll get overwritten the next
    // time the user lands on a valid chat page.
  } else if (!skipLastUsed && lastAgent?.startsWith("/")) {
    // Non-VM last-agent (unlikely but possible) — keep prior behavior.
    return c.redirect(lastAgent);
  }

  // Prefer an online owned connector over an offline one, then fall back
  // to shared. If nothing is online, land on the first owned/shared anyway
  // so the user sees a VM-offline page rather than nothing at all.
  const firstOnlineOwned = owned.find((c) => cm.isOnline(c.id));
  if (firstOnlineOwned) {
    return c.redirect(`/vm/${firstOnlineOwned.name}/`);
  }
  const firstOnlineShared = shared.find((c) => cm.isOnline(c.id));
  if (firstOnlineShared) {
    return c.redirect(
      `/vm/${firstOnlineShared.owner_login}.${firstOnlineShared.name}/`,
    );
  }
  if (owned.length > 0) {
    return c.redirect(`/vm/${owned[0].name}/`);
  }
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
<p><a href="/fleetrelay?skip_last_used=1">Back to fleet relay</a></p></body></html>`,
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
    // Parse directory/role context from URL.
    //   /vm/:slug/                            → no project, no role (picker)
    //   /vm/:slug/<directory>/                → directory, no role (role-less)
    //   /vm/:slug/<directory>-<role>/         → directory + role (legacy)
    // Role-less URLs are the primary UX in the Server+Directory model; the
    // hyphen-role form stays supported for back-compat with existing links.
    `var inner=location.pathname.slice(B.length).replace(/^\\/+/,'');` +
    `var seg=inner.split('/').filter(Boolean)[0]||'';` +
    `var di=seg.lastIndexOf('-');` +
    `var proj=di>0?seg.slice(0,di):seg;` +
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
/**
 * Drop paths that look like the Spaiglass install itself — binary dir, state
 * dir, or Claude Code's own config dir. These show up in ~/.claude.json if
 * the user ever ran `claude` inside them but aren't user projects.
 *
 * Matches the common home-dir shapes for Linux (/home/<u>/), macOS
 * (/Users/<u>/), and Windows (C:\Users\<u>\). Kept as a regex list so it
 * tolerates the different path separators POSIX-normalized clients might
 * send.
 */
function isSpaiglassInternalPath(rawPath: string): boolean {
  const p = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const patterns = [
    /^\/home\/[^/]+\/(spaiglass|\.spaiglass|\.claude)(\/|$)/i,
    /^\/Users\/[^/]+\/(spaiglass|\.spaiglass|\.claude)(\/|$)/i,
    /^[A-Za-z]:\/Users\/[^/]+\/(spaiglass|\.spaiglass|\.claude)(\/|$)/i,
    /^\/root\/(spaiglass|\.spaiglass|\.claude)(\/|$)/i,
  ];
  return patterns.some((re) => re.test(p));
}

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

  const versionFor = (conn: { id: string; spaiglass_version: string | null }) =>
    cm.getVersion(conn.id) ?? conn.spaiglass_version;

  const allConns = [
    ...ownedConns.map((conn) => ({
      id: conn.id,
      name: conn.name,
      displayName: connectorDisplayName(conn),
      role: "owner" as const,
      online: cm.isOnline(conn.id),
      spaiglassVersion: versionFor(conn),
    })),
    ...sharedConns.map((conn) => ({
      id: conn.id,
      name: conn.name,
      displayName: connectorDisplayName(conn),
      role: conn.role,
      online: cm.isOnline(conn.id),
      spaiglassVersion: versionFor(conn),
    })),
  ];

  return c.json({
    connectors: allConns,
    latestSpaiglassVersion: getLatestSpAIglassVersion(),
  });
});

// Read the current connector's id, name, and custom display name. The chat
// UI uses this to populate the "Browser tab title" editor in the settings
// modal — we can't just send the connector name because the owner may have
// set a human-friendly override via the old pencil / fleet dashboard.
app.get("/vm/:slug/api/__relay/self", async (c) => {
  const auth = await vmAuth(c);
  if (auth instanceof Response) return auth;
  const { user, connector, role } = auth;
  // Version: prefer the live in-memory version (freshest); fall back to the
  // last-persisted DB value so a temporarily-offline VM still surfaces a
  // banner when it's behind. Compare against the relay's latest release.
  const cm = getChannelManager();
  const spaiglassVersion =
    cm.getVersion(connector.id) ?? connector.spaiglass_version;
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
    spaiglassVersion,
    latestSpaiglassVersion: getLatestSpAIglassVersion(),
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

// Relay-level: fetch roles + directories for a specific connector (by slug),
// accessible from VM context. Directories are the primary Server+Directory
// picker source — roles are retained as secondary, role-pinned entries.
app.get("/vm/:slug/api/__relay/fleet/:targetSlug/roles", async (c) => {
  const auth = await vmAuth(c);
  if (auth instanceof Response) return auth;

  const targetSlug = c.req.param("targetSlug")!;
  const targetConn = resolveVmSlug(targetSlug);
  if (!targetConn) return c.json({ roles: [], directories: [] });

  const cm = getChannelManager();
  if (!cm.isOnline(targetConn.id)) {
    return c.json({ roles: [], directories: [] });
  }

  // Resolve the canonical slug (login.name) for URL construction so that
  // role URLs match the __SG.slug set in the browser. The targetSlug from
  // the fetch may be a bare connector name, but page URLs always use the
  // full login.name format.
  const owner = getUserById(targetConn.user_id);
  const canonicalSlug = owner
    ? `${owner.github_login}.${targetConn.name}`
    : targetSlug;

  try {
    // /api/discover scans ~/projects for role files (source of truth for roles).
    // /api/projects reads Claude Code's registry (source of truth for the
    // role-less directory list — includes dirs without role files).
    // /api/settings/project-display-names supplies owner-provided labels.
    // /api/settings/project-directory-tab-names supplies browser-tab-only overrides.
    const [discoverRes, projectsRes, dnRes, tnRes] = await Promise.all([
      proxyGetJson(cm, targetConn.id, "/api/discover?projectsDir=~/projects"),
      proxyGetJson(cm, targetConn.id, "/api/projects"),
      proxyGetJson(cm, targetConn.id, "/api/settings/project-display-names"),
      proxyGetJson(
        cm,
        targetConn.id,
        "/api/settings/project-directory-tab-names",
      ),
    ]);

    const displayNames: Record<string, string> =
      dnRes?.displayNames || {};
    const tabNames: Record<string, string> = tnRes?.tabNames || {};

    const roles: Array<{
      project: string;
      displayName: string | null;
      projectPath: string;
      roleFile: string;
      roleName: string;
      segment: string;
      url: string;
    }> = [];

    if (discoverRes?.projects) {
      for (const proj of discoverRes.projects) {
        for (const role of proj.roles || []) {
          const roleBase = role.filename.replace(/\.md$/, "");
          const segment = `${proj.name}-${roleBase}`;
          roles.push({
            project: proj.name,
            displayName: displayNames[proj.name] || null,
            projectPath: proj.path,
            roleFile: role.filename,
            roleName: role.name,
            segment,
            url: `/vm/${canonicalSlug}/${segment}/`,
          });
        }
      }
    }

    // Build directory list from Claude's registry. Each entry is role-less —
    // segment is just the basename, so the relay URL parser treats it as a
    // directory-only target (new Server+Directory flow).
    const directories: Array<{
      name: string;
      displayName: string | null;
      tabName: string | null;
      path: string;
      segment: string;
      url: string;
      hasRoles: boolean;
    }> = [];
    const seenSegments = new Set<string>();

    const projectList: Array<{ path: string; encodedName?: string }> =
      Array.isArray(projectsRes?.projects) ? projectsRes.projects : [];
    for (const p of projectList) {
      if (!p?.path || typeof p.path !== "string") continue;
      if (isSpaiglassInternalPath(p.path)) continue;
      // Split on BOTH / and \\ so Windows paths (C:\\Users\\...\\sandbox)
      // resolve to the basename instead of the entire path. Pre-fix this
      // returned the full path as basename, then used it verbatim as a URL
      // segment, producing /vm/<slug>/C:\\Users\\.../ which the browser
      // parses as the C: protocol scheme and silently abandons → user was
      // bounced to whatever URL they came from.
      const basename = p.path.split(/[/\\]/).filter(Boolean).pop() || "";
      if (!basename || seenSegments.has(basename)) continue;
      seenSegments.add(basename);
      const hasRoles = roles.some((r) => r.project === basename);
      directories.push({
        name: basename,
        displayName: displayNames[basename] || null,
        tabName: tabNames[basename] || null,
        path: p.path,
        segment: basename,
        url: `/vm/${canonicalSlug}/${basename}/`,
        hasRoles,
      });
    }

    // Also surface any projects that have role files but aren't in
    // Claude's registry yet (e.g. freshly scaffolded, never opened).
    if (discoverRes?.projects) {
      for (const proj of discoverRes.projects) {
        if (seenSegments.has(proj.name)) continue;
        seenSegments.add(proj.name);
        directories.push({
          name: proj.name,
          displayName: displayNames[proj.name] || null,
          tabName: tabNames[proj.name] || null,
          path: proj.path,
          segment: proj.name,
          url: `/vm/${canonicalSlug}/${proj.name}/`,
          hasRoles: (proj.roles?.length || 0) > 0,
        });
      }
    }

    directories.sort((a, b) =>
      (a.displayName || a.name).localeCompare(b.displayName || b.name),
    );

    return c.json({ roles, directories });
  } catch {
    return c.json({ roles: [], directories: [] });
  }
});

// Relay-level: SpAIglass doctor — fan-out audit across every online
// connector the caller can see (owned + shared). Each per-server result
// is the verbatim response from that VM's GET /api/doctor, plus a
// `server: { slug, displayName, online }` wrapper. Offline connectors
// are returned with `online: false` and `issues: []` so the agent can
// report them separately.
//
// The `:slug` in the URL just routes this request through SOME online
// connector's tunnel (same pattern as /fleet/:targetSlug/roles) — the
// actual audit targets are determined from the caller's fleet, not from
// :slug.
app.get("/vm/:slug/api/__relay/doctor", async (c) => {
  const auth = await vmAuth(c);
  if (auth instanceof Response) return auth;
  const { user } = auth;

  const cm = getChannelManager();
  const owned = getConnectorsByUser(user.id).map((conn) => ({
    conn,
    role: "owner" as const,
  }));
  const shared = getSharedConnectorsForUser(user.id).map((conn) => ({
    conn,
    role: conn.role,
  }));
  const all = [...owned, ...shared];

  const results = await Promise.all(
    all.map(async ({ conn, role }) => {
      const owner = getUserById(conn.user_id);
      const canonicalSlug = owner
        ? `${owner.github_login}.${conn.name}`
        : conn.name;
      const base = {
        slug: conn.name,
        canonicalSlug,
        displayName: connectorDisplayName(conn),
        role,
        online: cm.isOnline(conn.id),
      };
      if (!base.online) {
        return { server: base, issues: [], skipped: "offline" as const };
      }
      try {
        const res = await proxyGetJson(cm, conn.id, "/api/doctor");
        if (res && Array.isArray(res.issues)) {
          return { server: base, issues: res.issues, counts: res.counts };
        }
        return {
          server: base,
          issues: [],
          skipped: "doctor-endpoint-missing" as const,
        };
      } catch {
        return {
          server: base,
          issues: [],
          skipped: "proxy-error" as const,
        };
      }
    }),
  );

  const totalIssues = results.reduce(
    (sum, r) => sum + (r.issues?.length || 0),
    0,
  );
  const onlineServers = results.filter((r) => r.server.online).length;
  const offlineServers = results.length - onlineServers;

  return c.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    counts: {
      servers: results.length,
      online: onlineServers,
      offline: offlineServers,
      issues: totalIssues,
    },
    servers: results,
  });
});

// Redirect /vm/:slug (no trailing slash) to /vm/:slug/
app.get("/vm/:slug", (c) => {
  return c.redirect(`/vm/${c.req.param("slug")}/`);
});

// Bare /vm/:slug/ (no project segment) — auto-redirect to the user's
// first registered project on that connector. The dedicated
// "Pick a server and a directory" landing page (rendered by the SPA's
// ProjectSelector when no segment is present) was redundant: ChatPage's
// AgentSwitcher already exposes server + directory dropdowns, the
// session picker handles past-session selection, and the relay's home
// (renderFleetRelay) already redirects users into a chat. Hitting
// /vm/<conn>/ should land on a chat, not a separate picker UI.
app.get("/vm/:slug/", async (c) => {
  const auth = await vmAuth(c);
  if (auth instanceof Response) return auth;
  const { connector } = auth;

  const cm = getChannelManager();
  if (!cm.isOnline(connector.id)) {
    // Connector not connected — fall through to the normal proxy path
    // below, which renders the VM-offline error page.
    return c.notFound();
  }

  // Resolve canonical slug for the redirect URL — match the format the
  // browser already uses (login.connectorname for owned, bare for
  // direct-named lookups).
  const slug = c.req.param("slug")!;
  const owner = getUserById(connector.user_id);
  const canonicalSlug = slug.includes(".")
    ? slug
    : owner
      ? `${owner.github_login}.${connector.name}`
      : connector.name;

  try {
    const projectsRes = await proxyGetJson(cm, connector.id, "/api/projects");
    const projectList: Array<{ path?: string }> = Array.isArray(
      projectsRes?.projects,
    )
      ? projectsRes.projects
      : [];

    // Pick the first project whose basename is non-empty (skips spaiglass-
    // internal entries and malformed paths). Same `/[/\\]/` split as the
    // fleet/roles handler so Windows paths resolve correctly.
    for (const p of projectList) {
      if (!p?.path || typeof p.path !== "string") continue;
      if (isSpaiglassInternalPath(p.path)) continue;
      const basename = p.path.split(/[/\\]/).filter(Boolean).pop() || "";
      if (!basename) continue;
      return c.redirect(`/vm/${canonicalSlug}/${basename}/`);
    }
  } catch {
    // proxyGetJson failed — fall through to the no-projects message below.
  }

  // No registered projects on this connector. Render a focused "register
  // a project" message instead of falling back to the deprecated picker.
  return c.html(
    `<!DOCTYPE html>
<html><head><title>No directories yet</title>
${FAVICON}
<style>body{font-family:system-ui;max-width:640px;margin:80px auto;padding:0 20px;color:#1a1a2e;background:#f0f0f5;line-height:1.5;}
code{background:#e6e6ee;padding:2px 6px;border-radius:4px;font-size:0.9em;}
a{color:#3060b8;}</style>
</head><body>
<h1>No directories yet on ${connector.display_name || connector.name}</h1>
<p>This connector is online, but no project directories are registered.</p>
<p>From a shell on the host, register one with:</p>
<pre style="background:#1a1a2e;color:#f0f0f5;padding:12px;border-radius:6px;overflow-x:auto;">
curl -X POST http://127.0.0.1:8080/api/projects/register \\
  -H 'content-type: application/json' \\
  -d '{"name":"<your-project-folder-name>"}'</pre>
<p>The folder must already exist under <code>~/projects/</code> on the host (or pass <code>"path"</code> instead of <code>"name"</code>).</p>
<p><a href="/fleetrelay?skip_last_used=1">Pick a different server</a></p>
</body></html>`,
    200,
  );
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
<p><a href="/fleetrelay?skip_last_used=1">Back to fleet relay</a></p></body></html>`,
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
<p><a href="/fleetrelay?skip_last_used=1">Back to fleet relay</a></p></body></html>`,
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
