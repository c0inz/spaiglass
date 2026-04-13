/**
 * Phase 6.2: Terminal interpreter — converts an AllMessage from the existing
 * stream into a tree of Term* components from components.tsx.
 *
 * The interpreter consumes the same `AllMessage` produced by
 * useMessageProcessor (so it can run side-by-side with the legacy renderer)
 * and emits the rich terminal-style component tree.
 *
 * Phase 6.4 will switch the source to the WebSocket "Ink" Layer Contract
 * (see agent-terminal-json.md) and add interactive widgets. Right now we
 * adapt from the existing message types, which is enough to demo the
 * visual fidelity behind ?renderer=terminal.
 */

import type { ReactNode } from "react";
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
import type {
  AllMessage,
  ChatMessage,
  SystemMessage,
  ToolMessage,
  ToolResultMessage,
  PlanMessage,
  ThinkingMessage,
  TodoMessage,
  FileDeliveryMessage,
  InteractiveMessage,
} from "../types";
// contentUtils imports removed — tool results are now transient status lines
import {
  TermBox,
  TermButton,
  TermChecklist,
  TermChoice,
  TermCodeBlock,
  TermDiff,
  TermInput,
  TermText,
  TermToolCard,
} from "./components";

/**
 * Phase 6.4 — reply payload sent back to the backend in a `tool_result` frame.
 * The shape mirrors the `ToolReply` produced by `backend/mcp/interactive-tools.ts`.
 */
export type InteractiveToolResultStatus = "accepted" | "approved" | "rejected";

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
 *
 * React-markdown's default `components` map is overridden for each element
 * we care about so tailwind classes apply without needing the `prose`
 * typography plugin.
 */
interface ClaudeMarkdownProps {
  source: string;
  onSubmitText?: (text: string) => void;
  onOpenFile?: (path: string, filename: string) => void;
}

