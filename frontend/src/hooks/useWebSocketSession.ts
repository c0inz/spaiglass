/**
 * useWebSocketSession — Persistent WebSocket connection to SpAIglass backend.
 *
 * Phase B: consumes the terminal frame protocol (shared/frames.ts) directly.
 * Non-frame protocol messages (connected, session_ack, resume_*) are still
 * handled as before; typed frames are dispatched through an inline adapter
 * that converts each frame into the legacy AllMessage shape so the existing
 * terminal renderer keeps working. Step 8 will replace the adapter with a
 * frame-native interpreter; Step 9 will delete AllMessage altogether.
 */

import { useRef, useCallback, useState, useEffect } from "react";
import type { AllMessage, ChatMessage } from "../types";
import type { Frame } from "../../../shared/frames";
import {
  classifyToolUse,
  classifyToolResult,
  classifyThinking,
  type DisplayStatus,
} from "../utils/statusClassifier";
import { createToolResultMessage } from "../utils/messageConversion";

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
 * Per-hook cache mapping toolCallId -> {tool, input} captured from
 * tool_call_start. Used by tool_call_end to rebuild the legacy
 * ToolResultMessage (the backend no longer echoes tool name in the end
 * frame). This mirrors the old UnifiedMessageProcessor.toolUseCache but
 * lives on the frontend only to service the adapter path.
 */
interface ToolCallCacheEntry {
  tool: string;
  input: Record<string, unknown>;
}

