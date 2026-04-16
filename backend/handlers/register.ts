/**
 * POST /api/projects/register
 *
 * One-shot project + role registration. Creates everything needed for a
 * project to appear in the SpAIglass dropdown:
 *
 *   1. ~/projects/{name}/                     — project directory
 *   2. ~/projects/{name}/.claude/agents/{role}.md — role file
 *   3. ~/.claude.json projects entry           — Claude Code config
 *   4. ~/.claude/projects/{encoded}/           — Claude Code project dir
 *
 * Body: { name: string, role: string, roleContent?: string }
 *
 *   name        — project directory name (e.g. "BHMarketing")
 *   role        — role filename without .md (e.g. "developer")
 *   roleContent — optional markdown content for the role file.
 *                  If omitted, a default template is written.
 *
 * Idempotent: safe to call again on an existing project. Overwrites the
 * role file if it already exists; does not touch other files in the project.
 */

import type { Context } from "hono";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { registerProjects } from "../utils/register-projects.ts";
import { logger } from "../utils/logger.ts";

// Reject names that could escape the projects directory
const SAFE_NAME = /^[A-Za-z0-9][\w.-]{0,99}$/;

export async function handleRegisterProject(c: Context) {
  let body: { name?: string; role?: string; roleContent?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const role = typeof body.role === "string" ? body.role.trim().replace(/\.md$/, "") : "";

  if (!name || !SAFE_NAME.test(name)) {
    return c.json(
      { error: "name is required and must be alphanumeric (A-Z, 0-9, -, _, .)" },
      400,
    );
  }
  if (!role || !SAFE_NAME.test(role)) {
    return c.json(
      { error: "role is required and must be alphanumeric (A-Z, 0-9, -, _, .)" },
      400,
    );
  }

  const HOME = homedir();
  const projectDir = join(HOME, "projects", name);
  const agentsDir = join(projectDir, ".claude", "agents");
  const roleFile = join(agentsDir, `${role}.md`);

  const roleContent =
    typeof body.roleContent === "string" && body.roleContent.trim()
      ? body.roleContent.trim()
      : `You are the ${role} for ${name}.\n\n## Project Location\n~/projects/${name}/\n`;

  try {
    // 1. Create project dir + .claude/agents/
    mkdirSync(agentsDir, { recursive: true });

    // 2. Write role file
    writeFileSync(roleFile, roleContent + "\n", "utf-8");

    // 3+4. Register in ~/.claude.json + create ~/.claude/projects/{encoded}/
    registerProjects();

    logger.api.info(`Registered project ${name} with role ${role}`);

    return c.json({
      ok: true,
      project: name,
      role,
      roleFile,
      projectDir,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.api.error(`Failed to register project ${name}: ${msg}`);
    return c.json({ error: msg }, 500);
  }
}
