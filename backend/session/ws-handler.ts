/**
 * WebSocket handler for persistent Claude sessions.
 *
 * Protocol:
 * Client sends JSON messages, server sends JSON messages.
 * See UNIFIED-SPEC.md section 2.3.2 for message types.
 */

import type { WSContext } from "hono/ws";
import { randomUUID } from "node:crypto";
import { SessionManager, type SessionConsumer } from "./manager.ts";
import { logger } from "../utils/logger.ts";

interface WSState {
  consumerId: string;
  userId: string;
  roleFile: string | null;
  workingDirectory: string | null;
}

export function createWSHandler(sessionManager: SessionManager) {
  return {
    onOpen(ws: WSContext) {
      const state: WSState = {
        consumerId: randomUUID(),
        userId: "local", // Default for direct access; relay sets real userId
        roleFile: null,
        workingDirectory: null,
      };

      // Attach state to the ws object via a Map (Hono WS doesn't have state property)
      wsStateMap.set(ws, state);

      logger.app.info("WebSocket connected: {consumerId}", {
        consumerId: state.consumerId,
      });
    },

    async onMessage(ws: WSContext, event: MessageEvent) {
      const state = wsStateMap.get(ws);
      if (!state) return;

      let msg: Record<string, unknown>;
      try {
        const raw =
          typeof event.data === "string" ? event.data : event.data.toString();
        msg = JSON.parse(raw);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      try {
        switch (msg.type) {
          case "session_start":
            await handleSessionStart(ws, state, msg, sessionManager);
            break;

          case "session_restart":
            await handleSessionRestart(ws, state, msg, sessionManager);
            break;

          case "resume":
            await handleResume(ws, state, msg, sessionManager);
            break;

          case "message":
            await handleMessage(state, msg, sessionManager);
            break;

          case "interrupt":
            if (state.roleFile) {
              await sessionManager.interrupt(state.userId, state.roleFile);
            }
            break;

          default:
            ws.send(
              JSON.stringify({
                type: "error",
                message: `Unknown message type: ${msg.type}`,
              }),
            );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ws.send(JSON.stringify({ type: "error", message }));
      }
    },

    onClose(ws: WSContext) {
      const state = wsStateMap.get(ws);
      if (state && state.roleFile) {
        sessionManager.removeConsumer(
          state.userId,
          state.roleFile,
          state.consumerId,
        );
      }
      wsStateMap.delete(ws);
      logger.app.info("WebSocket disconnected: {consumerId}", {
        consumerId: state?.consumerId || "unknown",
      });
    },

    onError(ws: WSContext, error: Event) {
      logger.app.error("WebSocket error: {error}", { error });
      const state = wsStateMap.get(ws);
      if (state && state.roleFile) {
        sessionManager.removeConsumer(
          state.userId,
          state.roleFile,
          state.consumerId,
        );
      }
      wsStateMap.delete(ws);
    },
  };
}

// State storage — Hono WS contexts don't have a state property
const wsStateMap = new WeakMap<WSContext, WSState>();

async function handleSessionStart(
  ws: WSContext,
  state: WSState,
  msg: Record<string, unknown>,
  sessionManager: SessionManager,
): Promise<void> {
  const roleFile = msg.roleFile as string;
  const workingDirectory = msg.workingDirectory as string;
  const contextContent = msg.contextContent as string | undefined;

  if (!roleFile || !workingDirectory) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "roleFile and workingDirectory required",
      }),
    );
    return;
  }

  state.roleFile = roleFile;
  state.workingDirectory = workingDirectory;

  const consumer: SessionConsumer = {
    id: state.consumerId,
    send: (data: string) => {
      try {
        ws.send(data);
      } catch {
        // Connection may have closed
      }
    },
    close: () => {
      try {
        ws.close();
      } catch {
        // Already closed
      }
    },
  };

  const info = await sessionManager.getOrCreateSession(
    state.userId,
    roleFile,
    workingDirectory,
    consumer,
    contextContent,
  );

  // Session info is also sent by the manager when it receives the init message,
  // but send an ack immediately so the client knows we're connected
  ws.send(
    JSON.stringify({
      type: "session_ack",
      sessionId: info.id,
      slashCommands: info.slashCommands,
      consumerCount: info.consumerCount,
    }),
  );
}

