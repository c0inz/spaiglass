/**
 * Individual conversation loading utilities
 * Handles loading and parsing specific conversation files
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
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
import {
  SESSIONS_ROOT,
  type SessionMeta,
} from "../session/persistence.ts";

/**
 * Load a specific conversation by session ID.
 *
 * Two-tier resolution:
 *   1. **Spaiglass-native** (preferred). If we own this session — i.e. there
 *      is a `~/.spaiglass/sessions/<tuple>/meta.json` whose `claudeSessionId`
 *      matches `sessionId` — we serve the persisted Frame[] verbatim from
 *      `frames.jsonl`. That preserves every spaiglass-emitted frame
 *      (`file_delivery`, `context_file`, `interactive_*`, populated
 *      `session_init`, ...) which the SDK JSONL does not carry.
 *   2. **Claude-CLI fallback**. If no spaiglass record exists (e.g. the
 *      session was created by `claude` directly, or pre-dates the
 *      persistence layer), replay `~/.claude/projects/<encoded>/<id>.jsonl`
 *      through `FrameEmitter.emitFromSdkMessage`. This loses spaiglass-only
 *      frame types but keeps cross-tool sessions visible.
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

  // Tier 1: spaiglass-native frames.jsonl, if we own this session.
  const spaiglassNative = await loadSpaiglassNative(sessionId);
  if (spaiglassNative) return spaiglassNative;

  // Tier 2: Claude-CLI JSONL replay (legacy / non-owned sessions).
  const homeDir = getHomeDir();
  if (!homeDir) {
    throw new Error("Home directory not found");
  }

  const historyDir = `${homeDir}/.claude/projects/${encodedProjectName}`;
  const filePath = `${historyDir}/${sessionId}.jsonl`;

  if (!(await exists(filePath))) {
    return null;
  }

  return parseConversationFile(filePath, sessionId);
}

/**
 * Walk `~/.spaiglass/sessions/*` looking for a `meta.json` whose
 * `claudeSessionId === sessionId`. If found, slurp `frames.jsonl` and
 * hand it back as the canonical history. Returns null if no spaiglass
 * record owns this sessionId, so callers can fall through to the
 * SDK-replay path.
 */
async function loadSpaiglassNative(
  sessionId: string,
): Promise<ConversationHistory | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(SESSIONS_ROOT);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const metaPath = join(SESSIONS_ROOT, entry, "meta.json");
    let meta: SessionMeta;
    try {
      const raw = await fs.readFile(metaPath, "utf8");
      meta = JSON.parse(raw) as SessionMeta;
    } catch {
      continue;
    }
    if (meta.claudeSessionId !== sessionId) continue;

    // Match. Read the persisted frames.
    const framesPath = join(SESSIONS_ROOT, entry, "frames.jsonl");
    let raw: string;
    try {
      raw = await fs.readFile(framesPath, "utf8");
    } catch {
      // Meta exists but no frames yet — treat as empty session, not as
      // "not found", so the caller doesn't fall back to the SDK replay
      // (which would risk producing a divergent shape).
      return {
        sessionId,
        frames: [],
        metadata: {
          startTime: new Date(meta.createdAt).toISOString(),
          endTime: new Date(meta.lastActivity).toISOString(),
          messageCount: 0,
        },
      };
    }

    const frames: Frame[] = [];
    let messageCount = 0;
    let firstTs: number | null = null;
    let lastTs: number | null = null;

    for (const line of raw.split("\n")) {
      if (!line) continue;
      let f: Frame;
      try {
        f = JSON.parse(line) as Frame;
      } catch (err) {
        logger.history.error("Skipping malformed frame in {path}: {msg}", {
          path: framesPath,
          msg: String(err),
        });
        continue;
      }
      frames.push(f);
      if (typeof f.ts === "number") {
        if (firstTs === null || f.ts < firstTs) firstTs = f.ts;
        if (lastTs === null || f.ts > lastTs) lastTs = f.ts;
      }
      if (f.type === "user_message" || f.type === "assistant_message") {
        messageCount++;
      }
    }

    return {
      sessionId,
      frames: frames as unknown[],
      metadata: {
        startTime: new Date(firstTs ?? meta.createdAt).toISOString(),
        endTime: new Date(lastTs ?? meta.lastActivity).toISOString(),
        messageCount,
      },
    };
  }

  return null;
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
