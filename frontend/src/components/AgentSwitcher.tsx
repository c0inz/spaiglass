/**
 * AgentSwitcher — header middle section showing recent agents + fleet picker.
 *
 * Desktop: shows up to 5 recent agent buttons + a "Fleet" dropdown.
 * Mobile: rendered as a full-page list when the Agents tab is active.
 */

import { useState, useRef, useEffect } from "react";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import type {
  RecentAgent,
  FleetRole,
  FleetConnector,
} from "../hooks/useFleetAgents";

interface AgentSwitcherProps {
  recentAgents: RecentAgent[];
  roles: FleetRole[];
  connectors: FleetConnector[];
  loading: boolean;
  isRelay: boolean;
  currentUrl?: string;
}

/** Strip /home/{user}/ prefix — just noise in the dropdown */
function shortPath(p: string): string {
  return p.replace(/^\/home\/[^/]+\//, "~/");
}

/** Compact label: "proj-role" truncated to fit */
function compactLabel(label: string, max = 12): string {
  if (label.length <= max) return label;
  return label.slice(0, max - 1) + "\u2026";
}

export function AgentSwitcher({
  recentAgents,
  roles,
  connectors,
  loading,
  isRelay,
  currentUrl,
}: AgentSwitcherProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showDropdown]);

  if (!isRelay) return null;

  // Group roles by connector for the dropdown
  const rolesByConnector = new Map<string, FleetRole[]>();
  for (const role of roles) {
    const key = role.connectorDisplayName || role.connectorName;
    if (!rolesByConnector.has(key)) rolesByConnector.set(key, []);
    rolesByConnector.get(key)!.push(role);
  }

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {/* Recent agent buttons */}
      {recentAgents.map((agent) => {
        const isCurrent = currentUrl && agent.url === currentUrl;
        return (
          <a
            key={agent.url}
            href={agent.url}
            className={`px-2 py-1 text-xs font-medium rounded-md border transition-all duration-150 whitespace-nowrap ${
              isCurrent
                ? "bg-amber-100 dark:bg-amber-900/40 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300"
                : "bg-white/80 dark:bg-slate-800/80 border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 hover:border-slate-300 dark:hover:border-slate-500"
            }`}
            title={`${agent.connectorName}: ${agent.project}/${agent.role}`}
          >
            {compactLabel(agent.label)}
          </a>
        );
      })}

      {/* Fleet dropdown */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md border bg-white/80 dark:bg-slate-800/80 border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 transition-all duration-150"
        >
          Fleet
          <ChevronDownIcon className="w-3 h-3" />
        </button>

        {showDropdown && (
          <div className="absolute top-full right-0 mt-1 w-80 max-h-[28rem] overflow-auto bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl z-50">
            {loading ? (
              <div className="p-3 text-xs text-slate-400 text-center">
                Loading fleet...
              </div>
            ) : roles.length === 0 ? (
              <div className="p-3 text-xs text-slate-400 text-center">
                No agents found
              </div>
            ) : (
              roles.map((role) => {
                const isCurrent = currentUrl && role.url === currentUrl;
                return (
                  <a
                    key={role.url}
                    href={role.url}
                    className={`block px-3 py-1.5 transition-colors border-b border-slate-100 dark:border-slate-800 ${
                      isCurrent
                        ? "bg-amber-50 dark:bg-amber-900/30"
                        : "hover:bg-slate-50 dark:hover:bg-slate-700/50"
                    }`}
                    onClick={() => setShowDropdown(false)}
                  >
                    <div className="text-sm">
                      <span className="font-bold text-blue-500 dark:text-blue-400">{role.project}</span>
                      <span className="inline-block w-[5ch]" />
                      <span className="text-[11px] text-emerald-500 dark:text-emerald-400">{role.roleName}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 dark:text-slate-500">
                      {shortPath(role.projectPath)}
                    </div>
                  </a>
                );
              })
            )}
            {/* Offline connectors */}
            {connectors.filter((c) => !c.online).length > 0 && (
              <div className="border-t border-slate-200 dark:border-slate-700">
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Offline
                </div>
                {connectors
                  .filter((c) => !c.online)
                  .map((c) => (
                    <div
                      key={c.id}
                      className="px-3 py-1.5 text-sm text-slate-400 dark:text-slate-500"
                    >
                      {c.displayName}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * AgentPickerFullPage — full-page fleet agent list for mobile.
 */
export function AgentPickerFullPage({
  recentAgents,
  roles,
  connectors,
  loading,
}: {
  recentAgents: RecentAgent[];
  roles: FleetRole[];
  connectors: FleetConnector[];
  loading: boolean;
}) {
  return (
    <div className="flex-1 overflow-auto bg-white dark:bg-slate-900">
      {/* Recent section */}
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

      {/* All agents — flat list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-sm text-slate-400">Loading fleet...</div>
        </div>
      ) : (
        <div>
          <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
            All Agents
          </div>
          {roles.map((role) => (
            <a
              key={role.url}
              href={role.url}
              className="block px-4 py-2 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
            >
              <div className="text-sm">
                <span className="font-bold text-blue-500 dark:text-blue-400">{role.project}</span>
                <span className="inline-block w-[5ch]" />
                <span className="text-[11px] text-emerald-500 dark:text-emerald-400">{role.roleName}</span>
              </div>
              <div className="text-[11px] text-slate-400 dark:text-slate-500">
                {shortPath(role.projectPath)}
              </div>
            </a>
          ))}
        </div>
      )}

      {/* Offline connectors */}
      {connectors.filter((c) => !c.online).length > 0 && (
        <div>
          <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
            Offline
          </div>
          {connectors
            .filter((c) => !c.online)
            .map((c) => (
              <div
                key={c.id}
                className="px-4 py-2 text-sm text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800"
              >
                {c.displayName}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
