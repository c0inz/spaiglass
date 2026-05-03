/**
 * JSONL file parsing utilities for conversation history
 * Handles reading and parsing Claude conversation history files
 */

import type {
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../utils/logger.ts";
import { readTextFile, readDir } from "../utils/fs.ts";

// Raw JSONL line structure from Claude history files
export interface RawHistoryLine {
  type: "user" | "assistant" | "system" | "result";
  message?: SDKUserMessage["message"] | SDKAssistantMessage["message"];
  sessionId: string;
  timestamp: string; // ISO string format
  uuid: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  userType?: string;
  cwd?: string;
  version?: string;
  requestId?: string;
}

// Legacy interface maintained for transition period
// TODO: Remove once all references are updated to use ConversationHistory
export interface ConversationFile {
  sessionId: string;
  filePath: string;
  messages: RawHistoryLine[];
  messageIds: Set<string>;
  startTime: string;
  lastTime: string;
  messageCount: number;
  lastMessagePreview: string;
  firstUserMessage?: string;
  lastUserMessage?: string;
  userTurnCount: number;
  assistantTurnCount: number;
  filesTouched: string[];
  model?: string;
  cwd?: string;
}

// Pull plain text out of a message.content which can be a string or an
// array of typed blocks (text, tool_use, tool_result, image, etc).
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join(" ").trim();
}

/**
 * Strip injected `<system-reminder>...</system-reminder>` blocks from a
 * user-message text. The Claude Code harness wraps internal reminders
 * (e.g. "respond with just the action", auto-memory loaders) in this tag
 * and embeds them in the user-content stream so the model sees them — but
 * for picker previews the *user's actual prompt* is what we want to show.
 *
 * Removes any tag or its contents (including malformed/unterminated
 * blocks), collapses whitespace, and trims.
 */
