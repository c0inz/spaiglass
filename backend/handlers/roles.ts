/**
 * Roles & Plugins API handlers.
 *
 * GET  /api/plugins?path=<project>          — installed plugins + per-role status
 * GET  /api/roles?path=<project>            — all roles with plugin configs
 * POST /api/roles?path=<project>            — create a new role
 * PUT  /api/roles/:name?path=<project>      — update a role's plugin config
 */

import type { Context } from "hono";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseAgentFile, type AgentFrontmatter } from "../utils/agent-config.ts";

/* ── Types ────────────────────────────────────────────────────────── */

interface PluginInfo {
  /** e.g. "superpowers@claude-plugins-official" */
  id: string;
  /** Display name derived from id */
  name: string;
  /** Whether the user has this plugin installed globally */
  installed: boolean;
}

interface RoleInfo {
  /** Role display name (filename without .md, dashes/underscores → spaces) */
  name: string;
  /** Filename on disk */
  filename: string;
  /** Full path to .md file */
  path: string;
  /** Which directory it was found in: "native" (.claude/agents/) or "legacy" (agents/) */
  source: "native" | "legacy";
  /** Plugin enable/disable map from frontmatter */
  plugins: Record<string, boolean>;
  /** Preview of role description (first 200 chars of body) */
  preview: string;
}

/* ── Helpers ──────────────────────────────────────────────────────── */

/** Read the global installed plugins from ~/.claude/settings.json */
function getInstalledPlugins(): Record<string, boolean> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  try {
    if (!existsSync(settingsPath)) return {};
    const raw = JSON.parse(
      require("node:fs").readFileSync(settingsPath, "utf-8"),
    );
    return (raw.enabledPlugins as Record<string, boolean>) || {};
  } catch {
    return {};
  }
}

