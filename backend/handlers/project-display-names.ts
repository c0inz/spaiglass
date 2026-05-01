/**
 * Per-directory display overrides — cosmetic labels the user can edit
 * without touching the real filesystem path.
 *
 * Two fields per project (keyed by directory basename):
 *   displayName — shown in: top-left chat header "project" slot,
 *                 Directory dropdown entries, "last used" quick-switch
 *                 buttons, Agent Picker on mobile. Falls back to the
 *                 directory basename when unset.
 *   tabName     — shown in the browser tab title only (and bookmarks).
 *                 Falls back to displayName, then to the directory
 *                 basename when unset.
 *
 * Storage: ~/.spaiglass/project-display-names.json
 *
 * On-disk shape is per-project object:
 *   { "OCMarketplace": { displayName: "OC Market", tabName: "OC" } }
 *
 * Legacy shape (string value, displayName only) is migrated in-place on
 * first read — callers never see the old format.
 *
 * Routes:
 *   GET  /api/settings/project-display-names          → display-name map
 *   PUT  /api/settings/project-display-name           → set/clear displayName
 *   GET  /api/settings/project-directory-tab-names    → tab-name map
 *   PUT  /api/settings/project-directory-tab-name     → set/clear tabName
 */

import type { Context } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".spaiglass");
const FILE = join(DIR, "project-display-names.json");

interface ProjectOverrides {
  displayName?: string;
  tabName?: string;
}

type Store = Record<string, ProjectOverrides>;

function readStore(): Store {
  try {
    if (!existsSync(FILE)) return {};
    const raw = JSON.parse(readFileSync(FILE, "utf-8"));
    if (raw && typeof raw === "object") {
      const out: Store = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "string") {
          // Legacy shape: whole value was the displayName
          if (v.trim()) out[k] = { displayName: v.trim() };
        } else if (v && typeof v === "object") {
          const entry: ProjectOverrides = {};
          const dn = (v as ProjectOverrides).displayName;
          const tn = (v as ProjectOverrides).tabName;
          if (typeof dn === "string" && dn.trim()) entry.displayName = dn.trim();
          if (typeof tn === "string" && tn.trim()) entry.tabName = tn.trim();
          if (entry.displayName || entry.tabName) out[k] = entry;
        }
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function writeStore(data: Store): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function updateField(
  store: Store,
  project: string,
  field: "displayName" | "tabName",
  value: string | null,
): Store {
  const entry: ProjectOverrides = { ...(store[project] || {}) };
  if (value) {
    entry[field] = value;
  } else {
    delete entry[field];
  }
  if (!entry.displayName && !entry.tabName) {
    delete store[project];
  } else {
    store[project] = entry;
  }
  return store;
}

function flattenDisplayNames(store: Store): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(store)) {
    if (v.displayName) out[k] = v.displayName;
  }
  return out;
}

function flattenTabNames(store: Store): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(store)) {
    if (v.tabName) out[k] = v.tabName;
  }
  return out;
}

export function handleGetProjectDisplayNames(c: Context) {
  return c.json({ displayNames: flattenDisplayNames(readStore()) });
}

export async function handleSetProjectDisplayName(c: Context) {
  let body: { project?: string; displayName?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const project = typeof body.project === "string" ? body.project.trim() : "";
  if (!project) return c.json({ error: "project is required" }, 400);
  const displayName =
    typeof body.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim()
      : null;
  const store = updateField(readStore(), project, "displayName", displayName);
  writeStore(store);
  return c.json({ ok: true, project, displayName });
}

export function handleGetProjectDirectoryTabNames(c: Context) {
  return c.json({ tabNames: flattenTabNames(readStore()) });
}

export async function handleSetProjectDirectoryTabName(c: Context) {
  let body: { project?: string; tabName?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const project = typeof body.project === "string" ? body.project.trim() : "";
  if (!project) return c.json({ error: "project is required" }, 400);
  const tabName =
    typeof body.tabName === "string" && body.tabName.trim()
      ? body.tabName.trim()
      : null;
  const store = updateField(readStore(), project, "tabName", tabName);
  writeStore(store);
  return c.json({ ok: true, project, tabName });
}
