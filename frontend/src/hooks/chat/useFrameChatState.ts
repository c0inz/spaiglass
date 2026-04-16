/**
 * Phase B — frame-native chat state hook.
 *
 * Thin wrapper around the pure `applyFrame` reducer in
 * `terminal/frames/state.ts`. Keeps the React bridge small:
 *
 *   - `state` — the current FrameState (rows, toolCalls, session, lastSeq)
 *   - `addFrame(frame)` — apply a single frame, preserving referential
 *      equality on unchanged branches so React.memo short-circuits work
 *   - `resetFrames()` — wipe state (used when hopping historical sessions)
 *   - `loadFrames(frames)` — replay an ordered array in one go via the
 *      pure `buildFrameState` helper (used by history hydration)
 *
 * This hook deliberately does NOT own request/loading/UI concerns — those
 * stay in useChatState so the two renderers can share the same session
 * plumbing while differing only on how frames land in scrollback.
 */

import { useCallback, useReducer } from "react";
import type { Frame } from "../../../../shared/frames";
import {
  applyFrame,
  buildFrameState,
  initialFrameState,
  type FrameState,
} from "../../terminal/frames/state";

type Action =
  | { type: "frame"; frame: Frame }
  | { type: "load"; frames: Frame[] }
  | { type: "reset" };

function reducer(state: FrameState, action: Action): FrameState {
  switch (action.type) {
    case "frame":
      return applyFrame(state, action.frame);
    case "load":
      return buildFrameState(action.frames);
    case "reset":
      return initialFrameState();
  }
}

export interface UseFrameChatStateResult {
  state: FrameState;
  addFrame: (frame: Frame) => void;
  loadFrames: (frames: Frame[]) => void;
  resetFrames: () => void;
}

export function useFrameChatState(): UseFrameChatStateResult {
  const [state, dispatch] = useReducer(reducer, undefined, initialFrameState);

  const addFrame = useCallback((frame: Frame) => {
    dispatch({ type: "frame", frame });
  }, []);

  const loadFrames = useCallback((frames: Frame[]) => {
    dispatch({ type: "load", frames });
  }, []);

  const resetFrames = useCallback(() => {
    dispatch({ type: "reset" });
  }, []);

  return { state, addFrame, loadFrames, resetFrames };
}
