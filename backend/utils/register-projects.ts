/**
 * Auto-register every ~/projects/<name>/agents/ directory in ~/.claude.json so
 * Claude Code picks them up. Previously done by a node -e snippet in install.sh;
 * now lives in the host binary so the Phase 3 installer can drop the node
 * prerequisite entirely.
 *
 * Idempotent: only writes ~/.claude.json if at least one project was added.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger.ts";

interface ClaudeProject {
  allowedTools: string[];
  history: unknown[];
  mcpContextUris: string[];
  mcpServers: Record<string, unknown>;
  enabledMcpjsonServers: string[];
  disabledMcpjsonServers: string[];
  hasTrustDialogAccepted: boolean;
  projectOnboardingSeenCount: number;
  hasClaudeMdExternalIncludesApproved: boolean;
  hasClaudeMdExternalIncludesWarningShown: boolean;
}

interface ClaudeJson {
  projects?: Record<string, ClaudeProject>;
  [k: string]: unknown;
}

function defaultProject(): ClaudeProject {
  return {
    allowedTools: [],
    history: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: false,
    projectOnboardingSeenCount: 0,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
  };
}

// Match Claude Code's path-encoding scheme: replace /, \, :, ., _ with -
function encodePath(p: string): string {
  return p.replace(/[/\\:._]/g, "-");
}

export function registerProjects(): void {
  const HOME = homedir();
  const projectsRoot = join(HOME, "projects");
  const claudeJsonPath = join(HOME, ".claude.json");
  const claudeProjectsDir = join(HOME, ".claude", "projects");

  if (!existsSync(projectsRoot)) {
    return;
  }

  let claudeJson: ClaudeJson = { projects: {} };
  if (existsSync(claudeJsonPath)) {
    try {
      claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    } catch {
      claudeJson = { projects: {} };
    }
  }
  claudeJson.projects = claudeJson.projects || {};

  let registered = 0;
  let createdDirs = 0;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const projDir = join(projectsRoot, entry.name);
    // Check native .claude/agents/ first, then legacy agents/
    if (!existsSync(join(projDir, ".claude", "agents")) &&
        !existsSync(join(projDir, "agents"))) continue;

    if (!claudeJson.projects[projDir]) {
      claudeJson.projects[projDir] = defaultProject();
      registered++;
    }

    const targetDir = join(claudeProjectsDir, encodePath(projDir));
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
      createdDirs++;
    }
  }

  if (registered > 0 || createdDirs > 0) {
    try {
      writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
    } catch (err) {
      logger.cli.warn(
        `Failed to write ~/.claude.json: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    logger.cli.info(
      `📁 Auto-registered ${registered} project(s), created ${createdDirs} project dir(s)`,
    );
  }
}
