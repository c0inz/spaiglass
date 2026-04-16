/**
 * Phase B — shared markdown renderer.
 *
 * ClaudeMarkdown and lineDiff were originally part of the legacy
 * `interpreter.tsx` renderer. They're pure pieces that Phase B's
 * FrameInterpreter also needs, so they live in their own module now.
 *
 * Nothing new is added here — this is a lift-and-shift. The widget/
 * keyboard-shortcut plumbing and the intent-fenced code-block intercepts
 * are unchanged.
 */

import { type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import {
  ChoiceWidget,
  CodeBlockWithToolbar,
  ConfirmWidget,
  DiffCodeBlock,
  KbdChip,
  MermaidBlock,
  SecretInputWidget,
  extractCodeText,
  isKeyboardShortcut,
  linkifyPaths,
} from "./markdown-widgets";

/**
 * ClaudeMarkdown — renders assistant chat content with GFM (tables, task
 * lists, strikethrough), syntax-highlighted fenced code blocks, and every
 * block/inline element styled to match the terminal theme. Mono font
 * throughout, dark-surface code blocks, bordered tables.
 *
 * Intent-fenced code blocks get intercepted before highlight.js and routed
 * to dedicated widgets:
 *   ```secret-input  → masked password field, submits to chat
 *   ```choice         → button row, each option submits itself
 *   ```confirm        → yes / no / cancel button row
 *   ```mermaid        → lazy-loaded diagram
 *   ```diff           → TermDiff gutter view
 */
interface ClaudeMarkdownProps {
  source: string;
  onSubmitText?: (text: string) => void;
  onOpenFile?: (path: string, filename: string) => void;
}

export function ClaudeMarkdown({
  source,
  onSubmitText,
  onOpenFile,
}: ClaudeMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        p: ({ children }) => (
          <p className="my-1 whitespace-pre-wrap break-words">
            {linkifyPaths(children, onOpenFile)}
          </p>
        ),
        h1: ({ children }) => (
          <h1 className="text-base font-bold mt-3 mb-1 text-slate-100">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-sm font-bold mt-2 mb-1 text-slate-100">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-sm font-semibold mt-2 mb-0.5 text-slate-200">
            {children}
          </h3>
        ),
        h4: ({ children }) => (
          <h4 className="text-xs font-semibold mt-1 mb-0.5 text-slate-200 uppercase tracking-wide">
            {children}
          </h4>
        ),
        ul: ({ children, className }) => {
          const isTaskList = /contains-task-list/.test(className || "");
          return (
            <ul
              className={
                isTaskList
                  ? "list-none ml-0 my-1 space-y-0.5"
                  : "list-disc ml-5 my-1 space-y-0.5"
              }
            >
              {children}
            </ul>
          );
        },
        ol: ({ children }) => (
          <ol className="list-decimal ml-5 my-1 space-y-0.5">{children}</ol>
        ),
        li: ({ children, className, ...rest }) => {
          const isTask = /task-list-item/.test(className || "");
          if (!isTask) {
            return <li className="leading-snug">{children}</li>;
          }
          let checked = false;
          const rest2: ReactNode[] = [];
          const kids = Array.isArray(children) ? children : [children];
          for (const k of kids) {
            if (
              k &&
              typeof k === "object" &&
              "type" in k &&
              (k as { type: unknown }).type === "input"
            ) {
              const props = (k as { props?: { checked?: boolean } }).props;
              checked = props?.checked === true;
              continue;
            }
            rest2.push(k);
          }
          return (
            <li
              {...rest}
              className="leading-snug flex items-start gap-2 list-none"
            >
              <span
                className={`flex-shrink-0 font-mono text-xs ${
                  checked ? "text-emerald-400" : "text-slate-500"
                }`}
                aria-hidden="true"
              >
                {checked ? "✓" : "○"}
              </span>
              <span
                className={`flex-1 min-w-0 ${checked ? "text-slate-400 line-through" : ""}`}
              >
                {rest2}
              </span>
            </li>
          );
        },
        strong: ({ children }) => (
          <strong className="font-bold text-slate-100">{children}</strong>
        ),
        em: ({ children }) => <em className="italic">{children}</em>,
        del: ({ children }) => (
          <del className="text-slate-500 line-through">{children}</del>
        ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-slate-600 pl-3 my-1 italic text-slate-400">
            {children}
          </blockquote>
        ),
        hr: () => <hr className="my-3 border-slate-700" />,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
          >
            {children}
          </a>
        ),
        img: ({ src, alt }) =>
          src ? (
            <img
              src={src}
              alt={alt || ""}
              className="my-2 max-w-full h-auto rounded-md border border-slate-700"
              loading="lazy"
            />
          ) : null,
        code: ({ className, children, ...rest }) => {
          const isBlock = /language-/.test(className || "");
          if (isBlock) {
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          }
          const text = extractCodeText(children);
          if (isKeyboardShortcut(text)) {
            return <KbdChip>{text}</KbdChip>;
          }
          return (
            <code className="px-1 py-0.5 rounded bg-slate-800/80 text-emerald-300 text-[0.85em]">
              {children}
            </code>
          );
        },
        pre: ({ children }) => {
          const inner = Array.isArray(children) ? children[0] : children;
          let language: string | null = null;
          let codeNode: ReactNode = children;
          if (
            inner &&
            typeof inner === "object" &&
            "props" in inner &&
            (inner as { type: unknown }).type === "code"
          ) {
            const innerEl = inner as {
              props?: { className?: string; children?: ReactNode };
            };
            const cls: string = innerEl.props?.className || "";
            codeNode = innerEl.props?.children as ReactNode;
            const m = /language-([A-Za-z0-9_-]+)/.exec(cls);
            language = m ? m[1] : null;
          }
          const raw = extractCodeText(codeNode).replace(/\n$/, "");

          if (language === "secret-input") {
            return (
              <SecretInputWidget prompt={raw} onSubmitText={onSubmitText} />
            );
          }
          if (language === "confirm") {
            return <ConfirmWidget prompt={raw} onSubmitText={onSubmitText} />;
          }
          if (language === "choice") {
            const { prompt, options } = parseChoiceBlock(raw);
            return (
              <ChoiceWidget
                prompt={prompt}
                options={options}
                onSubmitText={onSubmitText}
              />
            );
          }
          if (language === "mermaid") {
            return <MermaidBlock source={raw} />;
          }
          if (language === "diff") {
            return <DiffCodeBlock raw={raw} />;
          }
          return (
            <CodeBlockWithToolbar language={language} raw={raw}>
              {children}
            </CodeBlockWithToolbar>
          );
        },
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="border-collapse border border-slate-600 text-xs">
              {children}
            </table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-slate-800/60">{children}</thead>
        ),
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => (
          <tr className="border-b border-slate-700/60">{children}</tr>
        ),
        th: ({ children }) => (
          <th className="border border-slate-600 px-2 py-1 text-left font-semibold text-slate-100">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-slate-700 px-2 py-1 align-top text-slate-200">
            {children}
          </td>
        ),
      }}
    >
      {source}
    </ReactMarkdown>
  );
}

