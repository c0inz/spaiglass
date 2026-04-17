/**
 * Project display names — user-editable labels for projects.
 *
 * The project name (directory basename) is immutable and used as the
 * canonical key everywhere. Display names are cosmetic labels shown in
 * the page header and fleet dropdown. They are stored per-VM in a JSON
 * file so all browsers see the same names.
 *
 * Storage: ~/.spaiglass/project-display-names.json
 *   { "OCMarketplace": "OC Market", "TrendZion": "Trend Zion" }
 *
 * Routes:
 *   GET  /api/settings/project-display-names          → all display names
 *   PUT  /api/settings/project-display-name            → set or clear one
 */

import type { Context } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".spaiglass");
const FILE = join(DIR, "project-display-names.json");

function readAll(): Record<string, string> {
  try {
    if (!existsSync(FILE)) return {};
    return JSON.parse(readFileSync(FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, string>): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * GET /api/settings/project-display-names
 * Returns { displayNames: Record<string, string> }
 */
export function handleGetProjectDisplayNames(c: Context) {
  return c.json({ displayNames: readAll() });
}

/**
 * PUT /api/settings/project-display-name
 * Body: { project: string, displayName: string | null }
 * Setting displayName to null or "" clears the override.
 */
export async function handleSetProjectDisplayName(c: Context) {
  let body: { project?: string; displayName?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const project = typeof body.project === "string" ? body.project.trim() : "";
  if (!project) {
    return c.json({ error: "project is required" }, 400);
  }

  const displayName =
    typeof body.displayName === "string" ? body.displayName.trim() : null;

  const all = readAll();
  if (displayName) {
    all[project] = displayName;
  } else {
    delete all[project];
  }
  writeAll(all);

  return c.json({ ok: true, project, displayName: displayName || null });
}
