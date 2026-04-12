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
 * Scans .claude/agents/ for .md agent/role files (native Claude Code convention).
 * Falls back to agents/ for backward compatibility.
 * Returns list with name (derived from filename), full path, and preview.
 */
export async function handleContextsRequest(c: Context) {
  const projectPath = c.req.query("path");
  if (!projectPath) {
    return c.json({ error: "path parameter required" }, 400);
  }

  const resolved = resolve(projectPath);
  // Native Claude Code path first, legacy fallback second
  const searchDirs = [
    join(resolved, ".claude", "agents"),
    join(resolved, "agents"),
  ];

  const contexts: ContextFile[] = [];
  const seen = new Set<string>(); // dedupe by filename

  for (const agentsDir of searchDirs) {
    try {
      const entries = await readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && entry.name.endsWith(".md") && !seen.has(entry.name)) {
          seen.add(entry.name);
          const filePath = join(agentsDir, entry.name);
          const content = await readFile(filePath, "utf-8");
          const name = entry.name.replace(/\.md$/, "").replace(/[-_]/g, " ");
          // First 200 chars as preview (skip frontmatter)
          const body = content.replace(/^---[\s\S]*?---\s*/, "");
          const preview = body.slice(0, 200).trim();
          contexts.push({
            name,
            filename: entry.name,
            path: filePath,
            preview,
          });
        }
      }
    } catch {
      // Directory doesn't exist — continue to next
    }
  }

  return c.json({ contexts });
}