/**
 * parseChoiceBlock — interprets the body of a ```choice``` fence.
 *
 * Format (flexible — we accept either a bullet list or "Options: a, b"):
 *
 *   Prompt text
 *   - option a
 *   - option b
 *
 * Returns { prompt, options[] }.
 */
function parseChoiceBlock(body: string): { prompt: string; options: string[] } {
  const lines = body.split("\n").map((l) => l.replace(/\r$/, ""));
  const promptLines: string[] = [];
  const options: string[] = [];
  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      options.push(bullet[1].trim());
      continue;
    }
    const commaList = /^\s*Options\s*:\s*(.+)$/i.exec(line);
    if (commaList) {
      commaList[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((o) => options.push(o));
      continue;
    }
    if (line.trim()) promptLines.push(line.trim());
  }
  const promptRaw = promptLines.join(" ").trim();
  const prompt = promptRaw.replace(/^Prompt\s*:\s*/i, "");
  return { prompt, options };
}

/**
 * Real line diff via LCS. Emits unified-diff style rows:
 *   " ctx"  unchanged
 *   "-old"  removed
 *   "+new"  added
 * Long runs of unchanged context are collapsed to N lines around each
 * change with a "... K unchanged ..." marker, so a small edit in a big
 * file produces a focused hunk view instead of a screen of context.
 */
const DIFF_CONTEXT = 2;

export function lineDiff(oldStr: string, newStr: string): string {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  const m = a.length;
  const n = b.length;

  // LCS DP table: dp[i][j] = LCS length of a[i..m) vs b[j..n).
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push(` ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push(`-${a[i]}`);
      i++;
    } else {
      rows.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < m) rows.push(`-${a[i++]}`);
  while (j < n) rows.push(`+${b[j++]}`);

  const keep = new Array<boolean>(rows.length).fill(false);
  for (let k = 0; k < rows.length; k++) {
    if (rows[k][0] !== " ") {
      const lo = Math.max(0, k - DIFF_CONTEXT);
      const hi = Math.min(rows.length - 1, k + DIFF_CONTEXT);
      for (let x = lo; x <= hi; x++) keep[x] = true;
    }
  }

  const out: string[] = [];
  let skipped = 0;
  for (let k = 0; k < rows.length; k++) {
    if (keep[k]) {
      if (skipped > 0) {
        out.push(`   ... ${skipped} unchanged ...`);
        skipped = 0;
      }
      out.push(rows[k]);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) out.push(`   ... ${skipped} unchanged ...`);

  return out.join("\n");
}
