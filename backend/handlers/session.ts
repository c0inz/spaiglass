import type { Context } from "hono";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exists } from "../utils/fs.ts";
import { logger } from "../utils/logger.ts";
import {
  appendQueueEntry,
  deleteQueueEntry,
  readContextFiles,
  readQueue,
  sessionDirFor,
} from "../session/persistence.ts";

const SESSION_DIR = join(homedir(), ".claude-webui");
const SESSION_FILE = join(SESSION_DIR, "last-session.json");

interface LastSession {
  sessionId: string;
  projectPath: string;
  role?: string;
  timestamp: number;
}

interface SessionStore {
  version: 2;
  sessions: Record<string, LastSession>;
}

function sessionStoreKey(projectPath: string, role?: string): string {
  return JSON.stringify([projectPath, role || ""]);
}

function isLastSession(value: unknown): value is LastSession {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LastSession).sessionId === "string" &&
    typeof (value as LastSession).projectPath === "string" &&
    typeof (value as LastSession).timestamp === "number"
  );
}

async function readSessionStore(): Promise<SessionStore> {
  if (!(await exists(SESSION_FILE))) {
    return { version: 2, sessions: {} };
  }

  const raw = await fs.readFile(SESSION_FILE, "utf8");
  const parsed = JSON.parse(raw) as
    | SessionStore
    | LastSession
    | Record<string, unknown>;

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    parsed.version === 2 &&
    "sessions" in parsed &&
    typeof parsed.sessions === "object" &&
    parsed.sessions !== null
  ) {
    return parsed as SessionStore;
  }

  // Legacy format: the file stored exactly one LastSession object.
  if (isLastSession(parsed)) {
    return {
      version: 2,
      sessions: {
        [sessionStoreKey(parsed.projectPath, parsed.role)]: parsed,
      },
    };
  }

  return { version: 2, sessions: {} };
}

/**
 * POST /api/session/save
 * Saves last session info for auto-resume.
 * Body: { sessionId, projectPath, role? }
 */
export async function handleSessionSaveRequest(c: Context) {
  const body = await c.req.json();
  const { sessionId, projectPath, role } = body;

  if (!sessionId || !projectPath) {
    return c.json({ error: "sessionId and projectPath required" }, 400);
  }

  const session: LastSession = {
    sessionId,
    projectPath,
    role,
    timestamp: Date.now(),
  };

  const store = await readSessionStore();
  store.sessions[sessionStoreKey(projectPath, role)] = session;

  await fs.mkdir(SESSION_DIR, { recursive: true });
  await fs.writeFile(SESSION_FILE, JSON.stringify(store, null, 2));

  logger.app.info("Session saved: {sessionId}", { sessionId });
  return c.json({ ok: true });
}

/**
 * GET /api/session/last?projectPath=...&role=...
 *
 * Returns the most recent session for a directory. `role` is optional —
 * when set, prefer an exact (projectPath, role) match, otherwise fall back
 * to newest session for the directory. This lets the Server+Directory UI
 * resume a directory's last session without caring about role, while the
 * legacy role-qualified flow still lands its exact match first.
 */
export async function handleSessionLastRequest(c: Context) {
  const projectPath = c.req.query("projectPath");
  const role = c.req.query("role") || undefined;

  if (!projectPath) {
    return c.json({ error: "projectPath query param required" }, 400);
  }

  try {
    const store = await readSessionStore();

    if (role) {
      const exact = store.sessions[sessionStoreKey(projectPath, role)];
      if (exact) return c.json({ session: exact });
    }

    const projectSessions = Object.values(store.sessions).filter(
      (session) => session.projectPath === projectPath,
    );
    if (projectSessions.length === 0) {
      return c.json({ session: null });
    }

    const session = projectSessions.sort(
      (a, b) => b.timestamp - a.timestamp,
    )[0];

    return c.json({ session });
  } catch (err) {
    logger.app.error("Failed to read last session: {err}", { err });
    return c.json({ session: null });
  }
}

/**
 * GET /api/session/context-files?workingDirectory=...&roleFile=...
 *
 * Returns the persistent list of files Claude read or wrote inside the
 * project directory for this (workingDirectory, roleFile) pair. The list
 * survives browser refresh and backend restart.
 *
 * Note: keyed by tuple hash just like the transcript on disk. Since
 * userId is a server-side construct tied to the relay/auth layer, we
 * accept the same anonymous "user" fallback SessionManager uses when
 * called over the local WS path.
 */
export async function handleSessionContextFilesRequest(c: Context) {
  const workingDirectory = c.req.query("workingDirectory");
  const roleFile = c.req.query("roleFile");
  const userId = c.req.query("userId") || "anonymous";

  if (!workingDirectory || !roleFile) {
    return c.json(
      { error: "workingDirectory and roleFile query params required" },
      400,
    );
  }

  try {
    const dir = sessionDirFor(userId, workingDirectory, roleFile);
    const files = await readContextFiles(dir);
    return c.json({ files });
  } catch (err) {
    logger.app.error("Failed to read context files: {err}", { err });
    return c.json({ files: [] });
  }
}

/**
 * Queue — per-project prompt scratchpad. Same (userId, workingDirectory,
 * roleFile) tuple key as transcript/context-files so a queue entry stays
 * tied to the project, not the browser session.
 *
 * GET    /api/session/queue        → { items: QueueEntry[] }
 * POST   /api/session/queue        → body: { text }, returns { item }
 * DELETE /api/session/queue/:id
 */
function queueDirFromQuery(
  c: Context,
): { dir: string; error?: string } | { dir: null; error: string } {
  const workingDirectory = c.req.query("workingDirectory");
  const roleFile = c.req.query("roleFile");
  const userId = c.req.query("userId") || "anonymous";
  if (!workingDirectory || !roleFile) {
    return {
      dir: null,
      error: "workingDirectory and roleFile query params required",
    };
  }
  return { dir: sessionDirFor(userId, workingDirectory, roleFile) };
}

export async function handleSessionQueueListRequest(c: Context) {
  const { dir, error } = queueDirFromQuery(c);
  if (!dir) return c.json({ error }, 400);
  try {
    const items = await readQueue(dir);
    return c.json({ items });
  } catch (err) {
    logger.app.error("Failed to read queue: {err}", { err });
    return c.json({ items: [] });
  }
}

export async function handleSessionQueueAddRequest(c: Context) {
  const { dir, error } = queueDirFromQuery(c);
  if (!dir) return c.json({ error }, 400);
  let body: { text?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON { text }" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return c.json({ error: "text is required and must be non-empty" }, 400);
  }
  if (text.length > 100_000) {
    return c.json({ error: "text exceeds 100KB limit" }, 413);
  }
  try {
    const item = await appendQueueEntry(dir, text);
    return c.json({ item });
  } catch (err) {
    logger.app.error("Failed to append queue entry: {err}", { err });
    return c.json({ error: "failed to save queue entry" }, 500);
  }
}

export async function handleSessionQueueDeleteRequest(c: Context) {
  const { dir, error } = queueDirFromQuery(c);
  if (!dir) return c.json({ error }, 400);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id is required" }, 400);
  try {
    const removed = await deleteQueueEntry(dir, id);
    return c.json({ removed });
  } catch (err) {
    logger.app.error("Failed to delete queue entry: {err}", { err });
    return c.json({ error: "failed to delete queue entry" }, 500);
  }
}
