/**
 * Flat Claude session listing.
 *
 * Walks ~/.claude/projects/<encoded>/<sessionId>.jsonl across every project
 * directory and returns a single recency-ordered list. Cross-references
 * ~/.spaiglass/sessions/*\/meta.json so each row is tagged as either:
 *   - "spaiglass"  — created by SpaiGlass (we know the workingDirectory + roleFile)
 *   - "claude-cli" — created via terminal `claude`, no spaiglass project mapping
 *
 * This matches the mental model of `claude --resume`: pick a session by what
 * you said, not by which project it lives under.
 */

import { Context } from "hono";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ConversationSummary } from "../../shared/types.ts";
import { parseAllHistoryFiles } from "../history/parser.ts";
import { groupConversations } from "../history/grouping.ts";
import { logger } from "../utils/logger.ts";

interface SpaiglassSessionMeta {
  id: string;
  userId: string;
  workingDirectory: string;
  roleFile: string;
  claudeSessionId?: string;
  createdAt: number;
  lastActivity: number;
}

export interface ClaudeSessionRow extends ConversationSummary {
  source: "spaiglass" | "claude-cli";
  /** Encoded directory name under ~/.claude/projects/ (e.g. "-home-foo-bar"). */
  encodedProject: string;
  /** Decoded project path (e.g. "/home/foo/bar") for display. */
  projectPath: string;
  /** SpaiGlass-tracked working directory if source === "spaiglass". */
  spaiglassWorkingDirectory?: string;
  /** SpaiGlass-tracked role file if source === "spaiglass". */
  spaiglassRoleFile?: string;
}

function decodeProjectPath(encoded: string): string {
  // SDK encodes cwd by replacing each '/' with '-' and prefixing '-'.
  // e.g. "/home/readystack/projects/Daniel" → "-home-readystack-projects-Daniel".
  if (!encoded.startsWith("-")) return encoded;
  return "/" + encoded.slice(1).replace(/-/g, "/");
}

async function loadSpaiglassSessionMap(): Promise<Map<string, SpaiglassSessionMeta>> {
  const root = join(homedir(), ".spaiglass", "sessions");
  const out = new Map<string, SpaiglassSessionMeta>();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return out; // ~/.spaiglass/sessions doesn't exist yet — fine, all sessions are claude-cli.
  }
  await Promise.all(
    entries.map(async (d) => {
      try {
        const raw = await fs.readFile(join(root, d, "meta.json"), "utf8");
        const meta = JSON.parse(raw) as SpaiglassSessionMeta;
        if (meta.claudeSessionId) out.set(meta.claudeSessionId, meta);
      } catch {
        // Ignore unreadable / malformed meta files.
      }
    }),
  );
  return out;
}

/**
 * GET /api/claude-sessions
 * Returns: { sessions: ClaudeSessionRow[] } sorted newest-first by lastTime.
 */
export async function handleClaudeSessionsRequest(c: Context) {
  try {
    const projectsRoot = join(homedir(), ".claude", "projects");

    let dirNames: string[];
    try {
      const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
      dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return c.json({ sessions: [] });
    }

    const sgMap = await loadSpaiglassSessionMap();
    const rows: ClaudeSessionRow[] = [];

    for (const dirName of dirNames) {
      const fullDir = join(projectsRoot, dirName);
      try {
        const files = await parseAllHistoryFiles(fullDir);
        const summaries = groupConversations(files);
        const projectPath = decodeProjectPath(dirName);
        for (const s of summaries) {
          const sg = sgMap.get(s.sessionId);
          rows.push({
            ...s,
            source: sg ? "spaiglass" : "claude-cli",
            encodedProject: dirName,
            projectPath,
            spaiglassWorkingDirectory: sg?.workingDirectory,
            spaiglassRoleFile: sg?.roleFile,
          });
        }
      } catch (err) {
        logger.history.debug(
          `Skipping unparseable project dir ${fullDir}: ${String(err)}`,
        );
      }
    }

    rows.sort(
      (a, b) => new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime(),
    );

    return c.json({ sessions: rows });
  } catch (error) {
    logger.history.error("Error fetching claude sessions: {error}", { error });
    return c.json({ error: "Failed to fetch claude sessions" }, 500);
  }
}
