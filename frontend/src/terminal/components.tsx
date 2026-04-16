/**
 * Phase 6.1: Core terminal component library.
 *
 * Custom React components that approximate the visual fidelity of Claude's
 * native CLI in the browser. Every Term* component renders to the DOM (no
 * Ink reconciler), uses monospace text by default, and respects the existing
 * theme system via tailwind classes from theme.ts.
 *
 * Interactive components (TermInput, TermButton, TermChoice) live at the end
 * of this file (Phase 6.4) and are wired to the MCP interactive tools via
 * the WebSocket `tool_result` round-trip protocol — see
 * `backend/mcp/interactive-tools.ts` and `useWebSocketSession.ts`.
 */

import type { ReactNode, FormEvent, MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import AnsiToHtml from "ansi-to-html";
import { type AnsiColor, colorClass, PANEL_BG } from "./theme";

/**
 * Collapse carriage-return animations (progress bars, spinners) into just
 * their final frame. For each line, anything before the last `\r` within
 * that line is overwritten, so only the final segment is kept.
 */
function collapseCarriageReturns(s: string): string {
  return s
    .split("\n")
    .map((line) => {
      const idx = line.lastIndexOf("\r");
      return idx === -1 ? line : line.slice(idx + 1);
    })
    .join("\n");
}

/**
 * Shared ansi-to-html converter. Palette tuned for dark slate panels;
 * bright variants stay readable on near-black backgrounds. `escapeXML`
 * ensures user output containing `<` or `&` is rendered verbatim, not
 * interpreted as HTML — this is the safety gate for dangerouslySetInnerHTML.
 */
const ansiConverter = new AnsiToHtml({
  fg: "#e2e8f0",
  bg: "transparent",
  newline: false,
  escapeXML: true,
  colors: {
    0: "#1e293b",
    1: "#f87171",
    2: "#4ade80",
    3: "#facc15",
    4: "#60a5fa",
    5: "#c084fc",
    6: "#22d3ee",
    7: "#e2e8f0",
    8: "#64748b",
    9: "#fca5a5",
    10: "#86efac",
    11: "#fde047",
    12: "#93c5fd",
    13: "#d8b4fe",
    14: "#67e8f9",
    15: "#f1f5f9",
  },
});

/**
 * AnsiOutput — converts a raw string of bash stdout/stderr into styled HTML.
 * CR-collapsed first, then piped through ansi-to-html with XML escaping. Safe
 * to inject because escapeXML=true means user text can never emit arbitrary
 * HTML — only the SGR-generated spans do.
 */
function AnsiOutput({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const html = useMemo(
    () => ansiConverter.toHtml(collapseCarriageReturns(text)),
    [text],
  );
  return (
    <pre
      className={className}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

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

// Braille dots — see StatusLine.tsx for rationale. All ten frames render
// at the same width in any monospace font so the adjacent label stays
// rock-steady as the spinner advances.
const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

interface TermSpinnerProps {
  label?: string;
  color?: AnsiColor;
}

export function TermSpinner({ label, color = "cyan" }: TermSpinnerProps) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      80,
    );
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className={`font-mono text-sm inline-flex items-center gap-2 ${colorClass(color)}`}
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className="inline-block text-center"
        style={{ width: "1ch" }}
      >
        {SPINNER_FRAMES[frame]}
      </span>
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
// TermCopyButton — small "copy" affordance used by code blocks and tool cards
//
// The button copies its `value` to the clipboard and flips to a "copied" label
// for ~1.5s. We use the modern `navigator.clipboard.writeText` API and silently
// no-op on failure (for example in non-secure contexts like an http:// origin)
// — the existing UI keeps working and the user can fall back to manual select.
// ---------------------------------------------------------------------------

interface TermCopyButtonProps {
  value: string;
  label?: string;
  className?: string;
}

export function TermCopyButton({
  value,
  label = "copy",
  className,
}: TermCopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the pending "copied" timer if the component unmounts mid-flash so
  // we don't call setState on an unmounted node.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function handleCopy(event: MouseEvent) {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can throw on non-secure contexts or when permissions
      // are denied. Silent — the user can still select-and-copy manually.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={
        "px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded " +
        "border border-slate-300/60 dark:border-slate-600/60 " +
        "text-slate-500 dark:text-slate-400 " +
        "hover:bg-slate-200/60 hover:text-slate-700 dark:hover:bg-slate-700/60 dark:hover:text-slate-200 " +
        "transition-colors " +
        (className ?? "")
      }
      aria-label={copied ? "Copied" : "Copy to clipboard"}
    >
      {copied ? "copied" : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// TermCodeBlock — syntax-highlighted code (Shiki integration deferred — see
// ROADMAP P6.5 open question 2; the API stays stable so adopting Shiki later
// is a drop-in replacement for the <pre> below).
// ---------------------------------------------------------------------------

interface TermCodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
}

export function TermCodeBlock({
  code,
  language,
  filename,
}: TermCodeBlockProps) {
  return (
    <div className={`font-mono text-xs rounded-md ${PANEL_BG} overflow-hidden`}>
      <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 border-b border-slate-200/70 dark:border-slate-700/70 flex items-center gap-2">
        {filename && <span className="font-medium">{filename}</span>}
        {language && filename && <span>·</span>}
        {language && <span>{language}</span>}
        <div className="ml-auto">
          <TermCopyButton value={code} />
        </div>
      </div>
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
    typeof args === "string" ? args : args ? formatArgsInline(args) : "";

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
        <div className="relative border-t border-slate-200/70 dark:border-slate-700/70 text-slate-700 dark:text-slate-300">
          <div className="absolute right-2 top-2 z-10">
            <TermCopyButton
              value={[output, errorOutput].filter(Boolean).join("\n")}
            />
          </div>
          <div className="px-3 py-2 max-h-96 overflow-y-auto">
            {output && (
              <AnsiOutput
                text={output}
                className="whitespace-pre-wrap break-words pr-14"
              />
            )}
            {errorOutput && (
              <AnsiOutput
                text={errorOutput}
                className={`whitespace-pre-wrap break-words pr-14 ${colorClass("red")}`}
              />
            )}
          </div>
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
            <div
              key={idx}
              className={`px-3 leading-snug whitespace-pre ${cls}`}
            >
              {line || "\u00A0"}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 6.4 — Interactive widgets
//
// These render the three MCP-tool-driven prompts: a (possibly masked) input,
// an Approve/Reject button pair, and a single-select choice list. They each
// take a `disabled` prop so the consumer (interpreter) can lock them out
// after submission, and an `onSubmit` callback that forwards the user's
// reply up to the WS hook for the `tool_result` round-trip.
//
// Security note for TermInput: when `secret` is true the value is held
// only in a ref while the user types, the React state stores the masked
// representation, and on submit the ref is wiped. The component re-renders
// with bullets only — the cleartext never sits in React state and never
// shows up in a devtools dump after submission.
// ---------------------------------------------------------------------------

interface TermInputProps {
  prompt: string;
  secret?: boolean;
  placeholder?: string | null;
  disabled?: boolean;
  onSubmit: (value: string) => void;
}

export function TermInput({
  prompt,
  secret,
  placeholder,
  disabled,
  onSubmit,
}: TermInputProps) {
  // For secret inputs we keep the cleartext only in a ref. The visible value
  // is a string of bullets the same length as the cleartext, stored in React
  // state for re-render. Non-secret inputs use plain state.
  const cleartextRef = useRef("");
  const [visible, setVisible] = useState("");
  const [submitted, setSubmitted] = useState(false);

  function handleChange(next: string) {
    if (secret) {
      cleartextRef.current = next;
      setVisible("\u2022".repeat(next.length));
    } else {
      cleartextRef.current = next;
      setVisible(next);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (disabled || submitted) return;
    const value = cleartextRef.current;
    // Wipe the cleartext ref before any further work so it cannot be read
    // out of memory by anything that runs synchronously after submit.
    cleartextRef.current = "";
    setSubmitted(true);
    if (secret) {
      // Replace the visible bullets so the input never re-renders with the
      // typed length after submit (could leak length to a screen reader).
      setVisible("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022");
    }
    onSubmit(value);
  }

  return (
    <div
      className={`my-2 ${PANEL_BG} border border-cyan-500/40 dark:border-cyan-400/40 rounded p-3 font-mono text-sm`}
    >
      <div className="text-[10px] uppercase tracking-[0.15em] text-cyan-600 dark:text-cyan-300 mb-2">
        {secret ? "input \u2022 secret" : "input"}
      </div>
      <div className="text-slate-800 dark:text-slate-100 mb-2 whitespace-pre-wrap">
        {prompt}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <span className="text-cyan-500 dark:text-cyan-300 select-none">
          {">"}
        </span>
        <input
          type={secret ? "password" : "text"}
          className="flex-1 bg-transparent outline-none border-b border-cyan-500/40 dark:border-cyan-400/40 focus:border-cyan-400 dark:focus:border-cyan-300 text-slate-800 dark:text-slate-100"
          value={visible}
          placeholder={placeholder ?? undefined}
          disabled={disabled || submitted}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => handleChange(e.target.value)}
        />
        <button
          type="submit"
          disabled={disabled || submitted}
          className="px-3 py-1 text-xs rounded bg-cyan-500/20 hover:bg-cyan-500/30 disabled:bg-slate-500/10 disabled:text-slate-500 text-cyan-700 dark:text-cyan-200 border border-cyan-500/40"
        >
          {submitted ? "submitted" : "submit"}
        </button>
      </form>
    </div>
  );
}

interface TermButtonProps {
  action: string;
  details?: string | null;
  disabled?: boolean;
  onApprove: () => void;
  onReject: () => void;
}

export function TermButton({
  action,
  details,
  disabled,
  onApprove,
  onReject,
}: TermButtonProps) {
  const [decision, setDecision] = useState<null | "approved" | "rejected">(
    null,
  );

  function approve() {
    if (disabled || decision) return;
    setDecision("approved");
    onApprove();
  }
  function reject() {
    if (disabled || decision) return;
    setDecision("rejected");
    onReject();
  }

  return (
    <div
      className={`my-2 ${PANEL_BG} border border-amber-500/50 dark:border-amber-400/50 rounded p-3 font-mono text-sm`}
    >
      <div className="text-[10px] uppercase tracking-[0.15em] text-amber-600 dark:text-amber-300 mb-2">
        permission required
      </div>
      <div className="text-slate-800 dark:text-slate-100 font-semibold whitespace-pre-wrap">
        {action}
      </div>
      {details && (
        <div className="mt-1 text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap">
          {details}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={approve}
          disabled={disabled || decision !== null}
          className="px-3 py-1 text-xs rounded bg-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-50 text-emerald-700 dark:text-emerald-200 border border-emerald-500/40"
        >
          {decision === "approved" ? "approved" : "approve"}
        </button>
        <button
          type="button"
          onClick={reject}
          disabled={disabled || decision !== null}
          className="px-3 py-1 text-xs rounded bg-red-500/20 hover:bg-red-500/30 disabled:opacity-50 text-red-700 dark:text-red-200 border border-red-500/40"
        >
          {decision === "rejected" ? "rejected" : "reject"}
        </button>
      </div>
    </div>
  );
}

interface TermChoiceProps {
  prompt: string;
  choices: string[];
  disabled?: boolean;
  onPick: (choice: string) => void;
}

export function TermChoice({
  prompt,
  choices,
  disabled,
  onPick,
}: TermChoiceProps) {
  const [picked, setPicked] = useState<string | null>(null);

  function pick(choice: string) {
    if (disabled || picked) return;
    setPicked(choice);
    onPick(choice);
  }

  return (
    <div
      className={`my-2 ${PANEL_BG} border border-violet-500/40 dark:border-violet-400/40 rounded p-3 font-mono text-sm`}
    >
      <div className="text-[10px] uppercase tracking-[0.15em] text-violet-600 dark:text-violet-300 mb-2">
        choose one
      </div>
      <div className="text-slate-800 dark:text-slate-100 mb-2 whitespace-pre-wrap">
        {prompt}
      </div>
      <div className="flex flex-col gap-1">
        {choices.map((choice, idx) => {
          const isPicked = picked === choice;
          return (
            <button
              key={idx}
              type="button"
              onClick={() => pick(choice)}
              disabled={disabled || picked !== null}
              className={
                "text-left px-3 py-1 rounded border text-xs " +
                (isPicked
                  ? "bg-violet-500/30 border-violet-400 text-violet-900 dark:text-violet-100"
                  : "bg-violet-500/10 hover:bg-violet-500/20 border-violet-500/30 text-slate-800 dark:text-slate-100 disabled:opacity-50")
              }
            >
              <span className="text-violet-500 dark:text-violet-300 mr-2">
                {idx + 1}.
              </span>
              {choice}
            </button>
          );
        })}
      </div>
    </div>
  );
}
