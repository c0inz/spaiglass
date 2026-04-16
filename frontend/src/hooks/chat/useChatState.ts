/**
 * Phase B — chat state hook (frame-native build).
 *
 * Scrollback rows live in `useFrameChatState`; this hook now only owns the
 * input/loading/session/status state that every path needs. The `messages`
 * array, `addMessage`, `updateLastMessage`, `markInteractiveAnswered`, and
 * `currentAssistantMessage` plumbing were removed when the legacy
 * AllMessage renderer was deleted — FrameChatView reads everything from
 * the pure reducer instead.
 */

import { useState, useCallback, useRef } from "react";
import type { DisplayStatus } from "../../utils/statusClassifier";
import { generateId } from "../../utils/id";

interface ChatStateOptions {
  initialSessionId?: string;
}

export function useChatState(options: ChatStateOptions = {}) {
  const { initialSessionId = null } = options;

  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    initialSessionId,
  );
  const [currentRequestId, setCurrentRequestId] = useState<string | null>(null);
  const [hasShownInitMessage, setHasShownInitMessage] = useState(false);
  const [hasReceivedInit, setHasReceivedInit] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<DisplayStatus | null>(
    null,
  );
  // Sticky timer: prevent lower-priority status from replacing a high-priority
  // one before its stickyMs expires.
  const stickyRef = useRef<{
    status: DisplayStatus;
    expiresAt: number;
  } | null>(null);

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

    if (
      sticky &&
      sticky.expiresAt > now &&
      status.priority < sticky.status.priority
    ) {
      return;
    }
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
    clearStatus();
  }, [clearStatus]);

  const startRequest = useCallback(() => {
    setIsLoading(true);
    setHasReceivedInit(false);
  }, []);

  return {
    // State
    input,
    isLoading,
    currentSessionId,
    currentRequestId,
    hasShownInitMessage,
    hasReceivedInit,
    currentStatus,

    // State setters
    setInput,
    setIsLoading,
    setCurrentSessionId,
    setCurrentRequestId,
    setHasShownInitMessage,
    setHasReceivedInit,

    // Helper functions
    updateStatus,
    clearStatus,
    clearInput,
    generateRequestId,
    resetRequestState,
    startRequest,
  };
}