function stripSystemReminders(text: string): string {
  if (!text) return text;
  // Greedy-then-non-greedy: drop any pair, then drop any orphan opening
  // tag run-to-end (occasionally observed when content was truncated).
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<system-reminder>[\s\S]*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a single JSONL file and extract conversation data
 * @private - Internal function used by parseAllHistoryFiles
 */
async function parseHistoryFile(
  filePath: string,
): Promise<ConversationFile | null> {
  try {
    const content = await readTextFile(filePath);
    const messageIds = new Set<string>();
    let startTime = "";
    let lastTime = "";
    let lastMessagePreview = "";
    let firstUserMessage = "";
    let lastUserMessage = "";
    let userTurnCount = 0;
    let assistantTurnCount = 0;
    let model: string | undefined;
    let cwd: string | undefined;
    let messageCount = 0;
    // tracks how many times each file path appears in Write/Edit tool_use
    const fileTouchCounts = new Map<string, number>();

    // Parse line-by-line without keeping all parsed objects in memory.
    // Only metadata and messageIds are retained for the listing endpoint.
    let searchStart = 0;
    while (searchStart < content.length) {
      let lineEnd = content.indexOf("\n", searchStart);
      if (lineEnd === -1) lineEnd = content.length;
      const line = content.substring(searchStart, lineEnd).trim();
      searchStart = lineEnd + 1;
      if (!line) continue;

      try {
        const parsed = JSON.parse(line) as RawHistoryLine;
        messageCount++;

        // Capture cwd from any line that has it (they usually agree)
        if (!cwd && typeof parsed.cwd === "string" && parsed.cwd) {
          cwd = parsed.cwd;
        }

        // Track message IDs from assistant messages
        const msg = parsed.message as unknown as Record<string, unknown>;
        if (msg?.role === "assistant" && msg?.id) {
          messageIds.add(msg.id as string);
        }
        if (msg?.role === "assistant" && typeof msg?.model === "string") {
          model = msg.model as string;
        }

        // Track timestamps
        if (!startTime || parsed.timestamp < startTime) {
          startTime = parsed.timestamp;
        }
        if (!lastTime || parsed.timestamp > lastTime) {
          lastTime = parsed.timestamp;
        }

        // Skip sidechain (subagent) messages for turn counting + previews —
        // they're the agent's internal work, not the outer user↔assistant
        // dialogue that the picker summarizes.
        const isSidechain = parsed.isSidechain === true;

        if (parsed.message?.role === "user" && !isSidechain) {
          const rawText = extractText(parsed.message.content);
          // Strip <system-reminder> blocks the harness injects into user
          // turns — those are not what the user actually said and they
          // dominate the picker preview when present (auto-memory hooks,
          // "respond with just the action" reminders, etc).
          const text = stripSystemReminders(rawText);
          // Ignore tool-result-only or reminder-only user turns (no plain
          // text after stripping).
          if (text) {
            userTurnCount++;
            if (!firstUserMessage) firstUserMessage = text.slice(0, 160);
            lastUserMessage = text.slice(0, 160);
          }
        }

        if (parsed.message?.role === "assistant" && !isSidechain) {
          assistantTurnCount++;
          const msgContent = parsed.message.content;
          if (Array.isArray(msgContent)) {
            for (const item of msgContent) {
              if (!item || typeof item !== "object") continue;
              const itype = (item as { type?: unknown }).type;
              if (itype === "text" && typeof (item as { text?: unknown }).text === "string") {
                if (!lastMessagePreview) {
                  lastMessagePreview = String((item as { text: string }).text).slice(0, 100);
                }
                // Update to newest text block we see on later assistant turns
                lastMessagePreview = String((item as { text: string }).text).slice(0, 100);
              } else if (itype === "tool_use") {
                const toolName = (item as { name?: unknown }).name;
                const input = (item as { input?: Record<string, unknown> }).input;
                if (
                  (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") &&
                  input &&
                  typeof input.file_path === "string"
                ) {
                  const fp = input.file_path;
                  fileTouchCounts.set(fp, (fileTouchCounts.get(fp) || 0) + 1);
                }
              }
            }
          } else if (typeof msgContent === "string") {
            lastMessagePreview = msgContent.slice(0, 100);
          }
        }
      } catch (parseError) {
        logger.history.error(`Failed to parse line in ${filePath}: {error}`, {
          error: parseError,
        });
      }
    }

    if (messageCount === 0) {
      return null; // Empty file
    }

    // Extract session ID from file name (remove .jsonl extension)
    const fileName = filePath.split("/").pop() || "";
    const sessionId = fileName.replace(".jsonl", "");

    // Top 5 files by touch count, ties broken by first-seen (Map preserves insertion)
    const filesTouched = [...fileTouchCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([path]) => path);

    return {
      sessionId,
      filePath,
      messages: [],
      messageIds,
      startTime,
      lastTime,
      messageCount,
      lastMessagePreview: lastMessagePreview || "No preview available",
      firstUserMessage: firstUserMessage || undefined,
      lastUserMessage: lastUserMessage || undefined,
      userTurnCount,
      assistantTurnCount,
      filesTouched,
      model,
      cwd,
    };
  } catch (error) {
    logger.history.error(`Failed to read history file ${filePath}: {error}`, {
      error,
    });
    return null;
  }
}

/**
 * Get all JSONL files in a history directory
 * @private - Internal function used by parseAllHistoryFiles
 */
async function getHistoryFiles(historyDir: string): Promise<string[]> {
  try {
    const files: string[] = [];

    for await (const entry of readDir(historyDir)) {
      if (entry.isFile && entry.name.endsWith(".jsonl")) {
        files.push(`${historyDir}/${entry.name}`);
      }
    }

    return files;
  } catch {
    // Directory doesn't exist or can't be read
    return [];
  }
}

/**
 * Parse all conversation files in a history directory
 * Used by the histories endpoint to get conversation summaries
 */
export async function parseAllHistoryFiles(
  historyDir: string,
): Promise<ConversationFile[]> {
  const filePaths = await getHistoryFiles(historyDir);
  const results: ConversationFile[] = [];

  for (const filePath of filePaths) {
    const parsed = await parseHistoryFile(filePath);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * Check if one set of message IDs is a subset of another
 */
export function isSubset<T>(subset: Set<T>, superset: Set<T>): boolean {
  if (subset.size > superset.size) {
    return false;
  }

  for (const item of subset) {
    if (!superset.has(item)) {
      return false;
    }
  }

  return true;
}
