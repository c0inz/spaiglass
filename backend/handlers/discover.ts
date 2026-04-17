import type { Context } from "hono";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

interface RoleInfo {
  name: string;
  filename: string;
  path: string;
}

interface ProjectInfo {
  name: string;
  path: string;
  roles: RoleInfo[];
}

/**
 * GET /api/discover?projectsDir=<path>
 * Scans projectsDir for subdirectories containing .claude/agents/*.md files.
 * Falls back to agents/ for backward compatibility.
 * Returns projects with roles and unassigned projects.
 */
export async function handleDiscoverRequest(c: Context) {
  const projectsDir = c.req.query("projectsDir");
  if (!projectsDir) {
    return c.json({ error: "projectsDir parameter required" }, 400);
  }

  const resolved = resolve(projectsDir);
  const projects: ProjectInfo[] = [];
  const unassigned: { name: string; path: string }[] = [];

  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    for (const entry of entries) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;

      const projectPath = join(resolved, entry.name);
      // Check .claude/agents/ first (native), then agents/ (legacy)
      const agentsDirs = [
        join(projectPath, ".claude", "agents"),
        join(projectPath, "agents"),
      ];

      const roles: RoleInfo[] = [];
      const seen = new Set<string>();

      for (const agentsDir of agentsDirs) {
        try {
          const agentFiles = await readdir(agentsDir, { withFileTypes: true });
          for (const af of agentFiles) {
            if (!af.isDirectory() && af.name.endsWith(".md") && !seen.has(af.name)) {
              seen.add(af.name);
              roles.push({
                name: af.name.replace(/\.md$/, "").replace(/[-_]/g, " "),
                filename: af.name,
                path: join(agentsDir, af.name),
              });
            }
          }
        } catch {
          // Directory doesn't exist — try next
        }
      }

      if (roles.length > 0) {
        projects.push({ name: entry.name, path: projectPath, roles });
      } else {
        unassigned.push({ name: entry.name, path: projectPath });
      }
    }
  } catch (err) {
    return c.json({ error: `Failed to scan: ${(err as Error).message}` }, 500);
  }

  return c.json({ projects, unassigned });
}
