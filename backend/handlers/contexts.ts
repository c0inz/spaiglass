import type { Context } from "hono";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface ContextFile {
  name: string;
  filename: string;
  path: string;
  preview: string;
}

/**
 * GET /api/projects/contexts?path=<project-dir>
 * Scans the agents/ subdirectory for .md context files.
 * Returns list with name (derived from filename), full path, and preview.
 */
export async function handleContextsRequest(c: Context) {
  const projectPath = c.req.query("path");
  if (!projectPath) {
    return c.json({ error: "path parameter required" }, 400);
  }

  const agentsDir = join(resolve(projectPath), "agents");
  const contexts: ContextFile[] = [];

  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && entry.name.endsWith(".md")) {
        const filePath = join(agentsDir, entry.name);
        const content = await readFile(filePath, "utf-8");
        const name = entry.name.replace(/\.md$/, "").replace(/[-_]/g, " ");
        // First 200 chars as preview
        const preview = content.slice(0, 200).trim();
        contexts.push({
          name,
          filename: entry.name,
          path: filePath,
          preview,
        });
      }
    }
  } catch {
    // agents/ directory doesn't exist — that's fine, return empty
  }

  return c.json({ contexts });
}
