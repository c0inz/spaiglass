/**
 * markdown-widgets.tsx — the extra interactive and visual building blocks
 * that are slotted into `ReactMarkdown` via the `components` override map
 * inside `interpreter.tsx`.
 *
 * All of these are rendered _inside_ an assistant chat message, so they
 * need to stand on their own without an ambient chat store. Anything that
 * needs to send a follow-up user message (secret input, confirm, choice)
 * calls an `onSubmitText` callback that ChatPage threads down through the
 * render options — see ChatPage.tsx where `sendMessage(...)` is wired in.
 *
 * Intent-fenced code blocks:
 *
 *   ```secret-input                ```choice                ```confirm
 *   Prompt text                    Prompt: Pick one         Prompt: Are you sure?
 *   ```                            - option-a
 *                                  - option-b
 *                                  - option-c
 *                                  ```
 *
 * Plus: ```mermaid  → lazy-loaded diagram
 *       ```diff     → routed to TermDiff
 *       everything else → styled <pre> with copy button + language badge
 *
 * SPAIGLASS_WIDGETS.md (in the repo root) documents the syntax for Claude.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TermDiff } from "./components";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull plain text out of react-markdown's code-block children. */
export function extractCodeText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractCodeText).join("");
  if (children && typeof children === "object" && "props" in children) {
    // @ts-expect-error — ReactNode shape narrowed at runtime
    return extractCodeText(children.props.children);
  }
  return "";
}

// ---------------------------------------------------------------------------
// CodeBlockWithToolbar — the default <pre> override
// ---------------------------------------------------------------------------

interface CodeBlockWithToolbarProps {
  language: string | null;
  children: ReactNode;
  /** The raw source (already extracted) — used for the copy button. */
  raw: string;
}

