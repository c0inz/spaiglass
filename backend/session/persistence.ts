/**
 * Session transcript persistence.
 *
 * Every frame broadcast by SessionManager is appended to a per-tuple
 * `frames.jsonl` on disk. The tuple is (userId, workingDirectory, roleFile),
 * hashed into a stable directory so a fresh process/session can find and
 * replay the same history.
 *
 * Layout under ~/.spaiglass/sessions/:
 *   <tupleHash>/
 *     meta.json      — { id, userId, workingDirectory, roleFile,
 *                        claudeSessionId?, createdAt, lastActivity }
 *     frames.jsonl   — one JSON-encoded Frame per line
 *
 * Writes are serialized through a per-session Promise chain so appends never
 * interleave. Reads are synchronous file slurps (rare — only on cold resume).
 */

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.ts";

export const SPAIGLASS_HOME = join(homedir(), ".spaiglass");
export const SESSIONS_ROOT = join(SPAIGLASS_HOME, "sessions");

export function tupleHash(
  userId: string,
  workingDirectory: string,
  roleFile: string,
): string {
  return createHash("sha256")
    .update(`${userId}\0${workingDirectory}\0${roleFile}`)
    .digest("hex")
    .slice(0, 24);
}

export function sessionDirFor(
  userId: string,
  workingDirectory: string,
  roleFile: string,
): string {
  return join(SESSIONS_ROOT, tupleHash(userId, workingDirectory, roleFile));
}

export interface SessionMeta {
  id: string;
  userId: string;
  workingDirectory: string;
  roleFile: string;
  claudeSessionId?: string;
  createdAt: number;
  lastActivity: number;
}

export interface SessionPersistence {
  dir: string;
  append(frameJson: string): void;
  updateMeta(patch: Partial<SessionMeta>): void;
  /** Resolve once all queued writes have completed. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Open (or create) a persistence handle for a session tuple. Safe to call
 * on a dir that already contains history — we append.
 */
export async function openSessionPersistence(
  initialMeta: SessionMeta,
): Promise<SessionPersistence> {
  const dir = sessionDirFor(
    initialMeta.userId,
    initialMeta.workingDirectory,
    initialMeta.roleFile,
  );
  await fs.mkdir(dir, { recursive: true });

  const metaPath = join(dir, "meta.json");
  const framesPath = join(dir, "frames.jsonl");

  let meta: SessionMeta = initialMeta;
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const existing = JSON.parse(raw) as SessionMeta;
    // Keep original createdAt if we have it; update identity fields.
    meta = {
      ...existing,
      id: initialMeta.id,
      userId: initialMeta.userId,
      workingDirectory: initialMeta.workingDirectory,
      roleFile: initialMeta.roleFile,
      lastActivity: initialMeta.lastActivity,
    };
  } catch {
    // First run for this tuple — use initialMeta as-is.
  }

  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");

  // Serialize writes through a Promise chain. Errors are logged but don't
  // crash the session — the in-memory path continues to work.
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;

  const append = (frameJson: string) => {
    if (closed) return;
    chain = chain.then(() =>
      fs.appendFile(framesPath, frameJson + "\n", "utf8").catch((err) => {
        logger.app.error(
          "Failed to append frame to {path}: {msg}",
          { path: framesPath, msg: String(err) },
        );
      }),
    );
  };

  const updateMeta = (patch: Partial<SessionMeta>) => {
    if (closed) return;
    meta = { ...meta, ...patch, lastActivity: Date.now() };
    chain = chain.then(() =>
      fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8").catch(
        (err) => {
          logger.app.error(
            "Failed to write meta to {path}: {msg}",
            { path: metaPath, msg: String(err) },
          );
        },
      ),
    );
  };

  const flush = async () => {
    await chain.catch(() => {});
  };

  const close = async () => {
    closed = true;
    await chain.catch(() => {});
  };

  return { dir, append, updateMeta, flush, close };
}

/**
 * Read the highest `seq` value currently in frames.jsonl (or 0 if none).
 * Used when rehydrating: the new in-memory nextCursor must start above the
 * highest persisted cursor so replay + live frames stay monotonic.
 */
export async function readMaxSeq(dir: string): Promise<number> {
  const framesPath = join(dir, "frames.jsonl");
  try {
    const raw = await fs.readFile(framesPath, "utf8");
    let max = 0;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { seq?: number };
        if (typeof obj.seq === "number" && obj.seq > max) max = obj.seq;
      } catch {
        // Malformed line — skip
      }
    }
    return max;
  } catch {
    return 0;
  }
}

/**
 * Read all persisted frames with seq > lastCursor, in-order.
 * Returns raw JSON strings (ready to write to WS). Empty array if no file.
 */
