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
}

export function useWebSocketSession(options: WSSessionOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const processorRef = useRef(new UnifiedMessageProcessor());
  const [state, setState] = useState<WSSessionState>({
    connected: false,
    sessionId: null,
    slashCommands: [],
  });

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

  const setCallbacks = useCallback(
    (cbs: typeof callbacksRef.current) => {
      callbacksRef.current = cbs;
    },
    [],
  );

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

    switch (msg.type) {
      case "session_ack":
        setState((s) => ({
          ...s,
          sessionId: msg.sessionId as string,
          slashCommands: (msg.slashCommands as string[]) || [],
        }));
        break;

      case "session_info": {
        const commands = (msg.slashCommands as string[]) || [];
        setState((s) => ({
          ...s,
          sessionId: msg.sessionId as string || s.sessionId,
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
        const data = msg.data as { path: string; filename: string; action: string };
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
   */
  const startSession = useCallback(
    (roleFile: string, workingDirectory: string, contextContent?: string) => {
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
   * Interrupt the current response.
   */
  const interrupt = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  /**
   * Disconnect.
   */
  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      ws.onclose = null; // Prevent auto-reconnect
      ws.close();
      wsRef.current = null;
      setState({ connected: false, sessionId: null, slashCommands: [] });
    }
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