/** Scan for role .md files in .claude/agents/ and agents/ */
async function scanRoles(projectPath: string): Promise<RoleInfo[]> {
  const resolved = resolve(projectPath);
  const searchDirs: { dir: string; source: "native" | "legacy" }[] = [
    { dir: join(resolved, ".claude", "agents"), source: "native" },
    { dir: join(resolved, "agents"), source: "legacy" },
  ];

  const roles: RoleInfo[] = [];
  const seen = new Set<string>();

  for (const { dir, source } of searchDirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          !entry.isDirectory() &&
          entry.name.endsWith(".md") &&
          !seen.has(entry.name)
        ) {
          seen.add(entry.name);
          const filePath = join(dir, entry.name);
          const content = await readFile(filePath, "utf-8");
          const parsed = parseAgentFile(content);
          const name = entry.name
            .replace(/\.md$/, "")
            .replace(/[-_]/g, " ");
          const body = content.replace(/^---[\s\S]*?---\s*/, "");
          const preview = body.slice(0, 200).trim();

          roles.push({
            name,
            filename: entry.name,
            path: filePath,
            source,
            plugins: parsed.frontmatter.plugins || {},
            preview,
          });
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  return roles;
}

/** Serialize frontmatter back to YAML string */
function serializeFrontmatter(fm: AgentFrontmatter): string {
  const lines: string[] = [];

  if (fm.plugins && Object.keys(fm.plugins).length > 0) {
    lines.push("plugins:");
    for (const [k, v] of Object.entries(fm.plugins)) {
      lines.push(`  ${k}: ${v}`);
    }
  }
  if (fm.mcpServers && Object.keys(fm.mcpServers).length > 0) {
    lines.push("mcpServers:");
    for (const [k, v] of Object.entries(fm.mcpServers)) {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  }
  if (fm.tools && fm.tools.length > 0) {
    lines.push("tools:");
    for (const t of fm.tools) lines.push(`  - ${t}`);
  }
  if (fm.disallowedTools && fm.disallowedTools.length > 0) {
    lines.push("disallowedTools:");
    for (const t of fm.disallowedTools) lines.push(`  - ${t}`);
  }
  if (fm.model) lines.push(`model: ${fm.model}`);
  if (fm.permissionMode) lines.push(`permissionMode: ${fm.permissionMode}`);
  if (fm.maxTurns) lines.push(`maxTurns: ${fm.maxTurns}`);
  if (fm.effort) lines.push(`effort: ${fm.effort}`);

  return lines.join("\n");
}

/* ── Handlers ─────────────────────────────────────────────────────── */

/**
 * GET /api/plugins?path=<project>
 * Returns all installed plugins and their status across roles.
 */
export async function handleGetPlugins(c: Context) {
  const projectPath = c.req.query("path");
  if (!projectPath) return c.json({ error: "path parameter required" }, 400);

  const globalPlugins = getInstalledPlugins();
  const roles = await scanRoles(projectPath);

  // Build plugin list with installed status
  const plugins: PluginInfo[] = Object.keys(globalPlugins).map((id) => ({
    id,
    name: id.split("@")[0].replace(/[-_]/g, " "),
    installed: true,
  }));

  return c.json({ plugins, globalPlugins, roles });
}

/**
 * GET /api/roles?path=<project>
 * Returns all roles with their plugin configurations.
 */
export async function handleGetRoles(c: Context) {
  const projectPath = c.req.query("path");
  if (!projectPath) return c.json({ error: "path parameter required" }, 400);

  const roles = await scanRoles(projectPath);
  const globalPlugins = getInstalledPlugins();

  return c.json({ roles, globalPlugins });
}

/**
 * PUT /api/roles/:name?path=<project>
 * Update a role's plugin configuration in its frontmatter.
 * Body: { plugins: { "name@marketplace": true/false } }
 */
export async function handleUpdateRole(c: Context) {
  const projectPath = c.req.query("path");
  const roleName = c.req.param("name");
  if (!projectPath) return c.json({ error: "path parameter required" }, 400);
  if (!roleName) return c.json({ error: "role name required" }, 400);

  const body = await c.req.json<{ plugins?: Record<string, boolean> }>();
  if (!body.plugins) return c.json({ error: "plugins field required" }, 400);

  // Find the role file
  const resolved = resolve(projectPath);
  const filename = roleName.endsWith(".md") ? roleName : `${roleName}.md`;
  const nativePath = join(resolved, ".claude", "agents", filename);
  const legacyPath = join(resolved, "agents", filename);
  const rolePath = existsSync(nativePath)
    ? nativePath
    : existsSync(legacyPath)
      ? legacyPath
      : null;

  if (!rolePath) {
    return c.json({ error: `Role file not found: ${filename}` }, 404);
  }

  // Parse existing content
  const content = await readFile(rolePath, "utf-8");
  const parsed = parseAgentFile(content);

  // Update plugins in frontmatter
  parsed.frontmatter.plugins = body.plugins;

  // Rebuild the file
  const fmYaml = serializeFrontmatter(parsed.frontmatter);
  const newContent = fmYaml
    ? `---\n${fmYaml}\n---\n\n${parsed.body}`
    : parsed.body;

  await writeFile(rolePath, newContent, "utf-8");

  return c.json({ ok: true, path: rolePath });
}

/**
 * POST /api/roles?path=<project>
 * Create a new role file.
 * Body: { name: string, description: string, plugins?: Record<string, boolean> }
 */
export async function handleCreateRole(c: Context) {
  const projectPath = c.req.query("path");
  if (!projectPath) return c.json({ error: "path parameter required" }, 400);

  const body = await c.req.json<{
    name: string;
    description: string;
    plugins?: Record<string, boolean>;
  }>();

  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  if (!body.description?.trim())
    return c.json({ error: "description required" }, 400);

  // Sanitize name to filename
  const safeName = body.name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  if (!safeName) return c.json({ error: "invalid role name" }, 400);

  const filename = `${safeName}.md`;
  const resolved = resolve(projectPath);
  const agentsDir = join(resolved, ".claude", "agents");
  const rolePath = join(agentsDir, filename);

  if (existsSync(rolePath)) {
    return c.json({ error: `Role already exists: ${filename}` }, 409);
  }

  // Build frontmatter
  const fm: AgentFrontmatter = {};
  if (body.plugins && Object.keys(body.plugins).length > 0) {
    fm.plugins = body.plugins;
  }

  const fmYaml = serializeFrontmatter(fm);
  const content = fmYaml
    ? `---\n${fmYaml}\n---\n\n${body.description.trim()}\n`
    : `${body.description.trim()}\n`;

  await mkdir(agentsDir, { recursive: true });
  await writeFile(rolePath, content, "utf-8");

  return c.json({
    ok: true,
    role: {
      name: safeName.replace(/-/g, " "),
      filename,
      path: rolePath,
      source: "native" as const,
      plugins: fm.plugins || {},
      preview: body.description.slice(0, 200),
    },
  });
}
