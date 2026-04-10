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
} from "../types";
import {
  isBashToolUseResult,
  isEditToolUseResult,
} from "../utils/contentUtils";
import {
  TermBox,
  TermChecklist,
  TermCodeBlock,
  TermDiff,
  TermText,
  TermToolCard,
} from "./components";

/**
 * Render a single AllMessage as a Term* component subtree.
 *
 * Returns null for messages that the terminal renderer chooses to skip
 * (e.g. transient init system messages that the legacy renderer collapses
 * into "System" cards). Tests in 6.2 cover the major branches.
 */
export function renderTerminalMessage(message: AllMessage): ReactNode {
  switch (message.type) {
    case "chat":
      return renderChat(message as ChatMessage);
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
      return renderFileDelivery(message as FileDeliveryMessage);
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

function renderChat(message: ChatMessage): ReactNode {
  const isUser = message.role === "user";
  return (
    <div
      className={`my-2 ${isUser ? "text-right" : "text-left"}`}
      data-role={message.role}
    >
      <div
        className={`inline-block max-w-full text-left rounded-md px-3 py-2 ${
          isUser
            ? "bg-blue-600 text-white"
            : "bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100"
        }`}
      >
        <div
          className={`text-[10px] uppercase tracking-wider mb-1 ${
            isUser ? "text-blue-100" : "text-slate-500 dark:text-slate-400"
          }`}
        >
          {isUser ? "User" : "Claude"}
        </div>
        <pre className="font-mono text-sm whitespace-pre-wrap break-words">
          {message.content}
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// tool (start of a tool call — usually a placeholder, the result follows)
// ---------------------------------------------------------------------------

function renderTool(message: ToolMessage): ReactNode {
  return (
    <div className="my-1">
      <TermToolCard tool={message.content} status="running" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// tool_result — the workhorse: bash, edit, read, grep, write, etc.
// ---------------------------------------------------------------------------

function renderToolResult(message: ToolResultMessage): ReactNode {
  const tool = message.toolName;
  const ur = message.toolUseResult;

  // Bash — show command + stdout/stderr split
  if (tool === "Bash" && isBashToolUseResult(ur)) {
    const isError = Boolean(ur.stderr?.trim());
    return (
      <div className="my-1">
        <TermToolCard
          tool="Bash"
          args={message.summary}
          status={isError ? "error" : "ok"}
          output={ur.stdout || ""}
          errorOutput={ur.stderr || ""}
        />
      </div>
    );
  }

  // Edit — render as a diff
  if (tool === "Edit" && isEditToolUseResult(ur)) {
    const diff = formatStructuredPatch(ur.structuredPatch);
    return (
      <div className="my-1">
        <TermToolCard tool="Edit" args={message.summary} status="ok" />
        {diff && (
          <div className="mt-1">
            <TermDiff diff={diff} />
          </div>
        )}
      </div>
    );
  }

  // Generic tool result — collapsed card showing summary + content
  return (
    <div className="my-1">
      <TermToolCard
        tool={tool}
        args={message.summary}
        status="ok"
        output={message.content}
      />
    </div>
  );
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

function renderThinking(message: ThinkingMessage): ReactNode {
  return (
    <div className="my-2">
      <TermBox border title="Reasoning">
        <TermText italic dim color="magenta">
          <pre className="whitespace-pre-wrap font-mono">{message.content}</pre>
        </TermText>
      </TermBox>
    </div>
  );
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

function renderFileDelivery(message: FileDeliveryMessage): ReactNode {
  return (
    <div className="my-1">
      <TermToolCard
        tool={message.action === "write" ? "File Created" : "File Updated"}
        args={message.path}
        status="ok"
      />
    </div>
  );
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

function formatStructuredPatch(patch: unknown): string {
  if (!Array.isArray(patch)) return "";
  const out: string[] = [];
  for (const hunk of patch as PatchHunk[]) {
    if (!hunk || !Array.isArray(hunk.lines)) continue;
    out.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const line of hunk.lines) out.push(line);
  }
  return out.join("\n");
}

// Re-export TermCodeBlock so future callers can use it without re-importing.
export { TermCodeBlock };
