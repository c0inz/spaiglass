import { Context } from "hono";
import { statSync } from "node:fs";
import type { ProjectInfo, ProjectsResponse } from "../../shared/types.ts";
import { getEncodedProjectName } from "../history/pathUtils.ts";
import { logger } from "../utils/logger.ts";
import { readTextFile } from "../utils/fs.ts";
import { getHomeDir } from "../utils/os.ts";

/**
 * Paths that aren't user projects and should not show up in the Directory
 * dropdown. These get into ~/.claude.json when `claude` is run inside the
 * Spaiglass install itself during debugging, or when the home directory
 * (or a weird child of it like `~/user`) gets picked up accidentally.
 * Filter them out server-side so every client picker is consistent.
 */
function isSpaiglassInternalPath(path: string, homeDir: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const home = homeDir.replace(/\\/g, "/").replace(/\/+$/, "");
  // Exact home dir — nobody wants `/home/<user>` as a project root.
  if (normalized === home) return true;
  const internals = [
    `${home}/spaiglass`,
    `${home}/.spaiglass`,
    `${home}/.claude`,
    `${home}/user`,
  ];
  for (const root of internals) {
    if (normalized === root || normalized.startsWith(root + "/")) return true;
  }
  // Any path whose basename is literally "spaiglass" or ".spaiglass" —
  // catches ~/projects/spaiglass and deeper nestings.
  const basename = normalized.split("/").pop() || "";
  if (basename === "spaiglass" || basename === ".spaiglass") return true;
  return false;
}

/** Drop stale entries: paths that no longer exist on disk. Claude's config
 * never prunes itself, so a directory renamed or deleted months ago still
 * surfaces in the dropdown and breaks RoleResolver when clicked. */
function pathExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Handles GET /api/projects requests
 * Retrieves list of available project directories from Claude configuration
 * @param c - Hono context object
 * @returns JSON response with projects array
 */
export async function handleProjectsRequest(c: Context) {
  try {
    const homeDir = getHomeDir();
    if (!homeDir) {
      return c.json({ error: "Home directory not found" }, 500);
    }

    const claudeConfigPath = `${homeDir}/.claude.json`;

    try {
      const configContent = await readTextFile(claudeConfigPath);
      const config = JSON.parse(configContent);

      if (config.projects && typeof config.projects === "object") {
        const projectPaths = Object.keys(config.projects);

        // Get encoded names for each project, only include projects with
        // history AND drop paths that point at Spaiglass's own install/state
        // dirs (~/spaiglass, ~/.spaiglass, ~/.claude) — those are tooling,
        // not user projects, and would otherwise clutter the Directory
        // dropdown if the user ever ran `claude` inside them.
        const projects: ProjectInfo[] = [];
        for (const path of projectPaths) {
          if (isSpaiglassInternalPath(path, homeDir)) continue;
          if (!pathExists(path)) continue;
          const encodedName = await getEncodedProjectName(path);
          if (encodedName) {
            projects.push({
              path,
              encodedName,
            });
          }
        }

        const response: ProjectsResponse = { projects };
        return c.json(response);
      } else {
        const response: ProjectsResponse = { projects: [] };
        return c.json(response);
      }
    } catch (error) {
      // Handle file not found errors in a cross-platform way
      if (error instanceof Error && error.message.includes("No such file")) {
        const response: ProjectsResponse = { projects: [] };
        return c.json(response);
      }
      throw error;
    }
  } catch (error) {
    logger.api.error("Error reading projects: {error}", { error });
    return c.json({ error: "Failed to read projects" }, 500);
  }
}