export async function readFramesAfter(
  dir: string,
  lastCursor: number,
): Promise<string[]> {
  const framesPath = join(dir, "frames.jsonl");
  try {
    const raw = await fs.readFile(framesPath, "utf8");
    const out: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { seq?: number };
        if (typeof obj.seq === "number" && obj.seq > lastCursor) {
          out.push(line);
        }
      } catch {
        // Malformed — skip
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function readSessionMeta(dir: string): Promise<SessionMeta | null> {
  try {
    const raw = await fs.readFile(join(dir, "meta.json"), "utf8");
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context files index — persistent list of files Claude read or wrote inside
// the project directory. Powers the Context tab after a hard refresh.
// ---------------------------------------------------------------------------

export interface ContextFileEntry {
  path: string;
  filename: string;
  reads: number;
  writes: number;
  firstSeen: number;
  lastTouched: number;
}

export type ContextFileAction = "read" | "write";

export async function readContextFiles(
  dir: string,
): Promise<ContextFileEntry[]> {
  try {
    const raw = await fs.readFile(join(dir, "context_files.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, ContextFileEntry>;
    return Object.values(parsed);
  } catch {
    return [];
  }
}

/**
 * Update (or insert) a single entry in the persistent context-file index.
 * Returns the updated entry so callers can also emit a live frame.
 * Writes are serialized per-dir through an in-memory lock map.
 */
const contextLocks = new Map<string, Promise<unknown>>();

export async function touchContextFile(
  dir: string,
  filePath: string,
  action: ContextFileAction,
  filename: string,
  now = Date.now(),
): Promise<ContextFileEntry> {
  const prev = contextLocks.get(dir) ?? Promise.resolve();
  let settled!: (entry: ContextFileEntry) => void;
  const whenDone = new Promise<ContextFileEntry>((resolve) => {
    settled = resolve;
  });

  const next = prev
    .then(async () => {
      await fs.mkdir(dir, { recursive: true });
      const file = join(dir, "context_files.json");
      let index: Record<string, ContextFileEntry> = {};
      try {
        index = JSON.parse(await fs.readFile(file, "utf8")) as Record<
          string,
          ContextFileEntry
        >;
      } catch {
        // First touch.
      }

      const existing = index[filePath];
      const entry: ContextFileEntry = existing
        ? {
            ...existing,
            reads: existing.reads + (action === "read" ? 1 : 0),
            writes: existing.writes + (action === "write" ? 1 : 0),
            lastTouched: now,
          }
        : {
            path: filePath,
            filename,
            reads: action === "read" ? 1 : 0,
            writes: action === "write" ? 1 : 0,
            firstSeen: now,
            lastTouched: now,
          };

      index[filePath] = entry;
      await fs.writeFile(file, JSON.stringify(index, null, 2), "utf8");
      settled(entry);
    })
    .catch((err) => {
      logger.app.error(
        "Failed to update context_files.json in {dir}: {msg}",
        { dir, msg: String(err) },
      );
      settled({
        path: filePath,
        filename,
        reads: action === "read" ? 1 : 0,
        writes: action === "write" ? 1 : 0,
        firstSeen: now,
        lastTouched: now,
      });
    });

  contextLocks.set(dir, next);
  return whenDone;
}

// ---------------------------------------------------------------------------
// Queue — per-project list of user-drafted prompts ready to send later.
// ---------------------------------------------------------------------------

export interface QueueEntry {
  id: string;
  text: string;
  createdAt: number;
}

const QUEUE_FILE = "queue.json";
const queueLocks = new Map<string, Promise<unknown>>();

async function withQueueLock<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = queueLocks.get(dir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queueLocks.set(
    dir,
    next.catch(() => undefined),
  );
  return next;
}

export async function readQueue(dir: string): Promise<QueueEntry[]> {
  try {
    const raw = await fs.readFile(join(dir, QUEUE_FILE), "utf8");
    const parsed = JSON.parse(raw) as QueueEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function appendQueueEntry(
  dir: string,
  text: string,
  now = Date.now(),
): Promise<QueueEntry> {
  return withQueueLock(dir, async () => {
    await fs.mkdir(dir, { recursive: true });
    const entries = await readQueue(dir);
    const entry: QueueEntry = {
      id: `q_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      createdAt: now,
    };
    entries.push(entry);
    await fs.writeFile(
      join(dir, QUEUE_FILE),
      JSON.stringify(entries, null, 2),
      "utf8",
    );
    return entry;
  });
}

export async function deleteQueueEntry(
  dir: string,
  id: string,
): Promise<boolean> {
  return withQueueLock(dir, async () => {
    const entries = await readQueue(dir);
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return false;
    await fs.writeFile(
      join(dir, QUEUE_FILE),
      JSON.stringify(next, null, 2),
      "utf8",
    );
    return true;
  });
}

/**
 * Is `filePath` inside `workingDirectory`? Used to skip files outside the
 * project (Claude reading its own ~/.claude/... files, for example).
 */
export function isInsideWorkingDirectory(
  filePath: string,
  workingDirectory: string,
): boolean {
  if (!filePath || !workingDirectory) return false;
  const wd = workingDirectory.endsWith("/")
    ? workingDirectory
    : workingDirectory + "/";
  return filePath === workingDirectory || filePath.startsWith(wd);
}
