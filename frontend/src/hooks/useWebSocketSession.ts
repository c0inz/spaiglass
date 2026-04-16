/**
 * useWebSocketSession — Persistent WebSocket connection to SpAIglass backend.
 *
 * Phase B (post-cutover): consumes the terminal frame protocol directly and
 * hands raw frames to the caller via `onFrame`. The legacy AllMessage bridge
 * is gone. Protocol-only messages (connected/session_ack/resume_*) still go
 * through the non-frame switch below since they have no `seq` field.
 *
 * Anything that used to call `cbs.addMessage({type: "error", ...})` for a
 * protocol-level mishap (viewer_blocked, resume_lost, error) now synthesizes
 * an `ErrorFrame` locally and feeds it through the same `onFrame` path, so
 * the scrollback stays coherent without reintroducing a second state store.
 */

import { useRef, useCallback, useState, useEffect } from "react";
import type { ErrorFrame, Frame } from "../../../shared/frames";
import {
  classifyToolUse,
  classifyToolResult,
  classifyThinking,
  type DisplayStatus,
} from "../utils/statusClassifier";

interface WSSessionOptions {
  /** Base URL for the WebSocket connection (default: auto from window.location) */
  baseUrl?: string;
}

interface WSSessionState {
  connected: boolean;
  sessionId: string | null;
  slashCommands: string[];
  /** True after we've successfully attached/resumed at least once. */
  attached: boolean;
  /**
   * Phase 2: role granted by the relay for this VM. "owner" / "editor" can
   * write; "viewer" is read-only and the input bar should be hidden.
   * Null until we receive the relay's `connected` handshake (or null if
   * connecting directly to a backend without a relay in front).
   */
  role: "owner" | "editor" | "viewer" | null;
  /** GitHub login of the authenticated user, sent by the relay in the
   *  `connected` handshake. Null when connecting directly to a backend. */
  login: string | null;
}

/**
 * Build an ErrorFrame from a local protocol event (viewer_blocked, buffer
 * loss, ws-level error). These frames never come over the wire — they're
 * synthesized here so the frontend pipeline has a single ingestion path.
 *
 * seq/ts/id are client-side only. seq is zero so the reducer's lastSeq
 * watermark isn't polluted with fake cursors.
 */
function synthError(message: string): ErrorFrame {
  return {
    id: `local-err-${Math.random().toString(36).slice(2, 10)}`,
    seq: 0,
    ts: Date.now(),
    type: "error",
    category: "stream_error",
    message,
  };
}

