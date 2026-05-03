/**
 * POST /api/projects/register
 *
 * Register a directory so it shows up in the SpAIglass Directory dropdown.
 * Writes the entry into ~/.claude.json's `projects` map and creates the
 * encoded session dir under ~/.claude/projects/<encoded>/ so Claude Code
 * can persist transcripts for it.
 *
 * Body: { name?: string, path?: string, role?: string, roleContent?: string }
 *
 *   name        — directory basename (required unless `path` is given).
 *                 Must be alphanumeric [A-Za-z0-9][\w.-]{0,99}.
 *                 Without `path`, the directory defaults to ~/projects/{name}.
 *   path        — absolute path to register. If given, this path is used
 *                 verbatim and `name` is derived from the basename when
 *                 omitted. Use this to add a directory that already lives
 *                 outside ~/projects/ (e.g. ~/code/foo).
 *   role        — OPTIONAL role filename without .md. If provided, a role
 *                 file is written to {dir}/.claude/agents/{role}.md. In
 *                 the Server+Directory model roles are optional, so you
 *                 may omit this entirely.
 *   roleContent — optional markdown content for the role file. Ignored
 *                 when role is omitted.
 *
 * Idempotent: re-calling with the same path is a no-op on ~/.claude.json
 * (beyond the first call). If `role` is provided, the role file is
 * (re)written each call.
 */

import type { Context } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../utils/logger.ts";

const SAFE_NAME = /^[A-Za-z0-9][\w.-]{0,99}$/;

function defaultProjectEntry() {
  return {
    allowedTools: [] as string[],
    history: [] as unknown[],
    mcpContextUris: [] as string[],
    mcpServers: {} as Record<string, unknown>,
    enabledMcpjsonServers: [] as string[],
    disabledMcpjsonServers: [] as string[],
    hasTrustDialogAccepted: false,
    projectOnboardingSeenCount: 0,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
  };
}

// Match Claude Code's path-encoding: replace /, \, :, ., _ with -
function encodePath(p: string): string {
  return p.replace(/[/\\:._]/g, "-");
}

export async function handleRegisterProject(c: Context) {
  let body: {
    name?: string;
    path?: string;
    role?: string;
    roleContent?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const rawPath = typeof body.path === "string" ? body.path.trim() : "";
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  const rawRole =
    typeof body.role === "string" ? body.role.trim().replace(/\.md$/, "") : "";

  if (!rawPath && !rawName) {
    return c.json({ error: "either 'name' or 'path' is required" }, 400);
  }
  if (rawPath && !isAbsolute(rawPath)) {
    return c.json({ error: "path must be absolute" }, 400);
  }

  const HOME = homedir();
  const projectDir = rawPath
    ? rawPath.replace(/\/+$/, "")
    : join(HOME, "projects", rawName);
  const name = rawName || basename(projectDir);

  if (!SAFE_NAME.test(name)) {
    return c.json(
      { error: "name must be alphanumeric (A-Z, 0-9, -, _, .)" },
      400,
    );
  }
  if (rawRole && !SAFE_NAME.test(rawRole)) {
    return c.json(
      { error: "role must be alphanumeric (A-Z, 0-9, -, _, .)" },
      400,
    );
  }

  const claudeJsonPath = join(HOME, ".claude.json");
  const encodedDir = join(HOME, ".claude", "projects", encodePath(projectDir));

  try {
    mkdirSync(projectDir, { recursive: true });

    let roleFile: string | undefined;
    if (rawRole) {
      const agentsDir = join(projectDir, ".claude", "agents");
      mkdirSync(agentsDir, { recursive: true });
      roleFile = join(agentsDir, `${rawRole}.md`);
      const roleContent =
        typeof body.roleContent === "string" && body.roleContent.trim()
          ? body.roleContent.trim()
          : `You are the ${rawRole} for ${name}.\n\n## Project Location\n${projectDir}/\n`;
      writeFileSync(roleFile, roleContent + "\n", "utf-8");
    }

    let claudeJson: {
      projects?: Record<string, unknown>;
      [k: string]: unknown;
    } = { projects: {} };
    if (existsSync(claudeJsonPath)) {
      try {
        claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
      } catch {
        claudeJson = { projects: {} };
      }
    }
    claudeJson.projects = claudeJson.projects || {};
    const added = !claudeJson.projects[projectDir];
    if (added) {
      claudeJson.projects[projectDir] = defaultProjectEntry();
      writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
    }

    if (!existsSync(encodedDir)) {
      mkdirSync(encodedDir, { recursive: true });
    }

    logger.api.info(
      `Registered project ${name} at ${projectDir}${rawRole ? ` with role ${rawRole}` : ""}`,
    );

    return c.json({
      ok: true,
      project: name,
      path: projectDir,
      added,
      role: rawRole || undefined,
      roleFile,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.api.error(`Failed to register project ${name}: ${msg}`);
    return c.json({ error: msg }, 500);
  }
}