function ClaudeMarkdown({
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
          // GFM task-list wrapper gets a special class — render without
          // bullets so the `li` override can draw its own glyph.
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
          // GFM task-list items come through with a `.task-list-item` class
          // plus an embedded <input type="checkbox" disabled checked?> as
          // the first child. Replace the checkbox with a terminal glyph.
          const isTask = /task-list-item/.test(className || "");
          if (!isTask) {
            return <li className="leading-snug">{children}</li>;
          }
          // Scan children for the checkbox to determine checked state.
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
        // Inline code override. Detects keyboard-shortcut strings and
        // renders them as keycap chips; everything else gets the subtle
        // emerald inline-code treatment. Block code comes through `pre`
        // below, which is where we intercept intent-fenced blocks.
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
        // Fenced code blocks. The first child is the inner <code>, from
        // which we extract both the raw text and the language class. We
        // check the language against the intent-fenced widget set first,
        // then fall back to a highlighted code block with copy toolbar.
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
        // GFM tables — bordered, stays in mono font. Scrolls horizontally
        // if too wide rather than bursting the chat pane.
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
 * Format (flexible — we accept either):
 *
 *   Prompt text
 *   - option a
 *   - option b
 *   * option c
 *
 * or
 *
 *   Prompt: Do you want to proceed?
 *   Options: yes, no
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
 * Render a single AllMessage as a Term* component subtree.
 *
 * Returns null for messages that the terminal renderer chooses to skip
 * (e.g. transient init system messages that the legacy renderer collapses
 * into "System" cards). Tests in 6.2 cover the major branches.
 *
 * `onOpenFile` is threaded through so file_delivery messages can render an
 * "Open" button that opens the file in the sidebar editor — same UX as the
 * legacy FileDeliveryMessageComponent.
 */
export interface RenderOptions {
  /** GitHub login of the authenticated user (e.g. "johntdavenport"). */
  userLogin?: string | null;
  onOpenFile?: (path: string, filename: string) => void;
  /**
   * Phase 6.4 — invoked when the user submits a reply to an interactive
   * widget. The interpreter forwards the call to the WS hook, which sends
   * a `tool_result` frame back to the backend keyed by `requestId`.
   */
  onToolResult?: (
    requestId: string,
    status: InteractiveToolResultStatus,
    data?: unknown,
    reason?: string,
  ) => void;
  /**
   * Invoked when a markdown-embedded widget (secret-input / confirm /
   * choice fenced blocks inside an assistant message) wants to send a
   * chat message back. Wired through to `sendMessage` in ChatPage.
   */
  onSubmitText?: (text: string) => void;
}

export function renderTerminalMessage(
  message: AllMessage,
  opts: RenderOptions = {},
): ReactNode {
  switch (message.type) {
    case "chat":
      return renderChat(message as ChatMessage, opts);
    case "tool":
      return renderTool(message as ToolMessage);
    case "tool_result":
      return renderToolResult(message as ToolResultMessage);
    case "plan":
      return renderPlan(message as PlanMessage);
    case "thinking":
      return renderThinking(message as ThinkingMessage);
    case "todo":
      return renderTodo(message as TodoMessage);
    case "file_delivery":
      return renderFileDelivery(message as FileDeliveryMessage, opts);
    case "interactive":
      return renderInteractive(message as InteractiveMessage, opts);
    case "system":
    case "result":
    case "error":
      return renderSystem(message as SystemMessage);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// chat (user / assistant)
// ---------------------------------------------------------------------------

function renderChat(message: ChatMessage, opts: RenderOptions): ReactNode {
  const isUser = message.role === "user";
  // Terminal-style: left-aligned monospace block with a shell-prompt prefix
  // and a colored gutter line. No bubble, no rounded corners — looks like a
  // tmux/xterm pane.
  const prompt = isUser ? "$" : "λ";
  const promptColor = isUser
    ? "text-blue-500 dark:text-blue-400"
    : "text-emerald-500 dark:text-emerald-400";
  const gutterColor = isUser
    ? "border-blue-500/60 dark:border-blue-400/60"
    : "border-emerald-500/60 dark:border-emerald-400/60";
  const label = isUser ? (opts.userLogin || "user") : "claude";

  // User messages stay as literal preformatted text — they're commands,
  // paths, and questions that should not get accidentally parsed as markdown
  // (e.g. a leading "1." should not become an ordered list). Assistant
  // messages go through full GFM markdown with syntax-highlighted code
  // blocks, tables, lists, headings, bold/italic, and inline code.
  const body = isUser ? (
    <pre className="flex-1 whitespace-pre-wrap break-words text-slate-800 dark:text-slate-100 min-w-0">
      {message.content}
    </pre>
  ) : (
    <div className="flex-1 min-w-0 text-slate-100 sg-md">
      <ClaudeMarkdown
        source={message.content}
        onSubmitText={opts.onSubmitText}
        onOpenFile={opts.onOpenFile}
      />
    </div>
  );

  return (
    <div
      className={`my-2 font-mono text-sm border-l-2 pl-3 ${gutterColor}`}
      data-role={message.role}
    >
      <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500 dark:text-slate-400 mb-1">
        {label}@spaiglass
      </div>
      <div className="flex gap-2">
        <span className={`flex-shrink-0 ${promptColor}`} aria-hidden="true">
          {prompt}
        </span>
        {body}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// tool (start of a tool call — intentionally invisible)
//
// A `tool` message is emitted when Claude announces a tool call, followed
// shortly by a `tool_result` message carrying the outcome. Because the two
// messages have no shared id we cannot "complete" the placeholder in place —
// so rendering a `status="running"` card here would leave a spinner wedged
// on screen forever next to the (separate) result card below it. Instead we
// rely on the global bottom-of-chat "thinking" spinner to indicate a call is
// in flight; that one IS tied to `isLoading` and stops cleanly.
// ---------------------------------------------------------------------------

function renderTool(_message: ToolMessage): ReactNode {
  return null;
}

// ---------------------------------------------------------------------------
// tool_result — the workhorse: bash, edit, read, grep, write, etc.
// ---------------------------------------------------------------------------

function renderToolResult(_message: ToolResultMessage): ReactNode {
  // Tool results are transient — during streaming they appear as status line
  // labels ("Reading source files…", "Executing tests…"), not permanent cards.
  // In history replay they're also suppressed for a clean conversation view.
  return null;
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

function renderPlan(message: PlanMessage): ReactNode {
  return (
    <div className="my-2">
      <TermBox border title="Plan">
        <pre className="whitespace-pre-wrap text-slate-700 dark:text-slate-200">
          {message.plan}
        </pre>
      </TermBox>
    </div>
  );
}

// ---------------------------------------------------------------------------
// thinking
// ---------------------------------------------------------------------------

function renderThinking(_message: ThinkingMessage): ReactNode {
  // Thinking is transient — during streaming it appears as a status line
  // label ("Analyzing problem…", "Refining plan…"), not a permanent card.
  // In history replay it's also suppressed for a clean conversation view.
  return null;
}

// ---------------------------------------------------------------------------
// todo (TodoWrite)
// ---------------------------------------------------------------------------

function renderTodo(message: TodoMessage): ReactNode {
  return (
    <div className="my-2">
      <TermChecklist items={message.todos} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// file_delivery
// ---------------------------------------------------------------------------

/**
 * Generate a compact unified diff from old/new strings.
 * Shows all removed lines (-) followed by all added lines (+).
 * For large diffs, truncates to first/last N context lines with an ellipsis.
 */
function makeSimpleDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const output: string[] = [];

  for (const line of oldLines) {
    output.push(`-${line}`);
  }
  for (const line of newLines) {
    output.push(`+${line}`);
  }

  // If total > 20 lines, show first 5 and last 5 with ellipsis
  if (output.length > 20) {
    const head = output.slice(0, 5);
    const tail = output.slice(-5);
    const skipped = output.length - 10;
    return [...head, ` ... ${skipped} more lines ...`, ...tail].join("\n");
  }

  return output.join("\n");
}

function renderFileDelivery(
  message: FileDeliveryMessage,
  opts: RenderOptions,
): ReactNode {
  const handleOpen = opts.onOpenFile
    ? () => opts.onOpenFile?.(message.path, message.filename)
    : undefined;

  // Generate diff for Edit operations with old/new data
  const hasDiff =
    message.action === "edit" && message.oldString != null && message.newString != null;

  return (
    <div className="my-1">
      <TermToolCard
        tool={message.action === "write" ? "File Created" : "File Updated"}
        args={message.path}
        status="ok"
      />
      {hasDiff && (
        <div className="mt-1 ml-3">
          <TermDiff
            diff={makeSimpleDiff(message.oldString!, message.newString!)}
            filename={message.filename}
          />
        </div>
      )}
      {handleOpen && (
        <div className="mt-1 ml-3">
          <button
            type="button"
            onClick={handleOpen}
            className="font-mono text-xs text-emerald-400 hover:text-emerald-300 underline underline-offset-2"
          >
            [open {message.filename}]
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// interactive (P6.4 — MCP-driven prompts: input / approval / choice)
// ---------------------------------------------------------------------------

function renderInteractive(
  message: InteractiveMessage,
  opts: RenderOptions,
): ReactNode {
  const submit = opts.onToolResult;
  // If no callback was wired we still render the widget but it will be a
  // no-op on submit. This keeps the buffer-replay path safe in tests.
  const disabled = message.answered === true;

  switch (message.kind) {
    case "prompt_secret":
      return (
        <TermInput
          prompt={message.prompt ?? ""}
          secret={message.secret}
          placeholder={message.placeholder ?? null}
          disabled={disabled}
          onSubmit={(value) => submit?.(message.requestId, "accepted", value)}
        />
      );
    case "tool_permission":
      return (
        <TermButton
          action={message.action ?? ""}
          details={message.details ?? null}
          disabled={disabled}
          onApprove={() => submit?.(message.requestId, "approved")}
          onReject={() => submit?.(message.requestId, "rejected")}
        />
      );
    case "request_choice":
      return (
        <TermChoice
          prompt={message.prompt ?? ""}
          choices={message.choices ?? []}
          disabled={disabled}
          onPick={(choice) => submit?.(message.requestId, "accepted", choice)}
        />
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// system / result / error
// ---------------------------------------------------------------------------

function renderSystem(message: SystemMessage): ReactNode {
  // Result — final stats
  if (message.type === "result") {
    return (
      <div className="my-1">
        <TermBox border title="Result">
          <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-xs">
            <div>
              <span className="text-slate-500 dark:text-slate-400">
                duration:{" "}
              </span>
              <span className="tabular-nums">{message.duration_ms}ms</span>
            </div>
            <div>
              <span className="text-slate-500 dark:text-slate-400">cost: </span>
              <span className="tabular-nums">
                ${message.total_cost_usd.toFixed(4)}
              </span>
            </div>
            <div>
              <span className="text-slate-500 dark:text-slate-400">
                tokens:{" "}
              </span>
              <span className="tabular-nums">
                {message.usage.input_tokens}↑ / {message.usage.output_tokens}↓
              </span>
            </div>
          </div>
        </TermBox>
      </div>
    );
  }

  // Error
  if (message.type === "error") {
    return (
      <div className="my-1">
        <TermBox border title="Error">
          <TermText color="red">{message.message}</TermText>
        </TermBox>
      </div>
    );
  }

  // Init
  if ("subtype" in message && message.subtype === "init") {
    return (
      <div className="my-1">
        <TermBox border title="Session Init">
          <div className="text-xs grid grid-cols-2 gap-x-4 gap-y-0.5">
            <div>
              <TermText dim>model:</TermText>{" "}
              <TermText>{(message as { model: string }).model}</TermText>
            </div>
            <div>
              <TermText dim>permission:</TermText>{" "}
              <TermText>
                {(message as { permissionMode: string }).permissionMode}
              </TermText>
            </div>
            <div>
              <TermText dim>tools:</TermText>{" "}
              <TermText>
                {(message as { tools: string[] }).tools?.length ?? 0} available
              </TermText>
            </div>
            <div>
              <TermText dim>session:</TermText>{" "}
              <TermText>
                {(message as { session_id: string }).session_id?.slice(0, 8)}
              </TermText>
            </div>
          </div>
        </TermBox>
      </div>
    );
  }

  // Hooks / generic system message
  if ("content" in message && typeof message.content === "string") {
    return (
      <div className="my-1">
        <TermBox border title="System">
          <pre className="whitespace-pre-wrap text-xs">{message.content}</pre>
        </TermBox>
      </div>
    );
  }

  return null;
}

// Re-export TermCodeBlock so future callers can use it without re-importing.
export { TermCodeBlock };
