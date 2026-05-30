import { useEffect, useState } from "react";

interface SelfInfo {
  spaiglassVersion: string | null;
  latestSpaiglassVersion: string | null;
  name: string;
}

/**
 * Outdated-VM banner.
 *
 * When the connector backing this page reports a spaiglass install version
 * older than what the relay is currently publishing, surface a one-line
 * banner with the platform-agnostic update command. Dismissal is sticky per
 * (VM, version) — re-shows automatically when a newer version is published.
 *
 * Renders nothing when:
 *   - Not running through the relay (window.__SG is missing)
 *   - VM hasn't reported a version yet (never authenticated)
 *   - Versions match (or relay's latest is unknown)
 *   - User dismissed for this exact (VM, latest version) pair
 */
export function OutdatedBanner() {
  const sg = (window as Window & { __SG?: { slug?: string } }).__SG;
  const isRelay = !!sg?.slug;

  const [info, setInfo] = useState<SelfInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isRelay) return;
    fetch("/api/__relay/self")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SelfInfo | null) => {
        if (!d) return;
        setInfo(d);
        // Sticky-dismiss keyed by VM + latest version so a future release
        // breaks the dismissal automatically.
        const key = `sg_outdated_dismissed:${d.name}:${d.latestSpaiglassVersion ?? ""}`;
        if (localStorage.getItem(key) === "1") setDismissed(true);
      })
      .catch(() => {});
  }, [isRelay]);

  if (!isRelay || !info || dismissed) return null;
  const { spaiglassVersion, latestSpaiglassVersion, name } = info;
  if (!spaiglassVersion || !latestSpaiglassVersion) return null;
  if (spaiglassVersion === latestSpaiglassVersion) return null;

  const dismiss = () => {
    const key = `sg_outdated_dismissed:${name}:${latestSpaiglassVersion}`;
    localStorage.setItem(key, "1");
    setDismissed(true);
  };

  // Position fixed at top so the banner overlays the ChatPage layout
  // (which fills h-[100dvh] and would push a normal-flow banner off-screen).
  // High z-index keeps it above the chat header strip.
  return (
    <div className="fixed top-0 left-0 right-0 z-[100] flex items-center gap-3 px-3 py-2 bg-amber-100 dark:bg-amber-500/90 border-b border-amber-300 dark:border-amber-400 text-xs shadow-md">
      <span className="text-amber-900 dark:text-amber-950 font-semibold flex-shrink-0">
        ⚠ Update available:
      </span>
      <span className="text-amber-900 dark:text-amber-950 flex-shrink-0">
        VM is on{" "}
        <code className="font-mono font-semibold">{spaiglassVersion}</code>,
        latest is{" "}
        <code className="font-mono font-semibold">
          {latestSpaiglassVersion}
        </code>
        . Re-run the installer on the VM:
      </span>
      <code className="font-mono px-2 py-0.5 rounded bg-amber-200 dark:bg-amber-950/40 text-amber-900 dark:text-amber-950 truncate">
        curl -fsSL https://spaiglass.xyz/install.sh | bash
      </code>
      <span className="text-amber-800 dark:text-amber-950/80 flex-shrink-0">
        (Windows:{" "}
        <code className="font-mono">
          iwr https://spaiglass.xyz/install.ps1 -useb | iex
        </code>
        )
      </span>
      <button
        onClick={dismiss}
        className="ml-auto text-amber-700 hover:text-amber-900 dark:text-amber-950 dark:hover:text-black flex-shrink-0 font-bold text-base leading-none"
        title="Dismiss until next release"
      >
        ✕
      </button>
    </div>
  );
}
