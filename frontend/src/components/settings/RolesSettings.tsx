import { useState, useEffect, useCallback } from "react";
import {
  PlusIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/outline";

interface RoleInfo {
  name: string;
  filename: string;
  path: string;
  source: "native" | "legacy";
  plugins: Record<string, boolean>;
  preview: string;
}

interface RolesSettingsProps {
  projectPath?: string;
  onRoleCreated?: () => void;
}

export function RolesSettings({ projectPath, onRoleCreated }: RolesSettingsProps) {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [globalPlugins, setGlobalPlugins] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [expandedRole, setExpandedRole] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [showNewRole, setShowNewRole] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // New role form state
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPlugins, setNewPlugins] = useState<Record<string, boolean>>({});

  const fetchRoles = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/roles?path=${encodeURIComponent(projectPath)}`);
      if (!res.ok) throw new Error("Failed to fetch roles");
      const data = await res.json();
      setRoles(data.roles || []);
      setGlobalPlugins(data.globalPlugins || {});
    } catch {
      setError("Failed to load roles");
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  // Clear messages after a delay
  useEffect(() => {
    if (successMsg) {
      const t = setTimeout(() => setSuccessMsg(null), 3000);
      return () => clearTimeout(t);
    }
  }, [successMsg]);

  const pluginIds = Object.keys(globalPlugins);

  /** Toggle a plugin for a given role and save */
  const toggleRolePlugin = async (role: RoleInfo, pluginId: string) => {
    const updatedPlugins = { ...role.plugins };
    // If not in role config, default to global value then flip
    const currentVal = pluginId in updatedPlugins
      ? updatedPlugins[pluginId]
      : (globalPlugins[pluginId] ?? true);
    updatedPlugins[pluginId] = !currentVal;

    setSaving(role.filename);
    setError(null);
    try {
      const res = await fetch(
        `/api/roles/${encodeURIComponent(role.filename)}?path=${encodeURIComponent(projectPath!)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plugins: updatedPlugins }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update role");
      }
      // Update local state
      setRoles((prev) =>
        prev.map((r) =>
          r.filename === role.filename ? { ...r, plugins: updatedPlugins } : r,
        ),
      );
      setSuccessMsg(`Updated ${role.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(null);
    }
  };

  /** Create a new role */
  const createRole = async () => {
    if (!projectPath || !newName.trim() || !newDescription.trim()) return;

    setSaving("new");
    setError(null);
    try {
      const res = await fetch(
        `/api/roles?path=${encodeURIComponent(projectPath)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newName.trim(),
            description: newDescription.trim(),
            plugins: Object.keys(newPlugins).length > 0 ? newPlugins : undefined,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create role");

      // Add to list
      if (data.role) {
        setRoles((prev) => [...prev, data.role]);
      }
      setSuccessMsg(`Created role: ${newName.trim()}`);
      setNewName("");
      setNewDescription("");
      setNewPlugins({});
      setShowNewRole(false);
      onRoleCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create role");
    } finally {
      setSaving(null);
    }
  };

  /** Get effective plugin state for a role */
  const getPluginState = (role: RoleInfo, pluginId: string): boolean => {
    if (pluginId in role.plugins) return role.plugins[pluginId];
    return globalPlugins[pluginId] ?? true;
  };

  if (!projectPath) {
    return (
      <div className="text-sm text-slate-400 italic p-2">
        Select a project to manage roles
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Status messages */}
      {error && (
        <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      {successMsg && (
        <div className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg px-3 py-2">
          {successMsg}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-slate-400 italic">Loading roles...</div>
      ) : roles.length === 0 && !showNewRole ? (
        <div className="text-sm text-slate-400 italic">
          No roles found. Create one to get started.
        </div>
      ) : (
        <div className="space-y-2">
          {roles.map((role) => {
            const isExpanded = expandedRole === role.filename;
            const isSaving = saving === role.filename;
            return (
              <div
                key={role.filename}
                className="border border-slate-200 dark:border-slate-600 rounded-lg overflow-hidden"
              >
                {/* Role header */}
                <button
                  onClick={() =>
                    setExpandedRole(isExpanded ? null : role.filename)
                  }
                  className="w-full flex items-center gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-700/50 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors text-left"
                >
                  {isExpanded ? (
                    <ChevronDownIcon className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  ) : (
                    <ChevronRightIcon className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 dark:text-slate-100 capitalize">
                      {role.name}
                    </div>
                    <div className="text-xs text-slate-400 dark:text-slate-500 font-mono truncate">
                      {role.filename}
                      <span className="ml-2 text-slate-300 dark:text-slate-600">
                        {role.source === "native" ? ".claude/agents/" : "agents/"}
                      </span>
                    </div>
                  </div>
                  {isSaving && (
                    <span className="text-xs text-blue-500 animate-pulse">
                      Saving...
                    </span>
                  )}
                </button>

                {/* Expanded: plugin list */}
                {isExpanded && (
                  <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800">
                    {/* Preview */}
                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-3 line-clamp-2">
                      {role.preview || "No description"}
                    </div>

                    {pluginIds.length === 0 ? (
                      <div className="text-xs text-slate-400 italic">
                        No plugins installed
                      </div>
                    ) : (
                      <>
                        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                          Plugins
                        </div>
                        <div className="space-y-1.5">
                          {pluginIds.map((pluginId) => {
                            const enabled = getPluginState(role, pluginId);
                            const pluginName = pluginId
                              .split("@")[0]
                              .replace(/[-_]/g, " ");
                            const isOverridden = pluginId in role.plugins;
                            return (
                              <label
                                key={pluginId}
                                className="flex items-center gap-2 cursor-pointer group"
                              >
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  onChange={() => toggleRolePlugin(role, pluginId)}
                                  disabled={isSaving}
                                  className="w-3.5 h-3.5 rounded border-slate-300 dark:border-slate-600 text-blue-500 cursor-pointer disabled:opacity-50"
                                />
                                <span
                                  className={`text-xs font-mono ${
                                    enabled
                                      ? "text-slate-700 dark:text-slate-300"
                                      : "text-slate-400 dark:text-slate-500"
                                  }`}
                                >
                                  {pluginName}
                                </span>
                                {isOverridden && (
                                  <span className="text-[10px] text-blue-500 dark:text-blue-400">
                                    (role override)
                                  </span>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      </>
                    )}

                    <div className="mt-3 text-[10px] text-slate-400 dark:text-slate-500">
                      Changes saved to role frontmatter. Takes effect on next
                      session start.
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* New Role Form */}
      {showNewRole ? (
        <div className="border border-blue-200 dark:border-blue-700 rounded-lg p-4 bg-blue-50/50 dark:bg-blue-900/10 space-y-3">
          <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
            New Role
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600 dark:text-slate-400 block mb-1">
              Name
            </label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. researcher"
              className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="mt-1 text-[10px] text-slate-400">
              Creates <code>.claude/agents/{newName ? newName.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") : "name"}.md</code>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600 dark:text-slate-400 block mb-1">
              Role Description
            </label>
            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="You are a researcher focused on..."
              rows={4}
              className="w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          {pluginIds.length > 0 && (
            <div>
              <label className="text-xs font-medium text-slate-600 dark:text-slate-400 block mb-1.5">
                Plugins
              </label>
              <div className="space-y-1.5">
                {pluginIds.map((pluginId) => {
                  const pluginName = pluginId
                    .split("@")[0]
                    .replace(/[-_]/g, " ");
                  const checked = newPlugins[pluginId] ?? (globalPlugins[pluginId] ?? true);
                  return (
                    <label
                      key={pluginId}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setNewPlugins((prev) => ({
                            ...prev,
                            [pluginId]: !checked,
                          }))
                        }
                        className="w-3.5 h-3.5 rounded border-slate-300 dark:border-slate-600 text-blue-500 cursor-pointer"
                      />
                      <span className="text-xs font-mono text-slate-700 dark:text-slate-300">
                        {pluginName}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={createRole}
              disabled={!newName.trim() || !newDescription.trim() || saving === "new"}
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving === "new" ? "Creating..." : "Create Role"}
            </button>
            <button
              onClick={() => {
                setShowNewRole(false);
                setNewName("");
                setNewDescription("");
                setNewPlugins({});
              }}
              className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowNewRole(true)}
          className="flex items-center gap-2 px-4 py-2.5 w-full text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg transition-colors"
        >
          <PlusIcon className="w-4 h-4" />
          Add Role
        </button>
      )}
    </div>
  );
}
