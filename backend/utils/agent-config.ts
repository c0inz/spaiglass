/**
 * agent-config.ts — Parse .claude/agents/<role>.md frontmatter and
 * prepare per-role CLAUDE_CONFIG_DIR with isolated settings.
 *
 * SpAIglass extends the native Claude Code agent convention by giving
 * each role its own config directory (via CLAUDE_CONFIG_DIR). This lets
 * different roles on the same project have different plugins enabled,
 * different MCP servers, different tool permissions — full isolation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger.ts";

/** Parsed agent frontmatter fields that SpAIglass acts on. */
export interface AgentFrontmatter {
  /** Plugin enable/disable map: { "name@marketplace": true/false } */
  plugins?: Record<string, boolean>;
  /** MCP servers to register for this role's sessions */
  mcpServers?: Record<string, unknown>;
  /** Tools to allow (whitelist) */
  tools?: string[];
  /** Tools to block */
  disallowedTools?: string[];
  /** Claude model override */
  model?: string;
  /** Permission mode override */
  permissionMode?: string;
  /** Max conversation turns */
  maxTurns?: number;
  /** Thinking/effort config */
  effort?: string;
}

/** Result of parsing an agent .md file */
export interface ParsedAgent {
  /** The YAML frontmatter fields */
  frontmatter: AgentFrontmatter;
  /** The markdown body (system prompt content) */
  body: string;
}

/**
 * Parse YAML frontmatter from an agent .md file.
 * Handles the --- delimited block at the top of the file.
 * Uses a simple parser to avoid adding a YAML dependency.
 */
export function parseAgentFile(content: string): ParsedAgent {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trim();

  // Simple YAML parser for the flat/shallow structures we support.
  // Handles: scalars, arrays (- item), and one-level objects (key: val).
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlBlock.split("\n");
  let currentKey: string | null = null;
  let currentValue: unknown[] | Record<string, unknown> | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    // Indented line — part of a collection under currentKey
    if (/^\s{2,}/.test(line) && currentKey) {
      const stripped = line.trim();
      // Array item: "- value"
      if (stripped.startsWith("- ")) {
        if (!Array.isArray(currentValue)) {
          currentValue = [];
        }
        (currentValue as unknown[]).push(parseYamlScalar(stripped.slice(2).trim()));
      }
      // Object entry: "key: value"
      else if (stripped.includes(":")) {
        if (currentValue === null || Array.isArray(currentValue)) {
          currentValue = {};
        }
        const colonIdx = stripped.indexOf(":");
        const k = stripped.slice(0, colonIdx).trim();
        const v = stripped.slice(colonIdx + 1).trim();
        (currentValue as Record<string, unknown>)[k] = parseYamlScalar(v);
      }
      continue;
    }

    // Flush previous key
    if (currentKey && currentValue !== null) {
      frontmatter[currentKey] = currentValue;
      currentValue = null;
    }

    // Top-level key: value
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();

    if (rawVal === "" || rawVal === "|") {
      // Collection or block scalar follows on next lines
      currentKey = key;
      currentValue = null;
    } else {
      frontmatter[key] = parseYamlScalar(rawVal);
      currentKey = key;
      currentValue = null;
    }
  }

  // Flush last key
  if (currentKey && currentValue !== null) {
    frontmatter[currentKey] = currentValue;
  }

  return { frontmatter: frontmatter as AgentFrontmatter, body };
}

function parseYamlScalar(val: string): unknown {
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "null" || val === "~") return null;
  // Remove quotes
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  const num = Number(val);
  if (!isNaN(num) && val !== "") return num;
  return val;
}

/**
 * Prepare a per-role config directory and return the path to use as
 * CLAUDE_CONFIG_DIR. Creates the directory structure if it doesn't exist,
 * writes settings.json with the role's enabledPlugins.
 *
 * Directory layout:
 *   <workingDir>/.claude/agent-configs/<roleName>/
 *     settings.json   — role-specific enabledPlugins + any settings overrides
 *
 * The base user config (~/.claude/) is copied/symlinked for essentials
 * like oauth credentials, so the spawned session can authenticate.
 */
export function prepareRoleConfigDir(
  workingDirectory: string,
  roleName: string,
  frontmatter: AgentFrontmatter,
): string {
  const configBase = join(workingDirectory, ".claude", "agent-configs", roleName);

  // Create the config directory
  mkdirSync(configBase, { recursive: true });

  // Build role-specific settings.json
  const settings: Record<string, unknown> = {};

  if (frontmatter.plugins) {
    settings.enabledPlugins = frontmatter.plugins;
  }

  // Write settings.json for this role
  writeFileSync(
    join(configBase, "settings.json"),
    JSON.stringify(settings, null, 2),
  );

  // Ensure auth credentials are available. CLAUDE_CONFIG_DIR replaces ~/.claude/,
  // so the spawned session needs access to OAuth tokens. We copy the essential
  // auth files from the real ~/.claude/ into the role config dir.
  const realClaudeDir = join(homedir(), ".claude");
  const authFiles = ["credentials.json", ".credentials.json", "statsig_cache.json"];
  for (const file of authFiles) {
    const src = join(realClaudeDir, file);
    const dst = join(configBase, file);
    if (existsSync(src) && !existsSync(dst)) {
      try {
        // Symlink to avoid duplication and stay in sync
        const { symlinkSync } = require("node:fs");
        symlinkSync(src, dst);
      } catch {
        // Fallback: copy if symlink fails (e.g., Windows)
        try {
          writeFileSync(dst, readFileSync(src));
        } catch {
          // Non-fatal — session may still authenticate via other means
        }
      }
    }
  }

  logger.app.info(
    "Prepared role config dir for {roleName} at {configBase}",
    { roleName, configBase },
  );

  return configBase;
}

/**
 * Build the env object for startup() that includes CLAUDE_CONFIG_DIR
 * and any existing spawn env (e.g., ANTHROPIC_API_KEY).
 */
export function buildRoleEnv(
  configDir: string,
  existingEnv?: Record<string, string>,
): Record<string, string> {
  return {
    ...(existingEnv || {}),
    CLAUDE_CONFIG_DIR: configDir,
  };
}
