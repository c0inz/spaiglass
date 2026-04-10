/**
 * Phase 6.1: Core terminal component library.
 *
 * Custom React components that approximate the visual fidelity of Claude's
 * native CLI in the browser. Every Term* component renders to the DOM (no
 * Ink reconciler), uses monospace text by default, and respects the existing
 * theme system via tailwind classes from theme.ts.
 *
 * Interactive components (TermInput, TermButton, TermChoice) are deferred
 * to Phase 6.4 because they depend on the MCP-tool feasibility spike (6.0).
 */

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { type AnsiColor, colorClass, PANEL_BG } from "./theme";

// ---------------------------------------------------------------------------
// TermBox — flexbox container with optional ASCII border
// ---------------------------------------------------------------------------

interface TermBoxProps {
  children?: ReactNode;
  border?: boolean;
  title?: string;
  className?: string;
}

export function TermBox({ children, border, title, className }: TermBoxProps) {
  if (!border) {
    return (
      <div className={`font-mono text-sm ${className ?? ""}`}>{children}</div>
    );
  }
  return (
    <div
      className={`font-mono text-sm rounded-md ${PANEL_BG} px-3 py-2 ${className ?? ""}`}
    >
      {title && (
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TermText — colored monospace text
// ---------------------------------------------------------------------------

interface TermTextProps {
  children?: ReactNode;
  color?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  className?: string;
}

export function TermText({
  children,
  color,
  bold,
  dim,
  italic,
  className,
}: TermTextProps) {
  const classes = [
    "font-mono",
    colorClass(color),
    bold && "font-semibold",
    dim && "opacity-60",
    italic && "italic",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <span className={classes}>{children}</span>;
}

// ---------------------------------------------------------------------------
// TermSpinner — animated frame cycle (used during stream_thinking)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface TermSpinnerProps {
  label?: string;
  color?: AnsiColor;
}

export function TermSpinner({ label, color = "cyan" }: TermSpinnerProps) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className={`font-mono text-sm inline-flex items-center gap-2 ${colorClass(color)}`}
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true">{SPINNER_FRAMES[frame]}</span>
      {label && <span>{label}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TermProgressBar — long-running operation progress
// ---------------------------------------------------------------------------

interface TermProgressBarProps {
  value: number; // 0..1
  label?: string;
  width?: number; // character cells
  color?: AnsiColor;
}

export function TermProgressBar({
  value,
  label,
  width = 24,
  color = "green",
}: TermProgressBarProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return (
    <div className="font-mono text-sm flex items-center gap-2">
      <span className={colorClass(color)}>
        [{"█".repeat(filled)}
        <span className="opacity-30">{"░".repeat(empty)}</span>]
      </span>
      <span className="text-slate-500 dark:text-slate-400 tabular-nums">
        {Math.round(clamped * 100)}%
      </span>
      {label && (
        <span className="text-slate-600 dark:text-slate-300">{label}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TermChecklist — TodoWrite renderer
// ---------------------------------------------------------------------------

export interface TermChecklistItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

interface TermChecklistProps {
  items: TermChecklistItem[];
  title?: string;
}

export function TermChecklist({ items, title }: TermChecklistProps) {
  const completed = items.filter((i) => i.status === "completed").length;
  return (
    <TermBox border title={title ?? `Tasks (${completed}/${items.length})`}>
      <ul className="space-y-0.5">
        {items.map((item, idx) => {
          const marker =
            item.status === "completed"
              ? "✓"
              : item.status === "in_progress"
                ? "⊙"
                : "○";
          const colorCls =
            item.status === "completed"
              ? colorClass("green")
              : item.status === "in_progress"
                ? colorClass("cyan")
                : colorClass("gray");
          const lineCls =
            item.status === "completed"
              ? "line-through opacity-60"
              : item.status === "in_progress"
                ? "font-medium"
                : "";
          return (
            <li key={idx} className="flex items-start gap-2">
              <span className={`${colorCls} flex-shrink-0`} aria-hidden="true">
                {marker}
              </span>
              <span className={`flex-1 ${lineCls}`}>
                {item.status === "in_progress" && item.activeForm
                  ? item.activeForm
                  : item.content}
              </span>
            </li>
          );
        })}
      </ul>
    </TermBox>
  );
}

// ---------------------------------------------------------------------------
// TermCodeBlock — syntax-highlighted code (Shiki deferred to 6.5 polish)
// ---------------------------------------------------------------------------

interface TermCodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
}

export function TermCodeBlock({ code, language, filename }: TermCodeBlockProps) {
  // 6.1 ships a plain monospace renderer with language/filename header.
  // 6.5 polish swaps in Shiki for proper syntax highlighting — the API of
  // this component will not change so callers don't need to be updated.
  const header = filename || language;
  return (
    <div className={`font-mono text-xs rounded-md ${PANEL_BG} overflow-hidden`}>
      {header && (
        <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 border-b border-slate-200/70 dark:border-slate-700/70 flex items-center gap-2">
          {filename && <span className="font-medium">{filename}</span>}
          {language && filename && <span>·</span>}
          {language && <span>{language}</span>}
        </div>
      )}
      <pre className="px-3 py-2 overflow-x-auto whitespace-pre text-slate-800 dark:text-slate-200">
        {code}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TermToolCard — bash command + output, file ops, search results
// ---------------------------------------------------------------------------

interface TermToolCardProps {
  tool: string;
  args?: Record<string, unknown> | string;
  status?: "running" | "ok" | "error";
  output?: string;
  errorOutput?: string;
  collapsed?: boolean;
  onToggle?: () => void;
}

export function TermToolCard({
  tool,
  args,
  status = "ok",
  output,
  errorOutput,
  collapsed,
  onToggle,
}: TermToolCardProps) {
  const statusGlyph =
    status === "running" ? "⏵" : status === "error" ? "✗" : "✓";
  const statusColor: AnsiColor =
    status === "running" ? "cyan" : status === "error" ? "red" : "green";

  const argSummary =
    typeof args === "string"
      ? args
      : args
        ? formatArgsInline(args)
        : "";

  return (
    <div className={`font-mono text-xs rounded-md ${PANEL_BG} overflow-hidden`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-slate-100/60 dark:hover:bg-slate-700/40 transition-colors"
        aria-expanded={!collapsed}
      >
        {status === "running" ? (
          <TermSpinner color={statusColor} />
        ) : (
          <span className={colorClass(statusColor)} aria-hidden="true">
            {statusGlyph}
          </span>
        )}
        <span className="font-semibold text-slate-700 dark:text-slate-200">
          {tool}
        </span>
        {argSummary && (
          <span className="text-slate-500 dark:text-slate-400 truncate flex-1">
            {argSummary}
          </span>
        )}
      </button>
      {!collapsed && (output || errorOutput) && (
        <div className="px-3 py-2 border-t border-slate-200/70 dark:border-slate-700/70 text-slate-700 dark:text-slate-300 max-h-96 overflow-y-auto">
          {output && (
            <pre className="whitespace-pre-wrap break-words">{output}</pre>
          )}
          {errorOutput && (
            <pre className={`whitespace-pre-wrap break-words ${colorClass("red")}`}>
              {errorOutput}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function formatArgsInline(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    const s =
      typeof v === "string"
        ? v
        : typeof v === "number" || typeof v === "boolean"
          ? String(v)
          : JSON.stringify(v);
    parts.push(s.length > 80 ? `${k}=${s.slice(0, 80)}…` : `${k}=${s}`);
    if (parts.join(" ").length > 120) break;
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// TermTable — ASCII grid renderer
// ---------------------------------------------------------------------------

interface TermTableProps {
  headers?: string[];
  rows: (string | number)[][];
  align?: ("left" | "right" | "center")[];
}

export function TermTable({ headers, rows, align }: TermTableProps) {
  return (
    <div className={`font-mono text-xs rounded-md ${PANEL_BG} overflow-x-auto`}>
      <table className="w-full">
        {headers && (
          <thead>
            <tr className="border-b border-slate-200/70 dark:border-slate-700/70">
              {headers.map((h, i) => (
                <th
                  key={i}
                  className={`px-3 py-1.5 text-${align?.[i] ?? "left"} font-semibold text-slate-700 dark:text-slate-200`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              className="border-b border-slate-100/60 dark:border-slate-800/60 last:border-b-0"
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={`px-3 py-1 text-${align?.[ci] ?? "left"} text-slate-700 dark:text-slate-300 tabular-nums`}
                >
                  {String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TermDiff — unified diff renderer for write_file events
// ---------------------------------------------------------------------------

interface TermDiffProps {
  /** Pre-formatted unified diff (one line per row). If you have raw before/after, format upstream. */
  diff: string;
  filename?: string;
}

export function TermDiff({ diff, filename }: TermDiffProps) {
  const lines = diff.split("\n");
  return (
    <div className={`font-mono text-xs rounded-md ${PANEL_BG} overflow-hidden`}>
      {filename && (
        <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 border-b border-slate-200/70 dark:border-slate-700/70">
          {filename}
        </div>
      )}
      <div className="overflow-x-auto">
        {lines.map((line, idx) => {
          const isAdd = line.startsWith("+") && !line.startsWith("+++");
          const isDel = line.startsWith("-") && !line.startsWith("---");
          const isHunk = line.startsWith("@@");
          const cls = isAdd
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : isDel
              ? "bg-red-500/10 text-red-700 dark:text-red-300"
              : isHunk
                ? "bg-slate-500/10 text-slate-500 dark:text-slate-400"
                : "text-slate-700 dark:text-slate-300";
          return (
            <div key={idx} className={`px-3 leading-snug whitespace-pre ${cls}`}>
              {line || "\u00A0"}
            </div>
          );
        })}
      </div>
    </div>
  );
}
