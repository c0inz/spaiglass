/**
 * Individual conversation loading utilities
 * Handles loading and parsing specific conversation files
 */

import type { RawHistoryLine } from "./parser.ts";
import type { ConversationHistory } from "../../shared/types.ts";
import type { Frame } from "../../shared/frames.ts";
import { logger } from "../utils/logger.ts";
import {
  sortMessagesByTimestamp,
  restoreTimestamps,
  calculateConversationMetadata,
} from "./timestampRestore.ts";
import { validateEncodedProjectName } from "./pathUtils.ts";
import { readTextFile, exists } from "../utils/fs.ts";
import { getHomeDir } from "../utils/os.ts";
import { FrameEmitter, type SdkMessageLike } from "../session/frame-emitter.ts";

/**
 * Load a specific conversation by session ID
 */
export async function loadConversation(
  encodedProjectName: string,
  sessionId: string,
): Promise<ConversationHistory | null> {
  // Validate inputs
  if (!validateEncodedProjectName(encodedProjectName)) {
    throw new Error("Invalid encoded project name");
  }

  if (!validateSessionId(sessionId)) {
    throw new Error("Invalid session ID format");
  }

  // Get home directory
  const homeDir = getHomeDir();
  if (!homeDir) {
    throw new Error("Home directory not found");
  }

  // Build file path
  const historyDir = `${homeDir}/.claude/projects/${encodedProjectName}`;
  const filePath = `${historyDir}/${sessionId}.jsonl`;

  // Check if file exists before trying to read it
  if (!(await exists(filePath))) {
    return null; // Session not found
  }

  try {
    const conversationHistory = await parseConversationFile(
      filePath,
      sessionId,
    );
    return conversationHistory;
  } catch (error) {
    throw error; // Re-throw any parsing errors
  }
}

/**
 * Parse a specific conversation file.
 *
 * Phase B: we replay the JSONL through a fresh {@link FrameEmitter} so the
 * history endpoint returns pre-cooked terminal `Frame[]` — the same shape
 * the live WebSocket emits. The frontend just feeds the array into
 * `buildFrameState` and replay/live paths render identically by construction.
 */
async function parseConversationFile(
  filePath: string,
  sessionId: string,
): Promise<ConversationHistory> {
  const content = await readTextFile(filePath);
  const lines = content
    .trim()
    .split("\n")
    .filter((line) => line.trim());

  if (lines.length === 0) {
    throw new Error("Empty conversation file");
  }

  const rawLines: RawHistoryLine[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as RawHistoryLine;
      rawLines.push(parsed);
    } catch (parseError) {
      logger.history.error(`Failed to parse line in ${filePath}: {error}`, {
        error: parseError,
      });
      // Continue processing other lines
    }
  }

  // Restore timestamps and sort chronologically — mirrors the legacy flow.
  const ordered = sortMessagesByTimestamp(restoreTimestamps(rawLines));
  const metadata = calculateConversationMetadata(ordered);

  // Server-side replay: one fresh emitter per request keeps tool_use_id
  // correlation scoped to this session.
  const emitter = new FrameEmitter();
  const frames: Frame[] = [];
  let seq = 0;
  const nextSeq = () => ++seq;

  for (const line of ordered) {
    if (!line.message) continue;
    // The stored JSONL top-level line has { type, message, ... }. The
    // emitter expects an SdkMessageLike with { type, message, ... } plus
    // any top-level SDK fields (session_id, subtype, toolUseResult, ...).
    // Cast the line itself — the RawHistoryLine keys overlap cleanly.
    const sdk = line as unknown as SdkMessageLike;
    const ts = Date.parse(line.timestamp) || Date.now();
    const out = emitter.emitFromSdkMessage(sdk, { nextSeq, ts });
    for (const f of out) frames.push(f);
  }

  return {
    sessionId,
    frames: frames as unknown[],
    metadata,
  };
}

/**
 * Validate session ID format
 * Should be a valid filename without dangerous characters
 */
function validateSessionId(sessionId: string): boolean {
  // Should not be empty
  if (!sessionId) {
    return false;
  }

  // Should not contain dangerous characters for filenames
  // deno-lint-ignore no-control-regex
  const dangerousChars = /[<>:"|?*\x00-\x1f\/\\]/;
  if (dangerousChars.test(sessionId)) {
    return false;
  }

  // Should not be too long (reasonable filename length)
  if (sessionId.length > 255) {
    return false;
  }

  // Should not start with dots (hidden files)
  if (sessionId.startsWith(".")) {
    return false;
  }

  return true;
}

/**
 * Check if a conversation exists without loading it
 */
export async function conversationExists(
  encodedProjectName: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const conversation = await loadConversation(encodedProjectName, sessionId);
    return conversation !== null;
  } catch {
    return false;
  }
}
