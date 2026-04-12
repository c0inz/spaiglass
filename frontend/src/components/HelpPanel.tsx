import { useState, useEffect } from "react";
import type { SessionStats } from "../types";

interface PluginInfo {
  id: string;
  name: string;
  installed: boolean;
}

interface HelpPanelProps {
  stats: SessionStats;
  slashCommands: string[];
  projectPath?: string;
  activeRole?: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function HelpPanel({ stats, slashCommands, projectPath, activeRole }: HelpPanelProps) {
  const cacheTotal = stats.cacheReadTokens + stats.cacheCreationTokens;
  const cacheHitPct =
    stats.inputTokens > 0
      ? Math.round((stats.cacheReadTokens / stats.inputTokens) * 100)
      : 0;
  const hasSessionData =
    stats.turns > 0 || stats.inputTokens > 0 || stats.outputTokens > 0;

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [rolePlugins, setRolePlugins] = useState<Record<string, boolean>>({});
  const [pluginsLoaded, setPluginsLoaded] = useState(false);

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    fetch(`/api/plugins?path=${encodeURIComponent(projectPath)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setPlugins(data.plugins || []);
        // Find plugin config for the active role
        if (activeRole && data.roles) {
          const role = (data.roles as Array<{ name: string; filename: string; plugins: Record<string, boolean> }>)
            .find((r) => r.filename === activeRole || r.name === activeRole);
          setRolePlugins(role?.plugins || {});
        }
        setPluginsLoaded(true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectPath, activeRole]);

  /** Is a plugin enabled for the current role's session? */
  const isEnabledForSession = (pluginId: string): boolean => {
    // Role frontmatter overrides take precedence
    if (pluginId in rolePlugins) return rolePlugins[pluginId];
    // Otherwise fall back to global settings
    return true; // installed plugins are enabled by default unless explicitly disabled
  };

  return (
    <div className="h-full overflow-y-auto bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-300">
      {/* Session Status */}
      <div className="p-3 border-b border-slate-200 dark:border-slate-700">
        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
          Session Status
        </div>
        {!hasSessionData && (
          <div className="text-xs italic text-slate-400 dark:text-slate-500 mb-2">
            send message to populate
          </div>
        )}
        <div className="space-y-1 font-mono text-xs">
          <div className="flex justify-between">
            <span className="text-slate-500">Model</span>
            <span className="text-slate-800 dark:text-slate-200 truncate ml-2">
              {stats.model || "\u2014"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Tokens in</span>
            <span>
              {stats.inputTokens > 0 ? formatTokens(stats.inputTokens) : "\u2014"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Tokens out</span>
            <span>
              {stats.outputTokens > 0 ? formatTokens(stats.outputTokens) : "\u2014"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Cache</span>
            <span>
              {cacheTotal > 0
                ? `${cacheHitPct}% hit \u00b7 ${formatTokens(cacheTotal)}`
                : "\u2014"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Cost</span>
            <span>
              {stats.totalCost > 0 ? `$${stats.totalCost.toFixed(4)}` : "\u2014"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Turns</span>
            <span>{stats.turns > 0 ? stats.turns : "\u2014"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Duration</span>
            <span>
              {stats.durationMs > 0
                ? `${(stats.durationMs / 1000).toFixed(1)}s`
                : "\u2014"}
            </span>
          </div>
        </div>
      </div>

      {/* Plugins */}
      <div className="p-3 border-b border-slate-200 dark:border-slate-700">
        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
          Plugins
        </div>
        {!pluginsLoaded ? (
          <div className="text-xs text-slate-400 italic">Loading...</div>
        ) : plugins.length === 0 ? (
          <div className="text-xs text-slate-400 italic">No plugins installed</div>
        ) : (
          <div className="space-y-1.5">
            {plugins.map((plugin) => {
              const enabled = isEnabledForSession(plugin.id);
              return (
                <label
                  key={plugin.id}
                  className="flex items-center gap-2 cursor-default"
                  title={`${plugin.id}\n${enabled ? "Loaded for this session" : "Not loaded for this session"}`}
                >
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled
                    className="w-3.5 h-3.5 rounded border-slate-300 dark:border-slate-600 text-blue-500 cursor-default"
                  />
                  <span className={`text-xs font-mono ${enabled ? "text-slate-700 dark:text-slate-300" : "text-slate-400 dark:text-slate-500"}`}>
                    {plugin.name}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        {/* /plugin syntax helper */}
        <div className="mt-3 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
            Plugin Commands
          </div>
          <div className="space-y-1 text-[11px] font-mono text-slate-500 dark:text-slate-400">
            <div><span className="text-blue-600 dark:text-blue-400">/plugin</span> name <span className="text-emerald-600 dark:text-emerald-400">enable</span></div>
            <div><span className="text-blue-600 dark:text-blue-400">/plugin</span> name <span className="text-red-500 dark:text-red-400">disable</span></div>
            <div><span className="text-blue-600 dark:text-blue-400">/reload-plugins</span></div>
          </div>
          <div className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">
            Changes apply to the current session. Edit role settings to persist across sessions.
          </div>
        </div>
      </div>

      {/* Slash Commands */}
      <div className="p-3 border-b border-slate-200 dark:border-slate-700">
        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
          / Commands
        </div>
        {slashCommands.length > 0 ? (
          <div className="space-y-0.5 font-mono text-xs">
            {slashCommands.map((cmd) => (
              <div key={cmd} className="text-blue-600 dark:text-blue-400">
                /{cmd}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-slate-400 italic">
            Available after first message
          </div>
        )}
      </div>

      {/* Features Reference */}
      <div className="p-3">
        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
          Features
        </div>
        <div className="space-y-2 text-xs">
          <div>
            <span className="font-mono text-blue-600 dark:text-blue-400">
              @
            </span>
            <span className="text-slate-500 ml-1.5">
              File autocomplete &mdash; type @ then filename
            </span>
          </div>
          <div>
            <span className="font-mono text-blue-600 dark:text-blue-400">
              /
            </span>
            <span className="text-slate-500 ml-1.5">
              Slash commands &mdash; type / for dropdown
            </span>
          </div>
          <div>
            <span className="text-blue-600 dark:text-blue-400">&#x1F4CE;</span>
            <span className="text-slate-500 ml-1.5">
              Upload files &mdash; paperclip button
            </span>
          </div>
          <div>
            <span className="font-mono text-blue-600 dark:text-blue-400">
              Esc
            </span>
            <span className="text-slate-500 ml-1.5">Abort running request</span>
          </div>
          <div>
            <span className="font-mono text-blue-600 dark:text-blue-400">
              Ctrl+Shift+M
            </span>
            <span className="text-slate-500 ml-1.5">Cycle permission mode</span>
          </div>
          <div>
            <span className="text-slate-500">
              Thinking level &mdash; click toggle in status bar
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
