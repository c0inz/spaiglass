import { useState, useCallback, useEffect, useRef } from "react";
import type { AllMessage, ChatMessage } from "../../types";
import type { DisplayStatus } from "../../utils/statusClassifier";
import { generateId } from "../../utils/id";

interface ChatStateOptions {
  initialMessages?: AllMessage[];
  initialSessionId?: string;
}

const DEFAULT_MESSAGES: AllMessage[] = [];

export function useChatState(options: ChatStateOptions = {}) {
  const { initialMessages = DEFAULT_MESSAGES, initialSessionId = null } =
    options;

  // Initialize state once. Do NOT re-sync from initialMessages on every parent
  // render — that would wipe live messages arriving via WebSocket.
  const [messages, setMessages] = useState<AllMessage[]>(
    () => initialMessages,
  );
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    initialSessionId,
  );
  const [currentRequestId, setCurrentRequestId] = useState<string | null>(null);
  const [hasShownInitMessage, setHasShownInitMessage] = useState(false);
  const [hasReceivedInit, setHasReceivedInit] = useState(false);
  const [currentAssistantMessage, setCurrentAssistantMessage] =
    useState<ChatMessage | null>(null);
  const [currentStatus, setCurrentStatus] = useState<DisplayStatus | null>(null);
  // Sticky timer: prevent lower-priority status from replacing a high-priority
  // one before its stickyMs expires.
  const stickyRef = useRef<{ status: DisplayStatus; expiresAt: number } | null>(null);
  const hydratedSessionIdRef = useRef<string | null>(null);

  // Re-hydrate messages when the parent loads a different historical session.
  // For the active live session, only fill from history if the chat is still empty
  // so we don't wipe messages that arrived over WebSocket first.
  useEffect(() => {
    if (!initialSessionId) {
      return;
    }

    setCurrentSessionId(initialSessionId);
    setMessages((prev) => {
      const isDifferentSession =
        (hydratedSessionIdRef.current !== null &&
          hydratedSessionIdRef.current !== initialSessionId) ||
        (currentSessionId !== null && currentSessionId !== initialSessionId);
      const shouldHydrateEmptyChat =
        prev.length === 0 && initialMessages.length > 0;

      if (isDifferentSession || shouldHydrateEmptyChat) {
        hydratedSessionIdRef.current = initialSessionId;
        return initialMessages;
      }

      hydratedSessionIdRef.current = initialSessionId;
      return prev;
    });
  }, [currentSessionId, initialMessages, initialSessionId]);

  const addMessage = useCallback((msg: AllMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const updateLastMessage = useCallback((content: string) => {
    setMessages((prev) =>
      prev.map((msg, index) =>
        index === prev.length - 1 && msg.type === "chat"
          ? { ...msg, content }
          : msg,
      ),
    );
  }, []);

  const clearInput = useCallback(() => {
    setInput("");
  }, []);

  const generateRequestId = useCallback(() => {
    const requestId = generateId();
    setCurrentRequestId(requestId);
    return requestId;
  }, []);

  const updateStatus = useCallback((status: DisplayStatus) => {
    const now = Date.now();
    const sticky = stickyRef.current;

    // If a higher-priority status is still sticky, don't downgrade
    if (sticky && sticky.expiresAt > now && status.priority < sticky.status.priority) {
      return;
    }

    // Same dedupeKey — don't re-render (avoid flicker)
    if (sticky && sticky.status.dedupeKey === status.dedupeKey) {
      return;
    }

    stickyRef.current = { status, expiresAt: now + status.stickyMs };
    setCurrentStatus(status);
  }, []);

  const clearStatus = useCallback(() => {
    stickyRef.current = null;
    setCurrentStatus(null);
  }, []);

  const resetRequestState = useCallback(() => {
    setIsLoading(false);
    setCurrentRequestId(null);
    setCurrentAssistantMessage(null);
    clearStatus();
  }, [clearStatus]);

  const startRequest = useCallback(() => {
    setIsLoading(true);
    setCurrentAssistantMessage(null);
    setHasReceivedInit(false);
  }, []);

  return {
    // State
    messages,
    input,
    isLoading,
    currentSessionId,
    currentRequestId,
    hasShownInitMessage,
    hasReceivedInit,
    currentAssistantMessage,
    currentStatus,

    // State setters
    setMessages,
    setInput,
    setIsLoading,
    setCurrentSessionId,
    setCurrentRequestId,
    setHasShownInitMessage,
    setHasReceivedInit,
    setCurrentAssistantMessage,

    // Helper functions
    addMessage,
    updateLastMessage,
    updateStatus,
    clearStatus,
    clearInput,
    generateRequestId,
    resetRequestState,
    startRequest,
  };
}
