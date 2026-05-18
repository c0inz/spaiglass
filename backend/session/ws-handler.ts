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
            if (state.workingDirectory && state.roleFile !== null) {
              await sessionManager.interrupt(
                state.userId,
                state.workingDirectory,
                state.roleFile,
              );
            }
            break;

          case "tool_result":
            // Phase 6.4: reply to an in-flight interactive MCP tool call.
            // Routed by SessionManager to the matching pending request via
            // its original_request_id; the SDK tool handler resolves and
            // returns the value to Claude as the tool result.
            if (state.workingDirectory && state.roleFile !== null) {
              sessionManager.handleToolResult(
                state.userId,
                state.workingDirectory,
                state.roleFile,
                msg,
              );
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
      if (state && state.workingDirectory && state.roleFile !== null) {
        sessionManager.removeConsumer(
          state.userId,
          state.workingDirectory,
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
      if (state && state.workingDirectory && state.roleFile !== null) {
        sessionManager.removeConsumer(
          state.userId,
          state.workingDirectory,
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

type PermissionModeWire =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions";
type ThinkingLevelWire = "off" | "brief" | "extended";

function parsePermissionMode(v: unknown): PermissionModeWire | undefined {
  if (
    v === "default" ||
    v === "plan" ||
    v === "acceptEdits" ||
    v === "bypassPermissions"
  )
    return v;
  return undefined;
}

function parseThinkingLevel(v: unknown): ThinkingLevelWire | undefined {
  if (v === "off" || v === "brief" || v === "extended") return v;
  return undefined;
}

async function handleSessionStart(
  ws: WSContext,
  state: WSState,
  msg: Record<string, unknown>,
  sessionManager: SessionManager,
): Promise<void> {
  // roleFile is optional — projects without a .claude/agents/<role>.md file
  // get the SDK's built-in default behavior + any project-local CLAUDE.md.
  // Empty string is normalized to "" so the session-key tuple stays stable.
  const roleFile = (msg.roleFile as string) || "";
  const workingDirectory = msg.workingDirectory as string;
  const contextContent = msg.contextContent as string | undefined;
  const resumeSessionId = msg.resumeSessionId as string | undefined;
  const permissionMode = parsePermissionMode(msg.permissionMode);
  const thinkingLevel = parseThinkingLevel(msg.thinkingLevel);

  if (!workingDirectory) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "workingDirectory required",
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
    workingDirectory,
    roleFile,
    consumer,
    contextContent,
    resumeSessionId,
    { permissionMode, thinkingLevel },
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
  const roleFile = (msg.roleFile as string | undefined) ?? state.roleFile ?? "";
  const workingDirectory =
    (msg.workingDirectory as string) || state.workingDirectory;

  if (!workingDirectory) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "workingDirectory required",
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

  const permissionMode = parsePermissionMode(msg.permissionMode);
  const thinkingLevel = parseThinkingLevel(msg.thinkingLevel);

  const info = await sessionManager.restartSession(
    state.userId,
    workingDirectory,
    roleFile,
    consumer,
    { permissionMode, thinkingLevel },
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
  const roleFile = (msg.roleFile as string) || "";
  const workingDirectory = msg.workingDirectory as string;
  const lastCursor = typeof msg.lastCursor === "number" ? msg.lastCursor : 0;

  if (!workingDirectory) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "workingDirectory required for resume",
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

  const result = await sessionManager.resumeFromCursor(
    state.userId,
    workingDirectory,
    roleFile,
    consumer,
    lastCursor,
  );

  if (!result.resumed) {
    // No live in-memory session. Try streaming the persisted transcript
    // from disk so the user's scrollback survives a hard refresh or
    // backend restart. The client will still need to call session_start
    // before it can send a new message (signaled by `stale: true`).
    const disk = await sessionManager.rehydrateFromDisk(
      state.userId,
      workingDirectory,
      roleFile,
      consumer,
      lastCursor,
    );

    if (disk.rehydrated) {
      ws.send(
        JSON.stringify({
          type: "resume_ack",
          replayedFrames: disk.replayedFrames,
          stale: true,
        }),
      );
      return;
    }

    // Nothing in memory and nothing on disk — tell the client to session_start.
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
  if (!state.workingDirectory) {
    throw new Error("No active session — send session_start first");
  }

  const content = (msg.content as string) || "";
  const attachments = (msg.attachments as string[]) || undefined;
  const clientMessageId =
    typeof msg.clientMessageId === "string" ? msg.clientMessageId : undefined;
  const hideUserMessage = msg.hideUserMessage === true;

  logger.app.info(
    "WS message received: consumer={consumerId} len={len} attachments={count}",
    {
      consumerId: state.consumerId,
      len: content.length,
      count: attachments?.length || 0,
    },
  );

  await sessionManager.sendMessage(
    state.userId,
    state.workingDirectory,
    state.roleFile ?? "",
    content,
    attachments,
    clientMessageId,
    hideUserMessage,
  );
}
