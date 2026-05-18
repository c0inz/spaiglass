/**
 * SessionStatusBar — small mono-font status line that sits in the chat
 * header, mirroring the Claude-CLI status-line script:
 *
 *   <model> · git:<branch> · think:<budget> · style:<name>
 *
 * Data source is the session reducer's `session` snapshot (populated from
 * the session_init frame, which the backend now augments with gitBranch,
 * outputStyle, and resolvedThinking — the actual SDK thinking config the
 * backend spawned with after resolving the user's UI choice or the VM's
 * ~/.claude/settings.json baseline when thinkingLevel="auto").
 *
 * Renders nothing until session_init has landed (avoids flickering empty
 * segments during the first ~50 ms of session-start).
 */

import type { SessionSnapshot } from "../terminal/frames/state";

interface SessionStatusBarProps {
  session: SessionSnapshot;
  /** Hide on tiny viewports — it's purely informational. */
  hidden?: boolean;
}

function shortModel(model: string | null): string | null {
  if (!model) return null;
  // Examples: "claude-opus-4-7-20250101" → "opus-4-7";
  // pass through "Opus 4.7 (1M context)" verbatim.
  const match = model.match(/^claude-([a-z0-9-]+?)(?:-\d{8})?$/i);
  if (match) return match[1];
  return model.length > 30 ? model.slice(0, 27) + "…" : model;
}

function formatThinking(
  rt: SessionSnapshot["resolvedThinking"],
): string | null {
  if (!rt) return null;
  if (rt.type === "disabled") return "think:off";
  if (rt.type === "adaptive") return "think:adaptive";
  if (rt.type === "enabled") {
    if (typeof rt.budgetTokens === "number" && rt.budgetTokens > 0) {
      return `think:${Math.round(rt.budgetTokens / 1000)}k`;
    }
    return "think:on";
  }
  return null;
}

export function SessionStatusBar({ session, hidden }: SessionStatusBarProps) {
  if (hidden) return null;
  if (!session.attached) return null;

  const model = shortModel(session.model);
  const branch = session.gitBranch || null;
  const think = formatThinking(session.resolvedThinking);
  const style =
    session.outputStyle && session.outputStyle !== "default"
      ? session.outputStyle
      : null;

  const parts: string[] = [];
  if (model) parts.push(model);
  if (branch) parts.push(`git:${branch}`);
  if (think) parts.push(think);
  if (style) parts.push(`style:${style}`);

  if (parts.length === 0) return null;

  return (
    <div
      className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 truncate"
      title="Live session config — mirrors `~/.claude/statusline.sh`"
    >
      {parts.join(" · ")}
    </div>
  );
}
