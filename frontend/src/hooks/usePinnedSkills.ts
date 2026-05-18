/**
 * usePinnedSkills — localStorage-backed Set<string> of skill IDs the user
 * has pinned. Drives the chip row above ChatInput. Per-browser, not per-VM
 * (the user's preferences travel with them).
 */

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "spaiglass:pinnedSkills";

function load(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function persist(ids: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // best-effort; private mode etc.
  }
}

export interface UsePinnedSkillsResult {
  pinnedIds: string[];
  isPinned: (id: string) => boolean;
  pin: (id: string) => void;
  unpin: (id: string) => void;
  toggle: (id: string) => void;
  clear: () => void;
}

export function usePinnedSkills(): UsePinnedSkillsResult {
  const [ids, setIds] = useState<string[]>(load);

  // Mirror across tabs — when a sibling tab updates the pin set, pick up
  // the change here too. Avoids stale chips after configuring on another
  // device or in another window.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setIds(load());
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const isPinned = useCallback(
    (id: string) => ids.includes(id),
    [ids],
  );

  const pin = useCallback((id: string) => {
    setIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      persist(next);
      return next;
    });
  }, []);

  const unpin = useCallback((id: string) => {
    setIds((prev) => {
      if (!prev.includes(id)) return prev;
      const next = prev.filter((x) => x !== id);
      persist(next);
      return next;
    });
  }, []);

  const toggle = useCallback((id: string) => {
    setIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      persist(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setIds([]);
    persist([]);
  }, []);

  return { pinnedIds: ids, isPinned, pin, unpin, toggle, clear };
}