export function useWebSocketSession(options: WSSessionOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolCallCacheRef = useRef<Map<string, ToolCallCacheEntry>>(new Map());
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

  // Message callbacks — set by the consumer (ChatPage)
  const callbacksRef = useRef<{
    addMessage: (msg: AllMessage) => void;
    updateLastMessage: (content: string) => void;
    setCurrentAssistantMessage: (msg: ChatMessage | null) => void;
    currentAssistantMessage: ChatMessage | null;
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
      // Phase 1 reconnect: if we had a session before the disconnect,
      // try to resume from our last seen cursor. Backend will either
      // replay buffered frames + attach us, or tell us the buffer aged out.
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
      // Auto-reconnect after 2 seconds — store timer so it can be cancelled
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
   *      highest one we've seen for resume, and dispatch via handleFrame
   *      which translates it into legacy AllMessage callbacks.
   *
   * Anything with a numeric `seq` is treated as a frame; anything else is
   * a protocol message. This keeps the two streams cleanly separated.
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
      case "connected": {
        // Phase 2: relay handshake. Tells us our role on this VM so the UI
        // can hide the input bar for viewers.
        const role =
          (msg.role as "owner" | "editor" | "viewer" | undefined) ?? null;
        const login = (msg.login as string | undefined) ?? null;
        roleRef.current = role;
        setState((s) => ({ ...s, role, login }));
        break;
      }

      case "viewer_blocked":
        // Relay refused a write-type frame. Surface a one-time banner.
        cbs.addMessage({
          type: "system",
          subtype: "abort",
          message: "Read-only access — this action is blocked for viewers.",
          timestamp: Date.now(),
        });
        break;

      case "session_ack":
        setState((s) => ({
          ...s,
          sessionId: msg.sessionId as string,
          slashCommands: (msg.slashCommands as string[]) || [],
          attached: true,
        }));
        // Phase 1: persist sessionId in URL so a hard refresh resumes it.
        // Use replaceState to avoid creating history entries on every reload.
        if (msg.sessionId) {
          try {
            const url = new URL(window.location.href);
            url.searchParams.set("sessionId", msg.sessionId as string);
            window.history.replaceState({}, "", url.toString());
          } catch {
            // URL manipulation failed (sandbox?) — non-fatal
          }
        }
        break;

      case "resume_ack":
        setState((s) => ({ ...s, attached: true }));
        break;

      case "resume_failed": {
        // Backend has no session for us, or buffer aged out and resume_lost
        // was already sent. Fall back to a fresh session_start using the
        // last params we know — but ONLY if we're allowed to write.
        // Viewers stay in "waiting for session" mode instead of spawning one.
        lastCursorRef.current = 0;
        if (roleRef.current === "viewer") {
          cbs.addMessage({
            type: "system",
            subtype: "abort",
            message:
              "Read-only mode — waiting for the owner to start a session.",
            timestamp: Date.now(),
          });
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
        // Surface a banner so the user knows; reset cursor; fall through
        // to resume_failed handling on next message (which will fire after).
        lastCursorRef.current = 0;
        cbs.addMessage({
          type: "system",
          subtype: "abort",
          message: "Reconnected, but some output was lost (buffer aged out).",
          timestamp: Date.now(),
        });
        break;

      case "error":
        // Protocol-level error from the WS handler (invalid JSON, missing
        // roleFile, etc.). Session-internal errors come through as ErrorFrame
        // via the frame path above. Both land on the same scrollback row.
        cbs.addMessage({
          type: "error",
          subtype: "stream_error",
          message: (msg.message as string) || "Unknown error",
          timestamp: Date.now(),
        });
        break;
    }
  }, []);

  /**
   * Dispatch a typed terminal frame into the legacy AllMessage callbacks.
   *
   * This is the Phase B adapter: it bridges frame events onto the existing
   * ChatPage renderer without rewriting every component. Step 8 replaces
   * this with a frame-native row interpreter.
   */
  const handleFrame = useCallback(
    (frame: Frame, cbs: NonNullable<typeof callbacksRef.current>) => {
      switch (frame.type) {
        case "session_init": {
          setState((s) => ({
            ...s,
            sessionId: frame.sessionId || s.sessionId,
            slashCommands: frame.slashCommands,
          }));
          if (frame.sessionId) cbs.onSessionId?.(frame.sessionId);
          cbs.onSlashCommands?.(frame.slashCommands);
          break;
        }

        case "session_meta": {
          // Maps to the SDK `result` message — signals end of a turn. The
          // legacy pipeline called onTurnComplete here (re-enables input,
          // refreshes stats) and cleared currentAssistantMessage so the
          // next turn opens a fresh bubble.
          cbs.onTurnComplete?.();
          cbs.setCurrentAssistantMessage(null);
          break;
        }

        case "session_end": {
          const suffix = frame.message ? ` — ${frame.message}` : "";
          cbs.addMessage({
            type: "system",
            subtype: "abort",
            message: `Session ended: ${frame.reason}${suffix}`,
            timestamp: frame.ts,
          });
          lastCursorRef.current = 0;
          lastSessionParamsRef.current = null;
          setState((s) => ({ ...s, attached: false, sessionId: null }));
          break;
        }

        case "user_message":
          // The UI adds user messages locally when the user presses enter;
          // the echoed frame would be a duplicate. Swallow it.
          break;

        case "assistant_message": {
          // Assistant frames arrive fully-formed (no deltas in v1). Walk
          // the content blocks, streaming text into the currentAssistant
          // bubble and routing thinking blocks through the status line.
          // tool_use blocks are already covered by tool_call_start frames
          // and are not rendered from here.
          let assistantText = "";
          for (const block of frame.content) {
            if (block.type === "text") {
              assistantText += block.text;
            } else if (block.type === "thinking") {
              if (cbs.onStatusUpdate) {
                cbs.onStatusUpdate(
                  classifyThinking(block.text.slice(0, 300)),
                );
              } else {
                cbs.addMessage({
                  type: "thinking",
                  content: block.text,
                  timestamp: frame.ts,
                });
              }
            }
          }
          if (assistantText) {
            const existing = cbs.currentAssistantMessage;
            if (!existing) {
              const msg: ChatMessage = {
                type: "chat",
                role: "assistant",
                content: assistantText,
                timestamp: frame.ts,
              };
              cbs.setCurrentAssistantMessage(msg);
              cbs.addMessage(msg);
            } else {
              const newContent = (existing.content || "") + assistantText;
              cbs.setCurrentAssistantMessage({
                ...existing,
                content: newContent,
              });
              cbs.updateLastMessage(newContent);
            }
          }
          break;
        }

        case "assistant_message_delta":
          // Not yet emitted by the backend — Step 8 will wire block-level
          // streaming updates. Safe to ignore today.
          break;

        case "tool_call_start": {
          // Cache for correlating the matching tool_call_end. Plan/Todo
          // tools are rendered via their specialized frames; skip the
          // status-line + cache side-effects for them so we don't show a
          // redundant spinner + tool result pair.
          const toolCallId = frame.toolCallId;
          const tool = frame.tool;
          const input: Record<string, unknown> =
            frame.input &&
            typeof frame.input === "object" &&
            !Array.isArray(frame.input)
              ? (frame.input as Record<string, unknown>)
              : {};
          toolCallCacheRef.current.set(toolCallId, { tool, input });

          if (tool === "ExitPlanMode" || tool === "TodoWrite") break;

          if (cbs.onStatusUpdate) {
            cbs.onStatusUpdate(classifyToolUse(tool, input));
          }
          break;
        }

        case "tool_call_update":
          // Reserved for stdout/stderr streaming on long-running tools.
          // Not currently emitted — Step 8 will wire incremental output
          // into the tool card.
          break;

        case "tool_call_end": {
          const cached = toolCallCacheRef.current.get(frame.toolCallId);
          toolCallCacheRef.current.delete(frame.toolCallId);
          if (!cached) break;
          // TodoWrite has no scrollback result — the specialized todo
          // frame already rendered its UI.
          if (cached.tool === "TodoWrite") break;

          const output = frame.output ?? frame.errorOutput ?? "";
          const isError = frame.status === "error";

          if (cbs.onStatusUpdate) {
            cbs.onStatusUpdate(
              classifyToolResult(cached.tool, cached.input, isError),
            );
          }

          cbs.addMessage(
            createToolResultMessage(
              cached.tool,
              output,
              frame.ts,
              frame.structured,
              cached.input,
              isError,
            ),
          );
          break;
        }

        case "interactive_prompt":
          cbs.addMessage({
            type: "interactive",
            kind: frame.kind,
            requestId: frame.requestId,
            prompt: frame.prompt,
            secret: frame.secret,
            placeholder: frame.placeholder ?? null,
            action: frame.action,
            details: frame.details ?? null,
            choices: frame.choices,
            answered: false,
            timestamp: frame.ts,
          });
          break;

        case "interactive_resolved":
          // TermInteractive flips `answered` locally on submit, so the
          // common case already self-heals. Step 8 will wire this frame
          // through addMessage so replay after reconnect shows the
          // resolved state for widgets that were answered on a different
          // tab. Safe to ignore today.
          break;

        case "file_delivery":
          cbs.addMessage({
            type: "file_delivery",
            path: frame.path,
            filename: frame.filename,
            action: frame.action,
            timestamp: frame.ts,
            oldString: frame.oldString,
            newString: frame.newString,
          });
          cbs.onFileDelivery?.(frame.path, frame.filename);
          break;

        case "plan":
          cbs.addMessage({
            type: "plan",
            plan: frame.plan,
            toolUseId: frame.toolCallId,
            timestamp: frame.ts,
          });
          break;

        case "todo":
          cbs.addMessage({
            type: "todo",
            todos: frame.todos,
            timestamp: frame.ts,
          });
          break;

        case "error":
          cbs.addMessage({
            type: "error",
            subtype: "stream_error",
            message: frame.message,
            timestamp: frame.ts,
          });
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
      // Reset replay state — we're starting fresh, no missed frames to recover.
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
  const sendMessage = useCallback((content: string, attachments?: string[]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(
      JSON.stringify({
        type: "message",
        content,
        ...(attachments?.length ? { attachments } : {}),
      }),
    );
  }, []);

  /**
   * Phase 6.4 — reply to an in-flight interactive MCP tool call.
   *
   * Sends a `tool_result` frame keyed by `original_request_id`. The backend
   * routes the reply to the matching pending request in SessionManager,
   * which resolves the broker promise and returns the value to Claude as
   * the MCP tool result.
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
    const ws = wsRef.current;
    if (ws) {
      ws.onclose = null; // Prevent auto-reconnect
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