async function handleSessionRestart(
  ws: WSContext,
  state: WSState,
  msg: Record<string, unknown>,
  sessionManager: SessionManager,
): Promise<void> {
  const roleFile = (msg.roleFile as string) || state.roleFile;
  const workingDirectory =
    (msg.workingDirectory as string) || state.workingDirectory;

  if (!roleFile || !workingDirectory) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "roleFile and workingDirectory required",
      }),
    );
    return;
  }

  state.roleFile = roleFile;
  state.workingDirectory = workingDirectory;

  const consumer: SessionConsumer = {
    id: state.consumerId,
    send: (data: string) => {
      try {
        ws.send(data);
      } catch {}
    },
    close: () => {
      try {
        ws.close();
      } catch {}
    },
  };

  const info = await sessionManager.restartSession(
    state.userId,
    roleFile,
    workingDirectory,
    consumer,
  );

  ws.send(
    JSON.stringify({
      type: "session_ack",
      sessionId: info.id,
      slashCommands: info.slashCommands,
      consumerCount: info.consumerCount,
    }),
  );
}

/**
 * Resume a previous session after a disconnect.
 *
 * Client sends: { type: "resume", roleFile, workingDirectory, lastCursor }
 *
 * Behavior:
 * - If a session exists for (userId, roleFile) and lastCursor is in-buffer →
 *   replay missed frames and attach as a live consumer.
 * - If lastCursor has aged out → manager sends `resume_lost` directly to the
 *   consumer; client should clear local state and call session_start.
 * - If no session exists → ack with `{type:"resume_failed", reason:"no_session"}`
 *   so the client knows to fall back to session_start.
 */
async function handleResume(
  ws: WSContext,
  state: WSState,
  msg: Record<string, unknown>,
  sessionManager: SessionManager,
): Promise<void> {
  const roleFile = msg.roleFile as string;
  const workingDirectory = msg.workingDirectory as string;
  const lastCursor = typeof msg.lastCursor === "number" ? msg.lastCursor : 0;

  if (!roleFile || !workingDirectory) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "roleFile and workingDirectory required for resume",
      }),
    );
    return;
  }

  state.roleFile = roleFile;
  state.workingDirectory = workingDirectory;

  const consumer: SessionConsumer = {
    id: state.consumerId,
    send: (data: string) => {
      try {
        ws.send(data);
      } catch {
        // Connection may have closed
      }
    },
    close: () => {
      try {
        ws.close();
      } catch {
        // Already closed
      }
    },
  };

  const result = sessionManager.resumeFromCursor(
    state.userId,
    roleFile,
    consumer,
    lastCursor,
  );

  if (!result.resumed) {
    // Either no session, or buffer aged out (manager already sent resume_lost).
    // Tell the client so it knows to call session_start next.
    ws.send(
      JSON.stringify({
        type: "resume_failed",
        reason: "no_session_or_aged_out",
      }),
    );
    return;
  }

  ws.send(
    JSON.stringify({
      type: "resume_ack",
      replayedFrames: result.replayedFrames,
    }),
  );
}

async function handleMessage(
  state: WSState,
  msg: Record<string, unknown>,
  sessionManager: SessionManager,
): Promise<void> {
  if (!state.roleFile) {
    throw new Error("No active session — send session_start first");
  }

  const content = (msg.content as string) || "";
  const attachments = (msg.attachments as string[]) || undefined;

  await sessionManager.sendMessage(
    state.userId,
    state.roleFile,
    content,
    attachments,
  );
}
