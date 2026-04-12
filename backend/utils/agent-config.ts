/**
 * agent-config.ts — Parse .claude/agents/<role>.md YAML frontmatter.
 *
 * SpAIglass reads frontmatter from role files to configure sessions:
 * plugins (loaded via CLI commands at session start), mcpServers,
 * tool permissions, model overrides, etc.
 */

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
      if (stripped.startsWith("- ")) {
        if (!Array.isArray(currentValue)) {
          currentValue = [];
        }
        (currentValue as unknown[]).push(parseYamlScalar(stripped.slice(2).trim()));
      } else if (stripped.includes(":")) {
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
      currentKey = key;
      currentValue = null;
    } else {
      frontmatter[key] = parseYamlScalar(rawVal);
      currentKey = key;
      currentValue = null;
    }
  }

  if (currentKey && currentValue !== null) {
    frontmatter[currentKey] = currentValue;
  }

  return { frontmatter: frontmatter as AgentFrontmatter, body };
}

function parseYamlScalar(val: string): unknown {
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "null" || val === "~") return null;
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  const num = Number(val);
  if (!isNaN(num) && val !== "") return num;
  return val;
}
