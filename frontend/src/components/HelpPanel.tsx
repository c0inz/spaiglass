import type { SessionStats } from "../types";

interface HelpPanelProps {
  stats: SessionStats;
  slashCommands: string[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function HelpPanel({ stats, slashCommands }: HelpPanelProps) {
  const cacheTotal = stats.cacheReadTokens + stats.cacheCreationTokens;
  const cacheHitPct =
    stats.inputTokens > 0
      ? Math.round((stats.cacheReadTokens / stats.inputTokens) * 100)
      : 0;
  const hasSessionData =
    stats.turns > 0 || stats.inputTokens > 0 || stats.outputTokens > 0;

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
            <span className="text-slate-500">🤖 Model</span>
            <span className="text-slate-800 dark:text-slate-200 truncate ml-2">
              {stats.model || "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">📥 Tokens in</span>
            <span>
              {stats.inputTokens > 0 ? formatTokens(stats.inputTokens) : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">📤 Tokens out</span>
            <span>
              {stats.outputTokens > 0 ? formatTokens(stats.outputTokens) : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">💾 Cache</span>
            <span>
              {cacheTotal > 0
                ? `${cacheHitPct}% hit · ${formatTokens(cacheTotal)}`
                : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">💰 Cost</span>
            <span>
              {stats.totalCost > 0 ? `$${stats.totalCost.toFixed(4)}` : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">🔄 Turns</span>
            <span>{stats.turns > 0 ? stats.turns : "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">⏱️ Duration</span>
            <span>
              {stats.durationMs > 0
                ? `${(stats.durationMs / 1000).toFixed(1)}s`
                : "—"}
            </span>
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
              File autocomplete — type @ then filename
            </span>
          </div>
          <div>
            <span className="font-mono text-blue-600 dark:text-blue-400">
              /
            </span>
            <span className="text-slate-500 ml-1.5">
              Slash commands — type / for dropdown
            </span>
          </div>
          <div>
            <span className="text-blue-600 dark:text-blue-400">&#x1F4CE;</span>
            <span className="text-slate-500 ml-1.5">
              Upload files — paperclip button
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
              Thinking level — click toggle in status bar
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
