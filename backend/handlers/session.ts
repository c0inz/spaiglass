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

  await fs.mkdir(SESSION_DIR, { recursive: true });
  await fs.writeFile(SESSION_FILE, JSON.stringify(session, null, 2));

  logger.app.info("Session saved: {sessionId}", { sessionId });
  return c.json({ ok: true });
}

/**
 * GET /api/session/last?projectPath=...
 * Returns last session for a given project, if one exists and is recent (< 24h).
 */
export async function handleSessionLastRequest(c: Context) {
  const projectPath = c.req.query("projectPath");

  if (!projectPath) {
    return c.json({ error: "projectPath query param required" }, 400);
  }

  if (!(await exists(SESSION_FILE))) {
    return c.json({ session: null });
  }

  try {
    const raw = await fs.readFile(SESSION_FILE, "utf8");
    const session: LastSession = JSON.parse(raw);

    // Must match project
    if (session.projectPath !== projectPath) {
      return c.json({ session: null });
    }

    // Must be within 24 hours
    const ageMs = Date.now() - session.timestamp;
    const maxAgeMs = 24 * 60 * 60 * 1000;
    if (ageMs > maxAgeMs) {
      return c.json({ session: null });
    }

    return c.json({ session });
  } catch (err) {
    logger.app.error("Failed to read last session: {err}", { err });
    return c.json({ session: null });
  }
}