export function useWebSocketSession(options: WSSessionOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keepalive ping timer. Upstream TLS proxies between the browser and
  // the relay idle-terminate silent WebSockets around the 60s mark. An
  // application-level ping every 25s keeps the hop warm so we don't see
  // "VM is offline" errors when the user sits idle.
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // --- Phase 1: replay-on-reconnect state ---
  // Highest cursor we've seen on any incoming frame. Sent back as `lastCursor`
  // when we reconnect, so the backend knows what to replay.
  const lastCursorRef = useRef<number>(0);
  // Last (roleFile, workingDirectory) we attached to. Used to auto-rejoin
  // after a disconnect without ChatPage having to re-call startSession.
  const lastSessionParamsRef = useRef<{
    roleFile: string;
    workingDirectory: string;
    contextContent?: string;
  } | null>(null);
  const [state, setState] = useState<WSSessionState>({
    connected: false,
    sessionId: null,
    slashCommands: [],
    attached: false,
    role: null,
    login: null,
  });
  // Mirror of state.role kept in a ref so onmessage handlers (which have a
  // stale closure over state) can read the latest role without re-binding.
  const roleRef = useRef<"owner" | "editor" | "viewer" | null>(null);
  // Tiny tool cache — only needed so `tool_call_end` can emit the right
  // status-classifier line (e.g. "Ran Bash") without re-parsing the input.
  // Row-level state is owned by the reducer in `useFrameChatState`; this
  // cache does NOT back anything visual and gets pruned on end.
  const toolStatusCacheRef = useRef<
    Map<string, { tool: string; input: Record<string, unknown> }>
  >(new Map());
  // --- Transient offline suppression ---
  // When the connector WS flaps, the browser gets a barrage of "VM is
  // offline" errors every 2s (one per reconnect attempt). Instead of
  // surfacing each one immediately, we hold off for OFFLINE_GRACE_MS.
  // If the connector comes back within the grace period, the user never
  // sees the error. If it stays down, we surface a single error.
  const offlineSinceRef = useRef<number | null>(null);
  const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** How long to silently retry before telling the user the VM is offline. */
  const OFFLINE_GRACE_MS = 12_000;

  // Callbacks — set by the consumer (ChatPage). Frame-native: every inbound
  // typed frame goes through onFrame; protocol side-effects are called via
  // the dedicated handlers so ChatPage doesn't have to introspect frames.
  const callbacksRef = useRef<{
    onFrame: (frame: Frame) => void;
    onSessionId?: (id: string) => void;
    onFileDelivery?: (path: string, filename: string) => void;
    onSlashCommands?: (commands: string[]) => void;
    onTurnComplete?: () => void;
    onStatusUpdate?: (status: DisplayStatus) => void;
  } | null>(null);

  const setCallbacks = useCallback((cbs: typeof callbacksRef.current) => {
    callbacksRef.current = cbs;
  }, []);

  /**
   * Connect to the WebSocket endpoint.
   */
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const base = options.baseUrl || `${protocol}//${window.location.host}`;
    const url = `${base}/api/ws`;

    const ws = new WebSocket(url);

    ws.onopen = () => {
      setState((s) => ({ ...s, connected: true }));
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      pingTimerRef.current = setInterval(() => {
        const cur = wsRef.current;
        if (cur && cur.readyState === WebSocket.OPEN) {
          try {
            cur.send(JSON.stringify({ type: "ping" }));
          } catch {
            /* ignore */
          }
        }
      }, 25_000);
      // Phase 1 reconnect: if we had a session before the disconnect,
      // try to resume from our last seen cursor.
      const params = lastSessionParamsRef.current;
      if (params) {
        ws.send(
          JSON.stringify({
            type: "resume",
            roleFile: params.roleFile,
            workingDirectory: params.workingDirectory,
            lastCursor: lastCursorRef.current,
          }),
        );
      }
    };

    ws.onclose = () => {
      setState((s) => ({ ...s, connected: false }));
      wsRef.current = null;
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      reconnectTimerRef.current = setTimeout(() => connect(), 2000);
    };

    ws.onerror = () => {
      // onclose will fire after this
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch {
        console.error("Failed to parse WS message:", event.data);
      }
    };

    wsRef.current = ws;
  }, [options.baseUrl]);

  /**
   * Process a message from the server.
   *
   * Two classes of inbound traffic:
   *
   *   1. Non-frame protocol messages (connected/viewer_blocked/session_ack/
   *      resume_*) — these are the relay + session manager handshake; they
   *      carry no `seq` and fall into the switch below.
   *   2. Typed terminal frames — every frame carries `seq`, we track the
   *      highest one we've seen for resume, and dispatch via handleFrame.
   */
  const handleServerMessage = useCallback((msg: Record<string, unknown>) => {
    const cbs = callbacksRef.current;
    if (!cbs) return;

    // Frame path: everything with a `seq` field is a terminal frame.
    if (typeof msg.seq === "number") {
      if (msg.seq > lastCursorRef.current) {
        lastCursorRef.current = msg.seq;
      }
      handleFrame(msg as unknown as Frame, cbs);
      return;
    }

    switch (msg.type) {
      case "pong":
        break;

      case "connected": {
        const role =
          (msg.role as "owner" | "editor" | "viewer" | undefined) ?? null;
        const login = (msg.login as string | undefined) ?? null;
        roleRef.current = role;
        // VM is back — cancel any pending offline error.
        offlineSinceRef.current = null;
        if (offlineTimerRef.current) {
          clearTimeout(offlineTimerRef.current);
          offlineTimerRef.current = null;
        }
        setState((s) => ({ ...s, role, login }));
        break;
      }

      case "viewer_blocked":
        cbs.onFrame(
          synthError("Read-only access — this action is blocked for viewers."),
        );
        break;

      case "session_ack":
        // session_ack carries the SessionManager's internal UUID
        // (`session.id`), NOT the SDK's real `session_id`. We only use it
        // to flip `attached: true` so ChatPage knows the WS is in a
        // session. The URL is stamped later in the session_init frame
        // handler, where we have the real SDK session_id.
        offlineSinceRef.current = null;
        if (offlineTimerRef.current) {
          clearTimeout(offlineTimerRef.current);
          offlineTimerRef.current = null;
        }
        setState((s) => ({
          ...s,
          slashCommands: (msg.slashCommands as string[]) || [],
          attached: true,
        }));
        break;

      case "resume_ack":
        offlineSinceRef.current = null;
        if (offlineTimerRef.current) {
          clearTimeout(offlineTimerRef.current);
          offlineTimerRef.current = null;
        }
        setState((s) => ({ ...s, attached: true }));
        break;

      case "resume_failed": {
        // Backend has no session for us, or buffer aged out and resume_lost
        // was already sent. Fall back to a fresh session_start using the
        // last params we know — but ONLY if we're allowed to write.
        lastCursorRef.current = 0;
        if (roleRef.current === "viewer") {
          cbs.onFrame(
            synthError(
              "Read-only mode — waiting for the owner to start a session.",
            ),
          );
          break;
        }
        const params = lastSessionParamsRef.current;
        const ws = wsRef.current;
        if (params && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "session_start",
              roleFile: params.roleFile,
              workingDirectory: params.workingDirectory,
              contextContent: params.contextContent,
            }),
          );
        }
        break;
      }

      case "resume_lost":
        // Buffer aged out — we've missed unrecoverable frames.
        lastCursorRef.current = 0;
        cbs.onFrame(
          synthError("Reconnected, but some output was lost (buffer aged out)."),
        );
        break;

      case "error": {
        const errMsg = (msg.message as string) || "Unknown WebSocket error";
        const isTransient =
          errMsg === "VM is offline" || errMsg === "VM disconnected";
        if (isTransient) {
          // Suppress transient offline errors during the grace period.
          // The browser will keep reconnecting automatically; if the
          // connector comes back, the user never sees the error.
          if (offlineSinceRef.current === null) {
            offlineSinceRef.current = Date.now();
          }
          const elapsed = Date.now() - offlineSinceRef.current;
          if (elapsed < OFFLINE_GRACE_MS && !offlineTimerRef.current) {
            // Schedule a deferred error in case the VM stays down.
            offlineTimerRef.current = setTimeout(() => {
              offlineTimerRef.current = null;
              // Only fire if we're still offline (offlineSinceRef not cleared).
              if (offlineSinceRef.current !== null) {
                cbs.onFrame(synthError("VM is offline — reconnecting…"));
              }
            }, OFFLINE_GRACE_MS - elapsed);
          }
          // Don't surface the error yet.
          break;
        }
        cbs.onFrame(synthError(errMsg));
        break;
      }
    }
  }, []);

  /**
   * Dispatch a typed terminal frame.
   *
   * Frame-native: the raw frame is delivered to `onFrame` for the reducer
   * and the protocol side-effects (URL stamp, session id, slash commands,
   * turn completion, status classifier, file delivery) fire here so
   * ChatPage doesn't have to re-introspect.
   */
  const handleFrame = useCallback(
    (frame: Frame, cbs: NonNullable<typeof callbacksRef.current>) => {
      // User messages are added to the scrollback locally the moment the
      // user presses Enter (ChatPage synthesizes a UserMessageFrame via
      // frameChat.addFrame). The backend still echoes them back as a real
      // user_message frame a beat later — swallow it so the row isn't
      // duplicated. Hidden continuations (permission "continue", plan
      // "accept") are sent via ws.sendMessage with hideUserMessage=true;
      // they do NOT get a local frame, so they'd leak through here. We
      // currently accept that trade-off: the backend will echo them back
      // in replay anyway, and suppressing echo-only frames would require
      // per-message tracking the hook doesn't carry.
      if (frame.type === "user_message") return;

      cbs.onFrame(frame);

      switch (frame.type) {
        case "session_init": {
          setState((s) => ({
            ...s,
            sessionId: frame.sessionId || s.sessionId,
            slashCommands: frame.slashCommands,
          }));
          if (frame.sessionId) cbs.onSessionId?.(frame.sessionId);
          cbs.onSlashCommands?.(frame.slashCommands);
          // Persist the REAL SDK session_id in the URL so a hard refresh
          // can fetch the JSONL transcript (which is named after the SDK
          // session_id, not the SessionManager UUID).
          if (frame.sessionId) {
            try {
              const url = new URL(window.location.href);
              url.searchParams.set("sessionId", frame.sessionId);
              window.history.replaceState({}, "", url.toString());
            } catch {
              // URL manipulation failed (sandbox?) — non-fatal
            }
          }
          break;
        }

        case "session_meta": {
          // SDK `result` message — end of turn. Re-enables the input bar
          // and clears the transient status line.
          cbs.onTurnComplete?.();
          break;
        }

        case "session_end": {
          lastCursorRef.current = 0;
          lastSessionParamsRef.current = null;
          setState((s) => ({ ...s, attached: false, sessionId: null }));
          break;
        }

        case "assistant_message": {
          // Fire a thinking-status ping per thinking block so the
          // transient status line shows "Reasoning…" during a thinking
          // turn. The actual text lives inside the frame and will be
          // rendered by the reducer.
          for (const block of frame.content) {
            if (block.type === "thinking" && cbs.onStatusUpdate) {
              cbs.onStatusUpdate(classifyThinking(block.text.slice(0, 300)));
            }
          }
          break;
        }

        case "tool_call_start": {
          const tool = frame.tool;
          const input: Record<string, unknown> =
            frame.input &&
            typeof frame.input === "object" &&
            !Array.isArray(frame.input)
              ? (frame.input as Record<string, unknown>)
              : {};
          toolStatusCacheRef.current.set(frame.toolCallId, { tool, input });
          if (tool === "ExitPlanMode" || tool === "TodoWrite") break;
          if (cbs.onStatusUpdate) {
            cbs.onStatusUpdate(classifyToolUse(tool, input));
          }
          break;
        }

        case "tool_call_end": {
          const cached = toolStatusCacheRef.current.get(frame.toolCallId);
          toolStatusCacheRef.current.delete(frame.toolCallId);
          if (!cached) break;
          if (cached.tool === "TodoWrite" || cached.tool === "ExitPlanMode") {
            break;
          }
          if (cbs.onStatusUpdate) {
            cbs.onStatusUpdate(
              classifyToolResult(
                cached.tool,
                cached.input,
                frame.status === "error",
              ),
            );
          }
          break;
        }

        case "file_delivery":
          cbs.onFileDelivery?.(frame.path, frame.filename);
          break;

        // Nothing to do here — the reducer handles row assembly for
        // user_message, assistant_message_delta, tool_call_update,
        // interactive_prompt, interactive_resolved, plan, todo, error.
        default:
          break;
      }
    },
    [],
  );

  /**
   * Start or join a session for a role.
   *
   * Phase 1: also remembers the params so an auto-reconnect can resume
   * without ChatPage having to call this again.
   */
  const startSession = useCallback(
    (roleFile: string, workingDirectory: string, contextContent?: string) => {
      lastSessionParamsRef.current = {
        roleFile,
        workingDirectory,
        contextContent,
      };
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      ws.send(
        JSON.stringify({
          type: "session_start",
          roleFile,
          workingDirectory,
          contextContent,
        }),
      );
    },
    [],
  );

  /**
   * Restart with a fresh session.
   */
  const restartSession = useCallback(
    (roleFile: string, workingDirectory: string) => {
      lastCursorRef.current = 0;
      lastSessionParamsRef.current = { roleFile, workingDirectory };
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      ws.send(
        JSON.stringify({
          type: "session_restart",
          roleFile,
          workingDirectory,
        }),
      );
    },
    [],
  );

  /**
   * Send a user message (or slash command).
   */
  const sendMessage = useCallback(
    (content: string, attachments?: string[]) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      ws.send(
        JSON.stringify({
          type: "message",
          content,
          ...(attachments?.length ? { attachments } : {}),
        }),
      );
    },
    [],
  );

  /**
   * Phase 6.4 — reply to an in-flight interactive MCP tool call.
   */
  const sendToolResult = useCallback(
    (
      requestId: string,
      status: "accepted" | "approved" | "rejected",
      data?: unknown,
      reason?: string,
    ) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      ws.send(
        JSON.stringify({
          type: "tool_result",
          original_request_id: requestId,
          status,
          ...(data !== undefined ? { data } : {}),
          ...(reason !== undefined ? { reason } : {}),
        }),
      );
    },
    [],
  );

  /**
   * Interrupt the current response.
   */
  const interrupt = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  /**
   * Disconnect intentionally — clears all replay/resume state and the URL
   * session marker so we don't try to rejoin a dead session on next load.
   */
  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    const ws = wsRef.current;
    if (ws) {
      ws.onclose = null;
      ws.close();
      wsRef.current = null;
    }
    lastCursorRef.current = 0;
    lastSessionParamsRef.current = null;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("sessionId");
      window.history.replaceState({}, "", url.toString());
    } catch {
      // Non-fatal
    }
    roleRef.current = null;
    setState({
      connected: false,
      sessionId: null,
      slashCommands: [],
      attached: false,
      role: null,
      login: null,
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      if (offlineTimerRef.current) {
        clearTimeout(offlineTimerRef.current);
        offlineTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []);

  return {
    ...state,
    connect,
    disconnect,
    setCallbacks,
    startSession,
    restartSession,
    sendMessage,
    sendToolResult,
    interrupt,
  };
}
