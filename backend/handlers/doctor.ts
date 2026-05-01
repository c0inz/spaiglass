/**
 * GET /api/doctor — VM-local configuration audit.
 *
 * Read-only. Returns a flat list of configuration issues the install agent
 * should surface to the human user. Does NOT mutate anything — fix endpoints
 * are a separate concern and require per-issue human confirmation.
 *
 * Issue shape:
 *   {
 *     id:        "<code>:<stable-key>",       // idempotent across reruns
 *     code:      "<machine-readable code>",    // e.g. "directory.missing"
 *     severity:  "info" | "warn" | "error",
 *     message:   "<human-readable one-line description>",
 *     details:   { ... code-specific context },
 *     fixable:   boolean,                      // true means v2 can auto-fix
 *     fixHint:   "<what the fix would do>"
 *   }
 *
 * Checks (v1):
 *   directory.missing       — registry entry whose path no longer exists on disk
 *   directory.duplicate-case — two registry entries differ only in case
 *   directory.home-root     — registry entry equals $HOME itself
 *   displayName.orphan      — Display Name override for a basename not in registry
 *   tabName.orphan          — Tab Name override for a basename not in registry
 *   server.display-name-unset — info only; this VM's Server Display Name (relay)
 *                               cannot be read from the VM, so this check is
 *                               skipped here and handled at the relay aggregator.
 */

import type { Context } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface Issue {
  id: string;
  code: string;
  severity: "info" | "warn" | "error";
  message: string;
  details: Record<string, unknown>;
  fixable: boolean;
  fixHint: string;
}

function isSpaiglassInternalPath(path: string, home: string): boolean {
  const n = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const h = home.replace(/\\/g, "/").replace(/\/+$/, "");
  const internals = [`${h}/spaiglass`, `${h}/.spaiglass`, `${h}/.claude`];
  for (const root of internals) {
    if (n === root || n.startsWith(root + "/")) return true;
  }
  return false;
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";
}

function readRegistry(home: string): string[] {
  const path = `${home}/.claude.json`;
  if (!existsSync(path)) return [];
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    if (!cfg?.projects || typeof cfg.projects !== "object") return [];
    return Object.keys(cfg.projects).filter(
      (p) => !isSpaiglassInternalPath(p, home),
    );
  } catch {
    return [];
  }
}

interface DisplayStore {
  [basename: string]: { displayName?: string; tabName?: string };
}

function readDisplayStore(home: string): DisplayStore {
  const file = join(home, ".spaiglass", "project-display-names.json");
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    const out: DisplayStore = {};
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "string") {
          if (v.trim()) out[k] = { displayName: v.trim() };
        } else if (v && typeof v === "object") {
          const dn = (v as { displayName?: unknown }).displayName;
          const tn = (v as { tabName?: unknown }).tabName;
          const entry: { displayName?: string; tabName?: string } = {};
          if (typeof dn === "string" && dn.trim()) entry.displayName = dn.trim();
          if (typeof tn === "string" && tn.trim()) entry.tabName = tn.trim();
          if (entry.displayName || entry.tabName) out[k] = entry;
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function handleDoctorRequest(c: Context) {
  const home = homedir();
  const issues: Issue[] = [];

  const registry = readRegistry(home);
  const display = readDisplayStore(home);
  const registryBasenames = new Set(registry.map(basename));

  // directory.missing — path no longer exists on disk
  for (const p of registry) {
    if (!pathExists(p)) {
      issues.push({
        id: `directory.missing:${p}`,
        code: "directory.missing",
        severity: "warn",
        message: `Registered directory does not exist on disk: ${p}`,
        details: { path: p },
        fixable: true,
        fixHint:
          "Remove the entry from ~/.claude.json (POST /api/projects/unregister with { path }).",
      });
    }
  }

  // directory.duplicate-case — two entries differ only in case
  const lowerToPaths = new Map<string, string[]>();
  for (const p of registry) {
    const key = p.toLowerCase();
    const arr = lowerToPaths.get(key) || [];
    arr.push(p);
    lowerToPaths.set(key, arr);
  }
  for (const [, paths] of lowerToPaths) {
    if (paths.length > 1) {
      // Stable id from sorted set so reruns produce the same id.
      const sorted = [...paths].sort();
      issues.push({
        id: `directory.duplicate-case:${sorted.join("|")}`,
        code: "directory.duplicate-case",
        severity: "warn",
        message: `Registry contains ${paths.length} entries that differ only in case: ${sorted.join(", ")}. On a case-sensitive filesystem these are separate directories; on a case-insensitive one they collide.`,
        details: { paths: sorted },
        fixable: false,
        fixHint:
          "Ask the human which one to keep. A file listing of each (GET /api/files/list?path=...) can help decide.",
      });
    }
  }

  // directory.home-root — registry contains $HOME itself
  const homeNorm = home.replace(/\/+$/, "");
  for (const p of registry) {
    if (p.replace(/\/+$/, "") === homeNorm) {
      issues.push({
        id: `directory.home-root:${p}`,
        code: "directory.home-root",
        severity: "info",
        message: `Registry contains $HOME itself (${p}). This is almost always unintentional — it appears when \`claude\` is run from the home directory and sweeps in the entire user tree as a project.`,
        details: { path: p },
        fixable: false,
        fixHint:
          "Probably remove (POST /api/projects/unregister), but confirm with the human first — they may actually use it.",
      });
    }
  }

  // displayName.orphan / tabName.orphan
  for (const [bn, entry] of Object.entries(display)) {
    if (!registryBasenames.has(bn)) {
      if (entry.displayName) {
        issues.push({
          id: `displayName.orphan:${bn}`,
          code: "displayName.orphan",
          severity: "info",
          message: `Project Directory Display Name "${entry.displayName}" is set for "${bn}" but no directory with that basename is registered — the override is unreachable.`,
          details: { basename: bn, displayName: entry.displayName },
          fixable: true,
          fixHint:
            'PUT /api/settings/project-display-name with { "project": "<basename>", "displayName": null }.',
        });
      }
      if (entry.tabName) {
        issues.push({
          id: `tabName.orphan:${bn}`,
          code: "tabName.orphan",
          severity: "info",
          message: `Project Directory Tab Name "${entry.tabName}" is set for "${bn}" but no directory with that basename is registered — the override is unreachable.`,
          details: { basename: bn, tabName: entry.tabName },
          fixable: true,
          fixHint:
            'PUT /api/settings/project-directory-tab-name with { "project": "<basename>", "tabName": null }.',
        });
      }
    }
  }

  return c.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    counts: {
      registryEntries: registry.length,
      displayOverrides: Object.keys(display).length,
      issues: issues.length,
    },
    issues,
  });
}
