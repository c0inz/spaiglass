import type { Context } from "hono";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exists } from "../utils/fs.ts";
import { logger } from "../utils/logger.ts";

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
 * Returns the most recent session for the given project/role pair.
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
      return c.json({
        session: store.sessions[sessionStoreKey(projectPath, role)] ?? null,
      });
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
