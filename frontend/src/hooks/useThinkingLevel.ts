import { useState, useCallback } from "react";

export type ThinkingLevel = "off" | "brief" | "extended" | "auto";

export interface UseThinkingLevelResult {
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
}

// Default is "auto" so the fleet-wide ~/.claude/settings.json baseline
// (alwaysThinkingEnabled / MAX_THINKING_TOKENS) reaches SpaiGlass users
// without forcing them to discover the toggle. The backend resolves
// "auto" by reading the VM's settings.json on session_start.
const DEFAULT_LEVEL: ThinkingLevel = "auto";
const STORAGE_KEY = "spaiglass:thinkingLevel";

function loadThinkingLevel(): ThinkingLevel {
  if (typeof window === "undefined") return DEFAULT_LEVEL;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (
      raw === "off" ||
      raw === "brief" ||
      raw === "extended" ||
      raw === "auto"
    )
      return raw;
  } catch {
    // localStorage unavailable — fall through
  }
  return DEFAULT_LEVEL;
}

/**
 * Hook for managing thinkingLevel state. Initial value comes from
 * localStorage (if present) and defaults to "off". Every change is
 * written back so a reload or new tab restores the user's last choice.
 *
 * The value is sent to the backend in the session_start WS payload and
 * applied as the SDK's `thinking` option at startup. Mid-session toggle
 * does not retroactively affect the running SDK — the user must
 * `/reset` (or restart the session) for a new value to take effect. The
 * UI emits a notice on toggle to make this clear.
 */
export function useThinkingLevel(): UseThinkingLevelResult {
  const [thinkingLevel, setThinkingLevelState] =
    useState<ThinkingLevel>(loadThinkingLevel);

  const setThinkingLevel = useCallback((level: ThinkingLevel) => {
    setThinkingLevelState(level);
    try {
      window.localStorage.setItem(STORAGE_KEY, level);
    } catch {
      // best-effort persistence
    }
  }, []);

  return { thinkingLevel, setThinkingLevel };
}
