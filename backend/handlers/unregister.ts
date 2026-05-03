/**
 * POST /api/projects/unregister
 *
 * Remove a directory entry from ~/.claude.json's `projects` object so it
 * disappears from the Spaiglass Directory dropdown on next page load.
 *
 * Body: { path: string }
 *
 *   path — absolute path as it appears in ~/.claude.json (trailing slash
 *          is tolerated). Case-sensitive on POSIX filesystems.
 *
 * Preserves everything else in ~/.claude.json untouched. Does NOT delete
 * the encoded session history under ~/.claude/projects/<encoded>/ —
 * session transcripts are left alone so a future re-registration keeps
 * prior history. Idempotent: removing a path that isn't registered
 * returns ok:true with removed:false.
 */

import type { Context } from "hono";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../utils/logger.ts";

export async function handleUnregisterProject(c: Context) {
  let body: { path?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.path !== "string" || !body.path.trim()) {
    return c.json({ error: "path is required (string)" }, 400);
  }
  const raw = body.path.trim();
  if (!raw.startsWith("/")) {
    return c.json({ error: "path must be absolute" }, 400);
  }

  const HOME = homedir();
  const claudeJsonPath = join(HOME, ".claude.json");
  if (!existsSync(claudeJsonPath)) {
    return c.json({ ok: true, removed: false, reason: "no-claude-json" });
  }

  let data: { projects?: Record<string, unknown> };
  try {
    data = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
  } catch (err) {
    logger.api.error(
      `Failed to parse ~/.claude.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return c.json({ error: "Failed to parse ~/.claude.json" }, 500);
  }

  const projects = (data.projects as Record<string, unknown>) || {};
  const target = raw.replace(/\/+$/, "");
  const matchedKey = Object.keys(projects).find(
    (k) => k.replace(/\/+$/, "") === target,
  );
  if (!matchedKey) {
    return c.json({ ok: true, removed: false, reason: "not-registered" });
  }

  delete projects[matchedKey];
  data.projects = projects;

  try {
    writeFileSync(claudeJsonPath, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.api.error(
      `Failed to write ~/.claude.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return c.json({ error: "Failed to write ~/.claude.json" }, 500);
  }

  logger.api.info(
    `Unregistered project path from ~/.claude.json: ${matchedKey}`,
  );
  return c.json({ ok: true, removed: true, path: matchedKey });
}
