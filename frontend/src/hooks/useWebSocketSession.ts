/**
 * useWebSocketSession — Persistent WebSocket connection to SpAIglass backend.
 *
 * Replaces the fetch-per-message model with a single persistent connection.
 * Messages are sent via ws.send(), responses arrive via ws.onmessage.
 * The UnifiedMessageProcessor handles rendering — same pipeline as before.
 */

import { useRef, useCallback, useState, useEffect } from "react";
import type { AllMessage, ChatMessage, SDKMessage } from "../types";
import { UnifiedMessageProcessor } from "../utils/UnifiedMessageProcessor";

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
}

export function useWebSocketSession(options: WSSessionOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const processorRef = useRef(new UnifiedMessageProcessor());
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
      // Auto-reconnect after 2 seconds
      setTimeout(() => connect(), 2000);
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
   */
  const handleServerMessage = useCallback((msg: Record<string, unknown>) => {
    const cbs = callbacksRef.current;
    if (!cbs) return;

    // Phase 1: track the highest cursor we've seen on any frame.
    // The backend stamps `cursor` on every broadcast frame.
    if (typeof msg.cursor === "number" && msg.cursor > lastCursorRef.current) {
      lastCursorRef.current = msg.cursor;
    }

    switch (msg.type) {
      case "connected": {
        // Phase 2: relay handshake. Tells us our role on this VM so the UI
        // can hide the input bar for viewers.
        const role = (msg.role as "owner" | "editor" | "viewer" | undefined) ?? null;
        roleRef.current = role;
        setState((s) => ({ ...s, role }));
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
            url.searchParams.set("session", msg.sessionId as string);
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
            message: "Read-only mode — waiting for the owner to start a session.",
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

      case "session_info": {
        const commands = (msg.slashCommands as string[]) || [];
        setState((s) => ({
          ...s,
          sessionId: (msg.sessionId as string) || s.sessionId,
          slashCommands: commands,
        }));
        cbs.onSlashCommands?.(commands);
        break;
      }

      case "sdk_message": {
        const sdkMessage = msg.data as SDKMessage;
        const processingContext = {
          addMessage: cbs.addMessage,
          updateLastMessage: cbs.updateLastMessage,
          currentAssistantMessage: cbs.currentAssistantMessage,
          setCurrentAssistantMessage: cbs.setCurrentAssistantMessage,
          onSessionId: cbs.onSessionId,
          shouldShowInitMessage: () => true,
          onInitMessageShown: () => {},
          hasReceivedInit: false,
          setHasReceivedInit: () => {},
        };
        processorRef.current.processMessage(sdkMessage, processingContext, {
          isStreaming: true,
        });
        break;
      }

      case "file_delivery": {
        const data = msg.data as {
          path: string;
          filename: string;
          action: string;
        };
        cbs.addMessage({
          type: "file_delivery",
          path: data.path,
          filename: data.filename,
          action: data.action as "write" | "edit",
          timestamp: Date.now(),
        });
        cbs.onFileDelivery?.(data.path, data.filename);
        break;
      }

      case "error":
        cbs.addMessage({
          type: "error",
          subtype: "stream_error",
          message: (msg.message as string) || "Unknown error",
          timestamp: Date.now(),
        });
        break;

      case "session_ended":
        cbs.addMessage({
          type: "system",
          subtype: "abort",
          message: `Session ended: ${msg.reason || "unknown"}`,
          timestamp: Date.now(),
        });
        break;
    }
  }, []);

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
      url.searchParams.delete("session");
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
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
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
    interrupt,
  };
}
