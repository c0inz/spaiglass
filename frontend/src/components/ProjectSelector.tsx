import { useState, useEffect, useMemo } from "react";
import { FolderIcon, ServerIcon } from "@heroicons/react/24/outline";
import type { ProjectsResponse, ProjectInfo } from "../types";
import { getProjectsUrl } from "../config/api";
import { SettingsButton } from "./SettingsButton";
import { Brand } from "./Brand";
import { SettingsModal } from "./SettingsModal";
import { useFleetAgents } from "../hooks/useFleetAgents";

/**
 * Server + Directory landing page.
 *
 * - Server dropdown lists all connectors the user owns/shares (from /api/__relay/fleet).
 *   Switching servers navigates to /vm/<login>.<otherconnector>/ so the VM-scoped
 *   fetches refire against the new host.
 * - Directory list comes from /api/projects on the current VM (Claude Code's own
 *   project registry — the directories the user has actually used).
 * - Picking a directory navigates to /vm/<slug>/<basename>/ — role-less. Legacy
 *   <project>-<role>/ URLs still work; this flow just stops requiring a role.
 */
export function ProjectSelector() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const fleet = useFleetAgents();

  // Current connector slug parsed from __SG (relay injects this)
  const currentSlug = useMemo(() => {
    const sg = (window as Window & { __SG?: { slug?: string } }).__SG;
    return sg?.slug || null;
  }, []);

  const currentConnector = useMemo(() => {
    if (!currentSlug) return null;
    // __SG.slug is "<login>.<connector>"; the fleet API returns bare connector name
    const connectorName = currentSlug.includes(".")
      ? currentSlug.split(".").slice(1).join(".")
      : currentSlug;
    return fleet.connectors.find((c) => c.name === connectorName) || null;
  }, [currentSlug, fleet.connectors]);

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    try {
      setLoading(true);
      const response = await fetch(getProjectsUrl());
      if (!response.ok) {
        throw new Error(`Failed to load directories: ${response.statusText}`);
      }
      const data: ProjectsResponse = await response.json();
      setProjects(data.projects);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load directories",
      );
    } finally {
      setLoading(false);
    }
  };

  const handleDirectorySelect = (projectPath: string) => {
    const basename = projectPath.split("/").filter(Boolean).pop() || "";
    if (!basename) return;
    // Full-page nav (not react-router navigate) so the relay re-injects
    // window.__SG with the new basename. Client-side routing leaves __SG.project
    // empty, which makes RoleResolver skip path resolution and ChatPage fall
    // back to the URL as its working directory — file tree then fails to load.
    //
    // Auto-resume: no `?new=1`. User feedback 2026-04-23 — "you should be
    // loading my last session automatically" / "all creating new sessions".
    // ChatPage will call /api/session/last on mount and resume the prior
    // session for this directory if one exists.
    const base = (window as Window & { __SG_BASE?: string }).__SG_BASE || "";
    window.location.href = `${base}/${basename}/`;
  };

  const handleServerChange = (ev: React.ChangeEvent<HTMLSelectElement>) => {
    const newConnectorName = ev.target.value;
    if (!newConnectorName || !currentSlug) return;
    const login = currentSlug.split(".")[0];
    // Jump to the other connector's root. Full-page nav — not a router push —
    // so __SG re-injects against the new slug and /api/* proxies to the new VM.
    window.location.href = `/vm/${login}.${newConnectorName}/`;
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 transition-colors duration-300">
      <div className="max-w-4xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              <Brand className="text-slate-800 dark:text-slate-100" />
            </h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
              Pick a server and a directory to get started
            </p>
          </div>
          <SettingsButton onClick={() => setIsSettingsOpen(true)} />
        </div>

        {/* Server dropdown */}
        <div className="mb-6 bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg p-4 backdrop-blur-sm">
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">
            <ServerIcon className="h-4 w-4" />
            Server
          </label>
          {fleet.loading && fleet.connectors.length === 0 ? (
            <div className="text-sm text-slate-400">Loading servers...</div>
          ) : fleet.connectors.length === 0 ? (
            <div className="text-sm text-slate-400">
              No servers registered. Visit <code>/setup</code> to add one.
            </div>
          ) : (
            <select
              value={currentConnector?.name || ""}
              onChange={handleServerChange}
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md text-sm text-slate-800 dark:text-slate-100 font-mono"
            >
              {fleet.connectors.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.displayName || c.name}
                  {!c.online && " (offline)"}
                  {c.role !== "owner" && ` [${c.role}]`}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Directory list */}
        <div className="bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg p-4 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-3">
            <FolderIcon className="h-4 w-4" />
            Directory
          </div>
          {loading ? (
            <div className="text-sm text-slate-400 py-2">
              Loading directories...
            </div>
          ) : error ? (
            <div className="text-sm text-red-600 dark:text-red-400 py-2">
              {error}
            </div>
          ) : projects.length === 0 ? (
            <div className="text-sm py-3 px-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-800">
              Ask your install agent to fix this server and add project
              directories.
            </div>
          ) : (
            <div className="space-y-2">
              {projects.map((project) => (
                <button
                  key={project.path}
                  onClick={() => handleDirectorySelect(project.path)}
                  className="w-full flex items-center gap-3 p-3 bg-white dark:bg-slate-900/50 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 border border-slate-200 dark:border-slate-700 rounded-lg transition-all duration-150 text-left"
                >
                  <FolderIcon className="h-5 w-5 text-slate-500 dark:text-slate-400 flex-shrink-0" />
                  <span className="text-slate-800 dark:text-slate-200 font-mono text-sm truncate">
                    {project.path}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
        />
      </div>
    </div>
  );
}
