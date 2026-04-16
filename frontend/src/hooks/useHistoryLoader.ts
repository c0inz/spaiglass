/**
 * Phase B — frame-native history loader.
 *
 * Fetches `/api/projects/:encoded/histories/:sessionId` and hands back the
 * pre-replayed `Frame[]` the backend produced via server-side FrameEmitter.
 * No SDK-message → frame translation in the frontend; no legacy AllMessage
 * intermediate. Callers feed the array directly into `buildFrameState` /
 * `loadFrames`.
 */

import { useState, useEffect, useCallback } from "react";
import type { Frame } from "../../../shared/frames";
import type { ConversationHistory } from "../../../shared/types";
import { getConversationUrl } from "../config/api";

interface HistoryLoaderState {
  frames: Frame[];
  loading: boolean;
  error: string | null;
  sessionId: string | null;
}

interface HistoryLoaderResult extends HistoryLoaderState {
  loadHistory: (projectPath: string, sessionId: string) => Promise<void>;
  clearHistory: () => void;
}

export function useHistoryLoader(): HistoryLoaderResult {
  const [state, setState] = useState<HistoryLoaderState>({
    frames: [],
    loading: false,
    error: null,
    sessionId: null,
  });

  const loadHistory = useCallback(
    async (encodedProjectName: string, sessionId: string) => {
      if (!encodedProjectName || !sessionId) {
        setState((prev) => ({
          ...prev,
          error: "Encoded project name and session ID are required",
        }));
        return;
      }

      try {
        setState((prev) => ({
          ...prev,
          loading: true,
          error: null,
        }));

        const response = await fetch(
          getConversationUrl(encodedProjectName, sessionId),
        );

        if (!response.ok) {
          throw new Error(
            `Failed to load conversation: ${response.status} ${response.statusText}`,
          );
        }

        const conversationHistory: ConversationHistory = await response.json();

        // If the backend is serving a stale response shape (pre-Phase B
        // `{messages: [...]}` instead of `{frames: [...]}`), degrade
        // gracefully: skip history, log a warning, and let the chat open
        // empty. The alternative — hard-throwing and replacing the whole
        // view with an error screen — also hid the permission-mode
        // announcement and gave the user no way to start chatting.
        if (
          !conversationHistory.frames ||
          !Array.isArray(conversationHistory.frames)
        ) {
          console.warn(
            "History response missing frames[] (stale backend shape?). Opening empty scrollback.",
          );
          setState((prev) => ({
            ...prev,
            frames: [],
            loading: false,
            sessionId: conversationHistory.sessionId ?? sessionId,
          }));
          return;
        }

        // The backend produces Frame[] directly; cast through unknown[].
        const frames = conversationHistory.frames as Frame[];

        setState((prev) => ({
          ...prev,
          frames,
          loading: false,
          sessionId: conversationHistory.sessionId,
        }));
      } catch (error) {
        console.error("Error loading conversation history:", error);

        setState((prev) => ({
          ...prev,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to load conversation history",
        }));
      }
    },
    [],
  );

  const clearHistory = useCallback(() => {
    setState({
      frames: [],
      loading: false,
      error: null,
      sessionId: null,
    });
  }, []);

  return {
    ...state,
    loadHistory,
    clearHistory,
  };
}

/**
 * Hook for loading conversation history on mount when sessionId is provided.
 */
export function useAutoHistoryLoader(
  encodedProjectName?: string,
  sessionId?: string,
): HistoryLoaderResult {
  const historyLoader = useHistoryLoader();

  useEffect(() => {
    if (encodedProjectName && sessionId) {
      historyLoader.loadHistory(encodedProjectName, sessionId);
    } else if (!sessionId) {
      historyLoader.clearHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encodedProjectName, sessionId]);

  return historyLoader;
}
