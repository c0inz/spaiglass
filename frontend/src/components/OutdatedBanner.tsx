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

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800/30 text-xs">
      <span className="text-amber-700 dark:text-amber-300 font-medium flex-shrink-0">
        Update available:
      </span>
      <span className="text-amber-700 dark:text-amber-300 flex-shrink-0">
        VM is on{" "}
        <code className="font-mono">{spaiglassVersion}</code>, latest is{" "}
        <code className="font-mono">{latestSpaiglassVersion}</code>. Re-run the
        installer on the VM:
      </span>
      <code className="font-mono px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 truncate">
        curl -fsSL https://spaiglass.xyz/install.sh | bash
      </code>
      <span className="text-amber-600 dark:text-amber-400 flex-shrink-0">
        (Windows:{" "}
        <code className="font-mono">
          iwr https://spaiglass.xyz/install.ps1 -useb | iex
        </code>
        )
      </span>
      <button
        onClick={dismiss}
        className="ml-auto text-amber-500 hover:text-amber-700 dark:hover:text-amber-300 flex-shrink-0"
        title="Dismiss until next release"
      >
        ✕
      </button>
    </div>
  );
}