export function CodeBlockWithToolbar({
  language,
  children,
  raw,
}: CodeBlockWithToolbarProps) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    navigator.clipboard
      .writeText(raw)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }, [raw]);

  return (
    <div className="relative my-2 group">
      <div className="absolute top-0 right-0 flex items-center gap-1 text-[10px] font-mono uppercase tracking-wide opacity-70 group-hover:opacity-100 transition-opacity">
        {language && (
          <span className="px-2 py-0.5 bg-slate-800/80 text-slate-300 border border-slate-700 border-t-0 border-r-0 rounded-bl-md">
            {language}
          </span>
        )}
        <button
          type="button"
          onClick={onCopy}
          className="px-2 py-0.5 bg-slate-800/80 text-slate-300 hover:text-emerald-300 border border-slate-700 border-t-0 border-r-0 rounded-bl-md"
          title="Copy to clipboard"
        >
          {copied ? "✓ copied" : "copy"}
        </button>
      </div>
      <pre className="p-3 pt-6 rounded-md bg-slate-900/80 border border-slate-700 overflow-x-auto text-xs leading-snug">
        {children}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiffCodeBlock — ```diff markdown block → TermDiff component
// ---------------------------------------------------------------------------

export function DiffCodeBlock({ raw }: { raw: string }) {
  return (
    <div className="my-2">
      <TermDiff diff={raw} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SecretInputWidget — ```secret-input markdown block
// ---------------------------------------------------------------------------

interface WidgetSubmitProps {
  onSubmitText?: (text: string) => void;
}

export function SecretInputWidget({
  prompt,
  onSubmitText,
}: { prompt: string } & WidgetSubmitProps) {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const id = useId();

  const handleSubmit = () => {
    if (!value.trim()) return;
    setSubmitted(true);
    onSubmitText?.(value);
    // Wipe the local copy as soon as we hand it off, so it cannot be
    // recovered via react-devtools or by clicking back into the widget.
    setValue("");
  };

  if (submitted) {
    return (
      <div className="my-2 p-3 border border-emerald-500/40 rounded-md bg-emerald-950/20 text-emerald-300 font-mono text-xs">
        ✓ secret submitted to claude (not shown in transcript)
      </div>
    );
  }

  return (
    <div className="my-2 p-3 border border-amber-500/50 rounded-md bg-amber-950/20 font-mono text-xs">
      <div className="flex items-center gap-2 mb-2 text-amber-300">
        <span aria-hidden="true">🔒</span>
        <label htmlFor={id} className="font-semibold">
          {prompt || "Paste secret key"}
        </label>
      </div>
      <div className="flex gap-2">
        <input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="paste here…"
          className="flex-1 min-w-0 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-400"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!value.trim()}
          className="px-3 py-1 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded transition-colors"
        >
          send
        </button>
      </div>
      <div className="mt-1 text-[10px] text-slate-500">
        value is masked while typing and wiped from memory after send
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChoiceWidget — ```choice markdown block
// ---------------------------------------------------------------------------

export function ChoiceWidget({
  prompt,
  options,
  onSubmitText,
}: { prompt: string; options: string[] } & WidgetSubmitProps) {
  const [picked, setPicked] = useState<string | null>(null);

  if (picked) {
    return (
      <div className="my-2 p-3 border border-cyan-500/40 rounded-md bg-cyan-950/20 text-cyan-300 font-mono text-xs">
        → {picked}
      </div>
    );
  }

  return (
    <div className="my-2 p-3 border border-cyan-500/50 rounded-md bg-slate-900/40 font-mono text-xs">
      {prompt && (
        <div className="mb-2 text-slate-200 font-semibold">{prompt}</div>
      )}
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => {
              setPicked(opt);
              onSubmitText?.(opt);
            }}
            className="px-3 py-1 bg-slate-800 hover:bg-cyan-700 border border-slate-600 hover:border-cyan-400 text-slate-200 rounded transition-colors"
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfirmWidget — ```confirm markdown block (yes/no)
// ---------------------------------------------------------------------------

export function ConfirmWidget({
  prompt,
  onSubmitText,
}: { prompt: string } & WidgetSubmitProps) {
  const [answered, setAnswered] = useState<string | null>(null);

  if (answered) {
    const color =
      answered === "yes" ? "emerald" : answered === "no" ? "rose" : "slate";
    return (
      <div
        className={`my-2 p-3 border border-${color}-500/40 rounded-md bg-${color}-950/20 text-${color}-300 font-mono text-xs`}
      >
        → {answered}
      </div>
    );
  }

  const send = (answer: string) => {
    setAnswered(answer);
    onSubmitText?.(answer);
  };

  return (
    <div className="my-2 p-3 border border-slate-600 rounded-md bg-slate-900/40 font-mono text-xs">
      {prompt && (
        <div className="mb-2 text-slate-200 font-semibold">{prompt}</div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => send("yes")}
          className="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 border border-emerald-500 text-white rounded"
        >
          yes
        </button>
        <button
          type="button"
          onClick={() => send("no")}
          className="px-3 py-1 bg-rose-700 hover:bg-rose-600 border border-rose-500 text-white rounded"
        >
          no
        </button>
        <button
          type="button"
          onClick={() => send("cancel")}
          className="px-3 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-500 text-slate-200 rounded"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MermaidBlock — lazy-loaded diagram renderer
// ---------------------------------------------------------------------------

let mermaidInitPromise: Promise<
  typeof import("mermaid").default
> | null = null;

function loadMermaid() {
  if (!mermaidInitPromise) {
    mermaidInitPromise = import("mermaid").then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        theme: "dark",
        themeVariables: {
          background: "#0f172a",
          primaryColor: "#1e293b",
          primaryBorderColor: "#475569",
          primaryTextColor: "#e2e8f0",
          lineColor: "#64748b",
        },
        securityLevel: "strict",
      });
      return mod.default;
    });
  }
  return mermaidInitPromise;
}

export function MermaidBlock({ source }: { source: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId().replace(/:/g, "");

  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then((mermaid) =>
        mermaid.render(`mmd-${id}`, source).then((result) => {
          if (cancelled || !containerRef.current) return;
          containerRef.current.innerHTML = result.svg;
          setError(null);
        }),
      )
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [source, id]);

  if (error) {
    return (
      <div className="my-2 p-3 border border-rose-500/50 rounded-md bg-rose-950/20 font-mono text-xs text-rose-300">
        mermaid error: {error}
        <pre className="mt-1 text-slate-400 whitespace-pre-wrap">{source}</pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-2 p-3 rounded-md bg-slate-900/60 border border-slate-700 overflow-x-auto text-slate-100"
    />
  );
}

// ---------------------------------------------------------------------------
// KbdChip — inline <code> that looks like a keyboard shortcut gets rendered
// as actual keycap chips. Detected by a regex before the render override
// decides which variant of inline code to use.
// ---------------------------------------------------------------------------

const KEY_PATTERN =
  /^(Ctrl|Control|Cmd|Command|⌘|⌃|⌥|⇧|Alt|Option|Shift|Tab|Enter|Return|Escape|Esc|Space|Backspace|Delete|Del|Up|Down|Left|Right|F\d{1,2})(\s*[+\-]\s*[A-Za-z0-9]+)+$/;

export function isKeyboardShortcut(text: string): boolean {
  return KEY_PATTERN.test(text.trim());
}

export function KbdChip({ children }: { children: string }) {
  const parts = children
    .trim()
    .split(/\s*[+\-]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <span className="inline-flex items-center gap-0.5 align-middle">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center">
          {i > 0 && (
            <span className="mx-0.5 text-slate-500 text-[0.85em]">+</span>
          )}
          <kbd className="px-1.5 py-0.5 text-[0.75em] font-mono font-semibold bg-slate-800 text-slate-100 border border-slate-600 rounded shadow-[0_1px_0_rgba(0,0,0,0.4)]">
            {p}
          </kbd>
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// FilePathText — scan a text run for path-like tokens (src/foo.ts,
// frontend/src/App.tsx:42, /absolute/path:1:3, etc.) and turn them into
// clickable spans that open the file in the sidebar editor.
//
// Regex intentionally requires at least one `/` or `.ext:line` shape to
// avoid matching bare words. Paths without line numbers are also matched.
// ---------------------------------------------------------------------------

const FILE_PATTERN =
  /((?:[a-zA-Z0-9_.\-~]+\/)+[a-zA-Z0-9_.\-]+\.[a-zA-Z0-9]+)(?::(\d+)(?::\d+)?)?/g;

export function FilePathText({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile?: (path: string, filename: string) => void;
}): ReactNode {
  if (!onOpenFile) return text;

  const parts: ReactNode[] = [];
  let last = 0;
  const re = new RegExp(FILE_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [whole, path] = match;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <button
        key={`${match.index}-${whole}`}
        type="button"
        onClick={() => {
          const name = path.split("/").pop() || path;
          onOpenFile(path, name);
        }}
        className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2 font-mono"
      >
        {whole}
      </button>,
    );
    last = match.index + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : text;
}

/** Walk a react-markdown paragraph's children and linkify plain text runs. */
export function linkifyPaths(
  children: ReactNode,
  onOpenFile?: (path: string, filename: string) => void,
): ReactNode {
  if (!onOpenFile) return children;
  if (typeof children === "string") {
    return <FilePathText text={children} onOpenFile={onOpenFile} />;
  }
  if (Array.isArray(children)) {
    return children.map((c, i) => {
      const node = linkifyPaths(c, onOpenFile);
      if (typeof c === "string") return <span key={i}>{node}</span>;
      return node;
    });
  }
  return children;
}

// ---------------------------------------------------------------------------
// TimeAgo — tiny relative-time label. No dayjs import needed for two
// orders of magnitude of resolution.
// ---------------------------------------------------------------------------

export function formatTimeAgo(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 10_000) return "just now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

export function TimeAgo({ ts }: { ts: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return <span>{formatTimeAgo(ts)}</span>;
}

// ---------------------------------------------------------------------------
// CollapsibleProse — for very long assistant messages. Collapses after N
// lines with an expand toggle. Only wraps the markdown content, not the
// gutter / header, so the label stays visible.
// ---------------------------------------------------------------------------

const COLLAPSE_THRESHOLD_LINES = 40;
const COLLAPSE_HEIGHT_PX = 400;

export function CollapsibleProse({
  children,
  source,
}: {
  children: ReactNode;
  source: string;
}) {
  const lineCount = useMemo(() => source.split("\n").length, [source]);
  const shouldCollapse = lineCount > COLLAPSE_THRESHOLD_LINES;
  const [expanded, setExpanded] = useState(false);

  if (!shouldCollapse) return <>{children}</>;

  return (
    <div className="relative">
      <div
        className="overflow-hidden transition-all"
        style={{ maxHeight: expanded ? "none" : `${COLLAPSE_HEIGHT_PX}px` }}
      >
        {children}
      </div>
      {!expanded && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-slate-950 to-transparent" />
      )}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 text-[11px] font-mono text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
      >
        {expanded
          ? "[− collapse]"
          : `[+ expand ${lineCount - Math.round(COLLAPSE_HEIGHT_PX / 16)} more lines]`}
      </button>
    </div>
  );
}
