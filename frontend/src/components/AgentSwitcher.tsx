/**
 * AgentSwitcher — header middle section. Shows recent-agent buttons plus
 * two dropdowns: Server and Directory. Picking a server jumps to the
 * user's most-recent URL on that server (auto-resumes the last session
 * there); if we have no recent URL for the server, falls back to the
 * Server+Directory picker. Picking a directory jumps to it.
 * Deleted directories fall out on the next fleet fetch (each page load
 * re-reads `/api/projects` from the VM's `~/.claude.json`).
 */

import { useMemo } from "react";
import { ServerIcon, FolderIcon } from "@heroicons/react/24/outline";
import type {
  RecentAgent,
  FleetRole,
  FleetDirectory,
  FleetConnector,
} from "../hooks/useFleetAgents";

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
    const sg = (window as Window & {
      __SG?: { project?: string; segment?: string };
    }).__SG;
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
              (a.displayName || a.name).localeCompare(
                b.displayName || b.name,
              ),
            )
        : [],
    [directories, currentConnectorName],
  );

  if (!isRelay) return null;

  const handleServerChange = (ev: React.ChangeEvent<HTMLSelectElement>) => {
    const bareName = ev.target.value;
    if (!bareName || bareName === currentConnectorName) return;
    const conn = connectors.find((c) => c.name === bareName);
    if (!conn) return;
    window.location.href = pickServerTarget(conn, recentAgents);
  };

  const handleDirectoryChange = (
    ev: React.ChangeEvent<HTMLSelectElement>,
  ) => {
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

/**
 * AgentPickerFullPage — mobile full-page picker. Mirrors desktop: two
 * prominent native selects (Server + Directory) at the top with the same
 * pickServerTarget semantics, plus a scrollable browse list below.
 */
export function AgentPickerFullPage({
  recentAgents,
  roles,
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
  const onlineConns = connectors
    .filter((c) => c.online)
    .sort((a, b) =>
      (a.displayName || a.name).localeCompare(b.displayName || b.name),
    );
  const offlineConns = connectors.filter((c) => !c.online);

  // Current server + directory from __SG (same source of truth as desktop).
  // `segment` wins over `project` so hyphenated directory names
  // ("dezz-cms") highlight correctly instead of showing the hyphen-split
  // stem ("dezz") and failing to match.
  const sg = (window as Window & {
    __SG?: { slug?: string; project?: string; segment?: string };
  }).__SG;
  const currentConnectorName = sg?.slug
    ? sg.slug.includes(".")
      ? sg.slug.slice(sg.slug.indexOf(".") + 1)
      : sg.slug
    : null;
  const currentDirectoryName = sg?.segment || sg?.project || null;
  const serverDirs = currentConnectorName
    ? directories
        .filter(
          (d) =>
            d.connectorName.toLowerCase() ===
            currentConnectorName.toLowerCase(),
        )
        .sort((a, b) =>
          (a.displayName || a.name).localeCompare(b.displayName || b.name),
        )
    : [];

  const handleServerChange = (ev: React.ChangeEvent<HTMLSelectElement>) => {
    const name = ev.target.value;
    if (!name || name === currentConnectorName) return;
    const conn = connectors.find((c) => c.name === name);
    if (!conn) return;
    window.location.href = pickServerTarget(conn, recentAgents);
  };

  const handleDirectoryChange = (
    ev: React.ChangeEvent<HTMLSelectElement>,
  ) => {
    const name = ev.target.value;
    if (!name || !currentConnectorName) return;
    const dir = directories.find(
      (d) =>
        d.name === name &&
        d.connectorName.toLowerCase() ===
          currentConnectorName.toLowerCase(),
    );
    if (!dir) return;
    window.location.href = dir.url;
  };

  const selectMobile =
    "w-full px-3 py-3 text-base rounded-md border bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-800 dark:text-slate-100 font-mono";

  return (
    <div className="flex-1 overflow-auto bg-white dark:bg-slate-900">
      {/* Prominent Server + Directory selects */}
      <div className="p-4 space-y-3 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
        <div>
          <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
            <ServerIcon className="w-4 h-4" />
            Server
          </label>
          <select
            value={currentConnectorName || ""}
            onChange={handleServerChange}
            disabled={loading && onlineConns.length === 0}
            className={selectMobile}
          >
            {!currentConnectorName && <option value="">(pick server)</option>}
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
        <div>
          <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
            <FolderIcon className="w-4 h-4" />
            Directory
          </label>
          <select
            value={
              serverDirs.some((d) => d.name === currentDirectoryName)
                ? currentDirectoryName || ""
                : ""
            }
            onChange={handleDirectoryChange}
            disabled={serverDirs.length === 0}
            className={selectMobile}
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

      {recentAgents.length > 0 && (
        <div>
          <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
            Recent
          </div>
          {recentAgents.map((agent) => (
            <a
              key={agent.url}
              href={agent.url}
              className="flex items-baseline gap-2 px-4 py-2 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
            >
              <span className="text-sm font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap">
                {agent.label}
              </span>
            </a>
          ))}
        </div>
      )}

      {loading && onlineConns.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-sm text-slate-400">Loading fleet...</div>
        </div>
      ) : (
        onlineConns.map((conn) => {
          const dirs = directories
            .filter((d) => d.connectorName === conn.name)
            .sort((a, b) =>
              (a.displayName || a.name).localeCompare(
                b.displayName || b.name,
              ),
            );
          const rolesByDir = new Map<string, FleetRole[]>();
          for (const r of roles) {
            if (r.connectorName !== conn.name) continue;
            if (!rolesByDir.has(r.project)) rolesByDir.set(r.project, []);
            rolesByDir.get(r.project)!.push(r);
          }
          return (
            <div key={conn.id}>
              <div className="flex items-center gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                <ServerIcon className="w-4 h-4" />
                {conn.displayName || conn.name}
              </div>
              {dirs.length === 0 ? (
                <div className="px-4 py-3 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 italic">
                  Ask your install agent to fix this server and add project directories.
                </div>
              ) : (
                dirs.map((dir) => {
                  const dirRoles = rolesByDir.get(dir.name) || [];
                  return (
                    <div
                      key={dir.url}
                      className="border-b border-slate-100 dark:border-slate-800"
                    >
                      <a
                        href={dir.url}
                        className="flex items-start gap-2 px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                      >
                        <FolderIcon className="w-4 h-4 mt-0.5 text-slate-400" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-blue-600 dark:text-blue-400 truncate">
                            {dir.displayName || dir.name}
                          </div>
                          <div className="text-[11px] text-slate-400 dark:text-slate-500 font-mono truncate">
                            {shortPath(dir.path)}
                          </div>
                        </div>
                      </a>
                      {dirRoles.map((role) => (
                        <a
                          key={role.url}
                          href={role.url}
                          className="block pl-10 pr-4 py-1 text-[11px] text-emerald-600 dark:text-emerald-400 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                        >
                          ↳ {role.roleName}
                        </a>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
          );
        })
      )}

      {offlineConns.length > 0 && (
        <div>
          <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
            Offline
          </div>
          {offlineConns.map((c) => (
            <div
              key={c.id}
              className="px-4 py-2 text-sm text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800"
            >
              {c.displayName || c.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
