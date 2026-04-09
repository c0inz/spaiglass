import type { Context } from "hono";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

interface StaleCheck {
  path: string;
  lastReadMs: number;
}

/**
 * POST /api/session/stale
 * Body: { files: [{ path: string, lastReadMs: number }] }
 * For each file, compare lastReadMs against current mtime.
 * Returns which files are stale (modified after last read).
 */
export async function handleStaleCheckRequest(c: Context) {
  const body = await c.req.json<{ files: StaleCheck[] }>();
  if (!body.files || !Array.isArray(body.files)) {
    return c.json({ error: "files array required" }, 400);
  }

  const results: { path: string; stale: boolean; mtimeMs: number }[] = [];

  for (const file of body.files) {
    try {
      const resolved = resolve(file.path);
      const s = await stat(resolved);
      results.push({
        path: file.path,
        stale: s.mtimeMs > file.lastReadMs,
        mtimeMs: s.mtimeMs,
      });
    } catch {
      // File doesn't exist or can't be read — mark as stale
      results.push({ path: file.path, stale: true, mtimeMs: 0 });
    }
  }

  return c.json({ results });
}
