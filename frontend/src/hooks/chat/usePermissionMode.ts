import { useState, useCallback } from "react";
import type { PermissionMode } from "../../types";

export interface UsePermissionModeResult {
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  isPlanMode: boolean;
  isDefaultMode: boolean;
  isAcceptEditsMode: boolean;
}

// Spaiglass defaults every new session to bypassPermissions — the user has
// explicitly asked for this because the whole point of Spaiglass is driving
// Claude Code across their own trusted fleet. If the user ever switches
// modes, we remember the choice in localStorage so reload doesn't revert.
const DEFAULT_MODE: PermissionMode = "bypassPermissions";
const STORAGE_KEY = "spaiglass:permissionMode";

function loadPermissionMode(): PermissionMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (
      raw === "default" ||
      raw === "plan" ||
      raw === "acceptEdits" ||
      raw === "bypassPermissions"
    ) {
      return raw;
    }
  } catch {
    // localStorage unavailable (private mode, etc.) — fall through to default
  }
  return DEFAULT_MODE;
}

/**
 * Hook for managing PermissionMode state across sessions.
 * Initial value comes from localStorage (if present) and defaults to
 * bypassPermissions. Every change is written back to localStorage so a
 * reload or new tab restores the user's last choice.
 */
export function usePermissionMode(): UsePermissionModeResult {
  const [permissionMode, setPermissionModeState] =
    useState<PermissionMode>(loadPermissionMode);

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    setPermissionModeState(mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Same story — best-effort persistence.
    }
  }, []);

  return {
    permissionMode,
    setPermissionMode,
    isPlanMode: permissionMode === "plan",
    isDefaultMode: permissionMode === "default",
    isAcceptEditsMode: permissionMode === "acceptEdits",
  };
}
