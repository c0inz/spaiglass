import { useEffect, useState } from "react";

/**
 * Tracks whether the viewport is below the mobile breakpoint (768px,
 * Tailwind's `md`). Used by ChatPage to swap the desktop horizontal-split
 * layout for a single-panel-with-bottom-tabs layout on phones.
 *
 * Updates on resize via matchMedia so rotating a phone or resizing a desktop
 * window flips the layout live without a reload.
 */
export function useIsMobile(maxWidthPx: number = 767): boolean {
  const query = `(max-width: ${maxWidthPx}px)`;

  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // Sync on mount in case SSR/initial state was wrong
    setIsMobile(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return isMobile;
}
