/**
 * AgentSwitcher — header middle section. Shows recent-agent buttons plus
 * two dropdowns: Server and Directory. Picking a server jumps to the
 * user's most-recent URL on that server (auto-resumes the last session
 * there); if we have no recent URL for the server, falls back to the
 * Server+Directory picker. Picking a directory jumps to it.
 * Deleted directories fall out on the next fleet fetch (each page load
 * re-reads `/api/projects` from the VM's `~/.claude.json`).
 */

import { useMemo, useState, useEffect } from "react";
import {
  ServerIcon,
  FolderIcon,
  PlusCircleIcon,
  ChevronLeftIcon,
  ChatBubbleLeftRightIcon,
} from "@heroicons/react/24/outline";
import type {
  RecentAgent,
  FleetRole,
  FleetDirectory,
  FleetConnector,
} from "../hooks/useFleetAgents";
import type { ClaudeSessionRow } from "../../../shared/types";

interface AgentSwitcherProps {
  recentAgents: RecentAgent[];
  roles: FleetRole[];
  directories: FleetDirectory[];
  connectors: FleetConnector[];
  loading: boolean;
  isRelay: boolean;
  currentUrl?: string;
}

function shortPath(p: string): string {
  return p.replace(/^\/home\/[^/]+\//, "~/");
}

function compactLabel(label: string, max = 14): string {
  if (label.length <= max) return label;
  return label.slice(0, max - 1) + "\u2026";
}

/**
 * Given a target connector, jump to the most recent DIRECTORY URL the user
 * had on that server. ChatPage's auto-resume then picks up whichever chat
 * session was last active in that directory. If no recent URL is known for
 * this server, fall back to the Server+Directory picker.
 *
 * We do NOT append `?new=1` here: user feedback 2026-04-23 — "if i pick a
 * server load the last session directory for that server" / "you should
 * be loading my last session automatically". Server-switch should pick up
 * exactly where the user left off.
 *
 * We intentionally do NOT cross-check against the current fleet
 * `directories`/`roles` lists: those lists only include URL shapes the
 * server currently exposes, and mismatches (trailing slash, login
 * prefix, role-less vs legacy segment) cause valid recent URLs to be
 * rejected — at which point the dropdown dumps every switch onto the
 * picker, which is the UX we're specifically trying to avoid. If a
 * recent URL has actually gone stale, the destination page handles
 * that (RoleResolver bounces to `/?skip_last_used=1`).
 */
function pickServerTarget(
  conn: FleetConnector,
  recentAgents: RecentAgent[],
): string {
  const connLc = conn.name.toLowerCase();
  const matchingRecents = recentAgents
    .filter((a) => {
      const m = a.url.match(/^\/vm\/([^/]+)\//);
      if (!m) return false;
      const seg = m[1];
      const connPart = seg.includes(".")
        ? seg.slice(seg.indexOf(".") + 1)
        : seg;
      return connPart.toLowerCase() === connLc;
    })
    .sort((a, b) => b.timestamp - a.timestamp);
  const hit = matchingRecents[0]?.url;
  if (hit) return hit;
  return `/vm/${conn.name}/`;
}

export function AgentSwitcher({
  recentAgents,
  roles,
  directories,
  connectors,
  loading,
  isRelay,
  currentUrl,
}: AgentSwitcherProps) {
  const currentConnectorName = useMemo(() => {
    const sg = (window as Window & { __SG?: { slug?: string } }).__SG;
    const slug = sg?.slug;
    if (!slug) return null;
    return slug.includes(".") ? slug.slice(slug.indexOf(".") + 1) : slug;
  }, []);

  // Prefer `segment` over `project`: the inject script hyphen-splits segment
  // into project+role, so directories like "dezz-cms" would match as "dezz"
  // (and fail to highlight in the dropdown). Fall back to project for legacy
  // <project>-<role>/ URLs where segment doesn't exist on-record as a dir.
  const currentDirectoryName = useMemo(() => {
    const sg = (
      window as Window & {
        __SG?: { project?: string; segment?: string };
      }
    ).__SG;
    return sg?.segment || sg?.project || null;
  }, []);

  const onlineConns = useMemo(
    () =>
      connectors
        .filter((c) => c.online)
        .sort((a, b) =>
          (a.displayName || a.name).localeCompare(b.displayName || b.name),
        ),
    [connectors],
  );
  const offlineConns = useMemo(
    () => connectors.filter((c) => !c.online),
    [connectors],
  );

  const serverDirs = useMemo(
    () =>
      currentConnectorName
        ? directories
            .filter(
              (d) =>
                d.connectorName.toLowerCase() ===
                currentConnectorName.toLowerCase(),
            )
            .sort((a, b) =>
              (a.displayName || a.name).localeCompare(b.displayName || b.name),
            )
        : [],
    [directories, currentConnectorName],
  );

  const handleServerChange = (ev: React.ChangeEvent<HTMLSelectElement>) => {
    const bareName = ev.target.value;
    if (!bareName || bareName === currentConnectorName) return;
    const conn = connectors.find((c) => c.name === bareName);
    if (!conn) return;
    window.location.href = pickServerTarget(conn, recentAgents);
  };

  const handleDirectoryChange = (ev: React.ChangeEvent<HTMLSelectElement>) => {
    const name = ev.target.value;
    if (!name || !currentConnectorName) return;
    const dir = directories.find(
      (d) =>
        d.name === name &&
        d.connectorName.toLowerCase() === currentConnectorName.toLowerCase(),
    );
    if (!dir) return;
    if (dir.url === currentUrl) return;
    window.location.href = dir.url;
  };

  const selectClass =
    "px-2 py-1 text-xs font-medium rounded-md border bg-white/80 dark:bg-slate-800/80 border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-400/40 font-mono max-w-[12rem]";

  // Collapse recents to one button per server — newest entry wins. Clicking
  // a server button navigates to that server's most-recent directory URL,
  // and ChatPage's auto-resume picks up the last session there.
  const recentServers = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{
      conn: FleetConnector;
      url: string;
      dirLabel: string | null;
    }> = [];
    for (const agent of recentAgents) {
      const m = agent.url.match(/^\/vm\/([^/]+)\//);
      if (!m) continue;
      const slug = m[1];
      const bare = slug.includes(".")
        ? slug.slice(slug.indexOf(".") + 1)
        : slug;
      const key = bare.toLowerCase();
      if (seen.has(key)) continue;
      const conn = connectors.find((c) => c.name.toLowerCase() === key);
      if (!conn) continue;
      seen.add(key);
      const matchedDir = directories.find((d) => d.url === agent.url);
      const matchedRole = roles.find((r) => r.url === agent.url);
      const dirLabel = matchedDir
        ? matchedDir.displayName || matchedDir.name
        : matchedRole
          ? matchedRole.displayName || matchedRole.project
          : null;
      out.push({ conn, url: agent.url, dirLabel });
    }
    return out;
  }, [recentAgents, connectors, directories, roles]);

  // Early return moved AFTER all hooks (rules-of-hooks). When the SPA is
  // running outside the relay (no __SG context), the desktop AgentSwitcher
  // has nothing useful to show.
  if (!isRelay) return null;

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {/* Recent server buttons — one per server, label is the server name.
          Clicking re-enters that server's last-used URL (which encodes the
          last directory); ChatPage auto-resumes the last session on mount. */}
      {recentServers.map(({ conn, url, dirLabel }) => {
        const isCurrent = currentUrl && url === currentUrl;
        const label = conn.displayName || conn.name;
        return (
          <a
            key={conn.id}
            href={url}
            className={`px-2 py-1 text-xs font-medium rounded-md border transition-all duration-150 whitespace-nowrap ${
              isCurrent
                ? "bg-amber-100 dark:bg-amber-900/40 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300"
                : "bg-white/80 dark:bg-slate-800/80 border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 hover:border-slate-300 dark:hover:border-slate-500"
            }`}
            title={dirLabel ? `${label} — last: ${dirLabel}` : label}
          >
            {compactLabel(label)}
          </a>
        );
      })}

      {/* Server picker */}
      <div className="flex items-center gap-1" title="Server">
        <ServerIcon className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
        <select
          value={currentConnectorName || ""}
          onChange={handleServerChange}
          disabled={loading && onlineConns.length === 0}
          className={selectClass}
        >
          {!currentConnectorName && <option value="">(server)</option>}
          {onlineConns.map((c) => (
            <option key={c.id} value={c.name}>
              {c.displayName || c.name}
              {c.role !== "owner" ? ` [${c.role}]` : ""}
            </option>
          ))}
          {offlineConns.length > 0 && (
            <optgroup label="Offline">
              {offlineConns.map((c) => (
                <option key={c.id} value={c.name} disabled>
                  {c.displayName || c.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      {/* Directory picker */}
      <div className="flex items-center gap-1" title="Directory">
        <FolderIcon className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
        <select
          value={
            serverDirs.some((d) => d.name === currentDirectoryName)
              ? currentDirectoryName || ""
              : ""
          }
          onChange={handleDirectoryChange}
          disabled={serverDirs.length === 0}
          className={selectClass}
        >
          {serverDirs.length === 0 ? (
            <option value="">(ask install agent)</option>
          ) : (
            <>
              {!serverDirs.some((d) => d.name === currentDirectoryName) && (
                <option value="">(pick directory)</option>
              )}
              {serverDirs.map((d) => {
                const label = d.displayName || d.name;
                return (
                  <option key={d.url} value={d.name}>
                    {label} — {shortPath(d.path)}
                  </option>
                );
              })}
            </>
          )}
        </select>
      </div>
    </div>
  );
}

type WizardStep = "server" | "directory" | "session";

function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

/**
 * Lossy path signature mirroring the Claude SDK's project-name encoding
 * (`/`, `\`, ':', '.', '_' all collapse to '-'). Used as a fallback
 * comparator when matching a session's reverse-decoded `projectPath`
 * against a registered directory path that the SDK had encoded.
 */
function lossyPathSig(p: string): string {
  return stripTrailingSlash(p).replace(/[/\\:._]/g, "-").toLowerCase();
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || isNaN(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/**
 * AgentPickerFullPage — mobile full-page picker. Three-step wizard:
 *   1. Pick a server   (one tap target per online connector)
 *   2. Pick a directory on that server
 *   3. Start a new session OR resume a recent session in that directory
 *
 * Replaces the prior dropdowns + flat tree layout, which surfaced too
 * much fleet structure on a phone. Wizard keeps each screen focused on
 * one decision; back link reverses one step at a time. The wizard
 * pre-selects the user's current server when one is known (from the
 * relay-injected `__SG.slug`), so the common case opens directly on
 * Step 2.
 *
 * Step 3 fetches `/vm/<server>/api/claude-sessions` and filters to
 * sessions whose recorded cwd matches the chosen directory's path.
 * Same data and resume-by-cwd URL pattern as SessionPickerModal.
 *
 * Roles and the legacy "Recent" list are deliberately not surfaced here:
 * roles are no longer required (since 2026-05-02), and the wizard is
 * fewer taps than scanning a Recent strip.
 */
export function AgentPickerFullPage({
  recentAgents: _recentAgents,
  roles: _roles,
  directories,
  connectors,
  loading,
}: {
  recentAgents: RecentAgent[];
  roles: FleetRole[];
  directories: FleetDirectory[];
  connectors: FleetConnector[];
  loading: boolean;
}) {
  void _recentAgents;
  void _roles;

  const onlineConns = connectors
    .filter((c) => c.online)
    .sort((a, b) =>
      (a.displayName || a.name).localeCompare(b.displayName || b.name),
    );
  const offlineConns = connectors.filter((c) => !c.online);

  const sg = (
    window as Window & {
      __SG?: { slug?: string; project?: string; segment?: string };
    }
  ).__SG;
  const currentConnectorName = sg?.slug
    ? sg.slug.includes(".")
      ? sg.slug.slice(sg.slug.indexOf(".") + 1)
      : sg.slug
    : null;
  const initialServer = currentConnectorName
    ? (connectors.find(
        (c) =>
          c.name.toLowerCase() === currentConnectorName.toLowerCase() &&
          c.online,
      ) ?? null)
    : null;

  const [step, setStep] = useState<WizardStep>(
    initialServer ? "directory" : "server",
  );
  const [chosenServer, setChosenServer] = useState<FleetConnector | null>(
    initialServer,
  );
  const [chosenDir, setChosenDir] = useState<FleetDirectory | null>(null);
  const [sessions, setSessions] = useState<ClaudeSessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Fetch sessions on entering step 3. Filtered to the chosen directory's
  // cwd so only relevant rows appear. Cross-VM works because /vm/<conn>/
  // is a relay-tunneled path.
  //
  // Path comparison has two tiers:
  //   1. Exact match (after trailing-slash strip) on any candidate path.
  //      `spaiglassWorkingDirectory` is recorded verbatim in spaiglass meta,
  //      so it always wins this fast path when the row is spaiglass-source.
  //   2. Lossy-collapse match. Claude-CLI rows only carry a `projectPath`
  //      that was reverse-decoded from `~/.claude/projects/<encoded>/`. The
  //      SDK encoding is lossy: '/', '\\', ':', '.', '_' all → '-'. A path
  //      like "/home/x/my_project" round-trips as "/home/x/my/project" and
  //      fails strict equality even though it really is the chosen
  //      directory. Apply the same lossy collapse on both sides.
  useEffect(() => {
    if (step !== "session" || !chosenServer || !chosenDir) return;
    let cancelled = false;
    setSessionsLoading(true);
    setSessions([]);
    fetch(`/vm/${chosenServer.name}/api/claude-sessions`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const all: ClaudeSessionRow[] = data?.sessions || [];
        const cwdExact = stripTrailingSlash(chosenDir.path);
        const cwdLossy = lossyPathSig(chosenDir.path);
        const filtered = all.filter((s) => {
          const candidates = [
            s.spaiglassWorkingDirectory,
            s.projectPath,
            s.cwd,
          ].filter(
            (p): p is string => typeof p === "string" && p.length > 0,
          );
          for (const p of candidates) {
            if (stripTrailingSlash(p) === cwdExact) return true;
          }
          for (const p of candidates) {
            if (lossyPathSig(p) === cwdLossy) return true;
          }
          return false;
        });
        setSessions(filtered);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, chosenServer?.id, chosenDir?.url, chosenDir?.path]);

  function pickServer(c: FleetConnector) {
    setChosenServer(c);
    setChosenDir(null);
    setStep("directory");
  }
  function pickDirectory(d: FleetDirectory) {
    setChosenDir(d);
    setStep("session");
  }
  function backToServers() {
    setChosenServer(initialServer);
    setChosenDir(null);
    setStep("server");
  }
  function backToDirectories() {
    setChosenDir(null);
    setStep("directory");
  }
  function startNewSession() {
    if (!chosenDir) return;
    const url =
      chosenDir.url + (chosenDir.url.includes("?") ? "&" : "?") + "new=1";
    window.location.href = url;
  }
  function resumeSession(s: ClaudeSessionRow) {
    if (!chosenDir) return;
    const params = new URLSearchParams({
      sessionId: s.sessionId,
      cwd:
        s.spaiglassWorkingDirectory || s.projectPath || s.cwd || chosenDir.path,
    });
    window.location.href = chosenDir.url + "?" + params.toString();
  }

  // ─── Step 1: Server ──────────────────────────────────────────────────
  if (step === "server") {
    return (
      <div className="flex-1 overflow-auto bg-white dark:bg-slate-900">
        <div className="px-4 py-4 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <ServerIcon className="w-5 h-5" />
            Pick a server
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Step 1 of 3
          </div>
        </div>
        {loading && onlineConns.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-sm text-slate-400">Loading fleet…</div>
          </div>
        ) : (
          <>
            {onlineConns.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => pickServer(c)}
                className="w-full flex items-center gap-3 px-4 py-4 border-b border-slate-100 dark:border-slate-800 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 active:bg-slate-100 dark:active:bg-slate-800 transition-colors"
              >
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" />
                <span className="text-base font-medium text-slate-800 dark:text-slate-100 truncate">
                  {c.displayName || c.name}
                </span>
                {c.role !== "owner" && (
                  <span className="ml-auto text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500 flex-shrink-0">
                    {c.role}
                  </span>
                )}
              </button>
            ))}
            {offlineConns.length > 0 && (
              <>
                <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-800/50 border-y border-slate-200 dark:border-slate-700">
                  Offline
                </div>
                {offlineConns.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 dark:border-slate-800 text-slate-400 dark:text-slate-500"
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-slate-300 dark:bg-slate-600 flex-shrink-0" />
                    <span className="text-base truncate">
                      {c.displayName || c.name}
                    </span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    );
  }

  // ─── Step 2: Directory ───────────────────────────────────────────────
  if (step === "directory" && chosenServer) {
    const dirs = directories
      .filter(
        (d) =>
          d.connectorName.toLowerCase() === chosenServer.name.toLowerCase(),
      )
      .sort((a, b) =>
        (a.displayName || a.name).localeCompare(b.displayName || b.name),
      );
    return (
      <div className="flex-1 overflow-auto bg-white dark:bg-slate-900">
        <button
          type="button"
          onClick={backToServers}
          className="w-full flex items-center gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700"
        >
          <ChevronLeftIcon className="w-4 h-4" />
          Servers
        </button>
        <div className="px-4 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <FolderIcon className="w-5 h-5" />
            Pick a directory on{" "}
            <span className="text-blue-600 dark:text-blue-400">
              {chosenServer.displayName || chosenServer.name}
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Step 2 of 3
          </div>
        </div>
        {dirs.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <div className="text-sm text-slate-500 dark:text-slate-400">
              No directories on this server yet.
            </div>
            <div className="mt-2 text-xs text-slate-400 dark:text-slate-500">
              Register one with{" "}
              <code className="font-mono bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded">
                POST /api/projects/register
              </code>{" "}
              on the VM, or ask your install agent.
            </div>
          </div>
        ) : (
          dirs.map((d) => (
            <button
              key={d.url}
              type="button"
              onClick={() => pickDirectory(d)}
              className="w-full flex items-start gap-3 px-4 py-4 border-b border-slate-100 dark:border-slate-800 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 active:bg-slate-100 dark:active:bg-slate-800 transition-colors"
            >
              <FolderIcon className="w-5 h-5 mt-0.5 text-slate-400 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-base font-medium text-blue-600 dark:text-blue-400 truncate">
                  {d.displayName || d.name}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500 font-mono truncate">
                  {shortPath(d.path)}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    );
  }

  // ─── Step 3: Session ─────────────────────────────────────────────────
  if (step === "session" && chosenServer && chosenDir) {
    return (
      <div className="flex-1 overflow-auto bg-white dark:bg-slate-900">
        <button
          type="button"
          onClick={backToDirectories}
          className="w-full flex items-center gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700"
        >
          <ChevronLeftIcon className="w-4 h-4" />
          {chosenServer.displayName || chosenServer.name}
        </button>
        <div className="px-4 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <ChatBubbleLeftRightIcon className="w-5 h-5" />
            <span className="text-blue-600 dark:text-blue-400 truncate">
              {chosenDir.displayName || chosenDir.name}
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Step 3 of 3 · {shortPath(chosenDir.path)}
          </div>
        </div>

        {/* Primary CTA: start a new session */}
        <button
          type="button"
          onClick={startNewSession}
          className="w-full flex items-center justify-center gap-2 px-4 py-5 text-base font-semibold text-white bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 transition-colors"
        >
          <PlusCircleIcon className="w-5 h-5" />
          Start a new session
        </button>

        {/* Resume list */}
        {sessionsLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-sm text-slate-400">Loading sessions…</div>
          </div>
        ) : sessions.length > 0 ? (
          <>
            <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
              Or resume a recent session
            </div>
            {sessions.map((s) => {
              const preview =
                s.lastUserMessage ||
                s.firstUserMessage ||
                s.lastMessagePreview ||
                "(no preview)";
              return (
                <button
                  key={s.sessionId}
                  type="button"
                  onClick={() => resumeSession(s)}
                  className="w-full text-left px-4 py-3 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 active:bg-slate-100 dark:active:bg-slate-800 transition-colors"
                >
                  <div className="text-sm text-slate-800 dark:text-slate-100 line-clamp-2">
                    {preview}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                    {relativeTime(s.lastTime)}
                    {typeof s.userTurnCount === "number" && (
                      <>
                        {" · "}
                        {s.userTurnCount}↔{s.assistantTurnCount ?? 0} turns
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </>
        ) : (
          <div className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
            No past sessions in this directory.
          </div>
        )}
      </div>
    );
  }

  // Fallback (shouldn't happen — chosenServer/chosenDir invariants are
  // upheld by step transitions). Reset to step 1 if we land here.
  return (
    <div className="flex-1 overflow-auto bg-white dark:bg-slate-900 px-4 py-8 text-center">
      <button
        type="button"
        onClick={backToServers}
        className="text-sm text-blue-600 dark:text-blue-400"
      >
        Back to servers
      </button>
    </div>
  );
}
