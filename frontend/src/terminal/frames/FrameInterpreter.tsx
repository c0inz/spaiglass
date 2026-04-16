/**
 * Phase B — frame-native row renderer.
 *
 * Pure: takes a Row (from state.ts) and returns a ReactNode.
 *
 * The main correctness win over the legacy interpreter: assistant rows
 * render their content blocks in the exact order Claude emitted them,
 * with tool cards embedded INLINE at the tool_use block position via a
 * toolCalls-map lookup. Text-between-tools stays in the right place.
 *
 * Re-uses the existing Term* component library (TermBox, TermToolCard,
 * TermDiff, TermChecklist, TermInput, TermButton, TermChoice) and the
 * ClaudeMarkdown renderer — those are the render primitives that already
 * earned their keep in Phase A, unchanged.
 */

import { useState, type ReactNode } from "react";
import {
  TermBox,
  TermButton,
  TermChecklist,
  TermChoice,
  TermDiff,
  TermInput,
  TermText,
  TermToolCard,
} from "../components";
// Shared markdown renderer and lineDiff helper — lifted out of the legacy
// interpreter into terminal/markdown.tsx as part of the Phase B cutover so
// FrameInterpreter doesn't drag the whole AllMessage tree along with it.
import { ClaudeMarkdown, lineDiff } from "../markdown";
import type {
  AssistantContentBlock,
  FileDeliveryFrame,
  PlanFrame,
  TodoFrame,
} from "../../../../shared/frames";
import {
  shouldRenderInlineToolCard,
  shouldShowToolOutput,
  type AssistantRow,
  type ErrorRow,
  type InteractiveRow,
  type Row,
  type ToolCallState,
  type UserRow,
} from "./state";

// ---------------------------------------------------------------------------
// Render options
// ---------------------------------------------------------------------------

/** Same shape as the reply type in the legacy interpreter. */
export type InteractiveToolResultStatus = "accepted" | "approved" | "rejected";

export interface FrameRenderOptions {
  userLogin?: string | null;
  /** Used by assistant markdown to open a file in the editor panel. */
  onOpenFile?: (path: string, filename: string) => void;
  /** Reply callback for interactive widgets. */
  onToolResult?: (
    requestId: string,
    status: InteractiveToolResultStatus,
    data?: unknown,
    reason?: string,
  ) => void;
  /** Assistant markdown can embed widgets that submit chat text. */
  onSubmitText?: (text: string) => void;
  /** Map of tool calls keyed by toolCallId — used to resolve inline tool
   *  cards inside assistant rows. Passed separately from the row so that
   *  streaming updates to tool output trigger only the affected row's
   *  re-render (React.memo comparison can short-circuit on row identity
   *  AND the toolCalls Map reference). */
  toolCalls: Map<string, ToolCallState>;
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

export function renderFrameRow(row: Row, opts: FrameRenderOptions): ReactNode {
  switch (row.kind) {
    case "user":
      return <UserRowView row={row} opts={opts} />;
    case "assistant":
      return <AssistantRowView row={row} opts={opts} />;
    case "file_delivery":
      return <FileDeliveryRowView frame={row.frame} opts={opts} />;
    case "plan":
      return <PlanRowView frame={row.frame} />;
    case "todo":
      return <TodoRowView frame={row.frame} />;
    case "interactive":
      return <InteractiveRowView row={row} opts={opts} />;
    case "error":
      return <ErrorRowView row={row} />;
  }
}

// ---------------------------------------------------------------------------
// User row
// ---------------------------------------------------------------------------

function UserRowView({
  row,
  opts,
}: {
  row: UserRow;
  opts: FrameRenderOptions;
}): ReactNode {
  const label = opts.userLogin || "user";
  // User frames carry an ordered content array so we can render text,
  // images, and files as separate blocks. Right now only text is wired
  // end-to-end — images/files render placeholder chips.
  return (
    <div
      className="my-2 font-mono text-sm border-l-2 pl-3 border-blue-500/60 dark:border-blue-400/60 bg-slate-800/60 dark:bg-slate-800/60 rounded-r-md py-2 pr-2"
      data-role="user"
    >
      <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500 dark:text-slate-400 mb-1">
        {label}@spaiglass
      </div>
      <div className="flex gap-2">
        <span
          className="flex-shrink-0 text-blue-500 dark:text-blue-400"
          aria-hidden="true"
        >
          $
        </span>
        <div className="flex-1 min-w-0">
          {row.frame.content.map((block, idx) => {
            if (block.type === "text") {
              return (
                <pre
                  key={idx}
                  className="whitespace-pre-wrap break-words text-slate-100 min-w-0"
                >
                  {block.text}
                </pre>
              );
            }
            if (block.type === "image") {
              // Display the image inline, capped to a reasonable chat-column
              // width while preserving aspect ratio. Click opens the full
              // image in a new tab so the user can zoom without leaving the
              // page.
              return (
                <a
                  key={idx}
                  href={block.dataUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block mt-1 max-w-sm"
                >
                  <img
                    src={block.dataUrl}
                    alt="Attached image"
                    className="max-w-full max-h-80 rounded border border-slate-600/60 object-contain"
                  />
                </a>
              );
            }
            if (block.type === "file") {
              return (
                <div
                  key={idx}
                  className="text-xs text-slate-400 italic mt-1"
                  aria-label="Attached file"
                >
                  [file: {block.filename}]
                </div>
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assistant row — the correctness-critical one
// ---------------------------------------------------------------------------

function AssistantRowView({
  row,
  opts,
}: {
  row: AssistantRow;
  opts: FrameRenderOptions;
}): ReactNode {
  const [showAllTools, setShowAllTools] = useState(false);

  // Transient tool-card behavior: only the most recent tool call renders
  // inline. Earlier successful calls are hidden behind a compact counter
  // badge so the chat transcript stays clean. Running and errored calls
  // always render (you need to see what's active and what broke).
  const toolUseIndices: number[] = [];
  for (let i = 0; i < row.content.length; i++) {
    const b = row.content[i];
    if (b.type === "tool_use" && shouldRenderInlineToolCard(b)) {
      toolUseIndices.push(i);
    }
  }
  const lastToolIdx =
    toolUseIndices.length > 0
      ? toolUseIndices[toolUseIndices.length - 1]
      : -1;

  const hiddenToolIndices = new Set<number>();
  if (!showAllTools) {
    for (const idx of toolUseIndices) {
      const block = row.content[idx];
      if (block.type !== "tool_use") continue;
      const call = opts.toolCalls.get(block.toolCallId);
      const status = call?.status ?? "running";
      const isLast = idx === lastToolIdx;
      const isRunning = status === "running";
      const isError = status !== "ok" && status !== "running";
      if (!isLast && !isRunning && !isError) {
        hiddenToolIndices.add(idx);
      }
    }
  }

  const hiddenCount = hiddenToolIndices.size;
  // Position the badge at the first hidden tool call's location
  const firstHiddenIdx =
    hiddenCount > 0
      ? toolUseIndices.find((i) => hiddenToolIndices.has(i)) ?? -1
      : -1;

  return (
    <div
      className="my-2 font-mono text-sm border-l-2 pl-3 border-emerald-500/60 dark:border-emerald-400/60"
      data-role="assistant"
    >
      <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500 dark:text-slate-400 mb-1">
        claude@spaiglass
      </div>
      <div className="flex gap-2">
        <span
          className="flex-shrink-0 text-emerald-500 dark:text-emerald-400"
          aria-hidden="true"
        >
          λ
        </span>
        <div className="flex-1 min-w-0 text-slate-100 sg-md">
          {row.content.map((block, idx) => {
            // Inject the hidden-tools badge at the first hidden slot
            const badge =
              idx === firstHiddenIdx ? (
                <button
                  key="tool-badge"
                  type="button"
                  onClick={() => setShowAllTools((v) => !v)}
                  className="inline-flex items-center gap-1 my-1 px-2 py-0.5 rounded text-[10px] font-medium bg-slate-700/60 text-slate-400 hover:text-slate-200 hover:bg-slate-600/60 transition-colors cursor-pointer"
                  title={`${hiddenCount} completed tool call${hiddenCount !== 1 ? "s" : ""} — click to expand`}
                >
                  <span className="text-emerald-500">✓</span>
                  {hiddenCount} tool call{hiddenCount !== 1 ? "s" : ""}
                </button>
              ) : null;

            // Skip hidden tool_use blocks
            if (hiddenToolIndices.has(idx)) return badge;

            return (
              <span key={idx}>
                {badge}
                <AssistantBlock
                  block={block}
                  opts={opts}
                  assistantMessageId={row.messageId}
                  blockIndex={idx}
                />
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AssistantBlock({
  block,
  opts,
  assistantMessageId,
  blockIndex,
}: {
  block: AssistantContentBlock;
  opts: FrameRenderOptions;
  assistantMessageId: string;
  blockIndex: number;
}): ReactNode {
  switch (block.type) {
    case "text":
      if (!block.text) return null;
      return (
        <ClaudeMarkdown
          source={block.text}
          onSubmitText={opts.onSubmitText}
          onOpenFile={opts.onOpenFile}
        />
      );

    case "thinking":
      // Thinking blocks are rendered as dimmed, italic side-notes so the
      // reasoning stays visible without competing with the main prose.
      // The legacy renderer hid these entirely on replay; we surface them
      // here because frame-native history preserves the ordering and it
      // reads nicely inline.
      if (!block.text) return null;
      return (
        <div className="my-1 pl-2 border-l-2 border-slate-600 text-slate-400 italic text-xs whitespace-pre-wrap">
          {block.text}
        </div>
      );

    case "tool_use": {
      if (!shouldRenderInlineToolCard(block)) {
        // TodoWrite / ExitPlanMode are rendered as dedicated top-level
        // rows by PlanRow / TodoRow. Swallow here so they don't
        // double-render inline.
        return null;
      }
      const call = opts.toolCalls.get(block.toolCallId);
      return (
        <InlineToolCard
          toolCallId={block.toolCallId}
          tool={block.tool}
          fallbackInput={block.input}
          call={call}
          anchor={{ assistantMessageId, blockIndex }}
        />
      );
    }

    case "inline_tool_result":
      // Reserved for SDK-native tools that attach results inline.
      // Not yet wired end-to-end — render a small tag so it's visible
      // during development.
      return (
        <div className="my-1 text-xs text-slate-400">
          [inline_tool_result #{block.toolCallId}]
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Inline tool card — the embedded lifecycle view for a single tool call
// ---------------------------------------------------------------------------

function InlineToolCard({
  toolCallId,
  tool,
  fallbackInput,
  call,
  anchor,
}: {
  toolCallId: string;
  tool: string;
  fallbackInput: unknown;
  call: ToolCallState | undefined;
  anchor: { assistantMessageId: string; blockIndex: number };
}): ReactNode {
  // `call` can be undefined if the frontend has the assistant_message but
  // not yet the matching tool_call_start (unlikely — backend emits them
  // together — but cheap to guard). Render a placeholder spinner card
  // using the content-block's input so the user sees something.
  const [collapsed, setCollapsed] = useState(true);

  const status = call?.status ?? "running";
  const input = (call?.input as Record<string, unknown> | undefined) ??
    (typeof fallbackInput === "object" && fallbackInput !== null
      ? (fallbackInput as Record<string, unknown>)
      : undefined);
  const cardStatus: "running" | "ok" | "error" =
    status === "running"
      ? "running"
      : status === "ok"
        ? "ok"
        : "error";

  // Preserve the "bug #3" rule from the legacy adapter: successful
  // tool results are visual noise. Only show expanded output if the call
  // errored or is still running. The header still renders either way so
  // the user can see the tool name and arguments.
  const showOutput = call ? shouldShowToolOutput(call) : true;
  const output = showOutput ? call?.output : undefined;
  const errorOutput = showOutput ? call?.errorOutput : undefined;

  return (
    <div
      className="my-1"
      data-tool-call-id={toolCallId}
      data-anchor-message={anchor.assistantMessageId}
      data-anchor-block={anchor.blockIndex}
    >
      <TermToolCard
        tool={tool}
        args={input}
        status={cardStatus}
        output={output}
        errorOutput={errorOutput}
        collapsed={showOutput ? collapsed : true}
        onToggle={showOutput ? () => setCollapsed((c) => !c) : undefined}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// File delivery row
// ---------------------------------------------------------------------------

function FileDeliveryRowView({
  frame,
  opts,
}: {
  frame: FileDeliveryFrame;
  opts: FrameRenderOptions;
}): ReactNode {
  const handleOpen = opts.onOpenFile
    ? () => opts.onOpenFile?.(frame.path, frame.filename)
    : undefined;

  const hasDiff =
    frame.action === "edit" &&
    frame.oldString != null &&
    frame.newString != null;

  return (
    <div className="my-1">
      <TermToolCard
        tool={frame.action === "write" ? "File Created" : "File Updated"}
        args={frame.path}
        status="ok"
      />
      {hasDiff && (
        <div className="mt-1 ml-3">
          <TermDiff
            diff={lineDiff(frame.oldString as string, frame.newString as string)}
            filename={frame.filename}
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
            [open {frame.filename}]
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan / Todo rows
// ---------------------------------------------------------------------------

function PlanRowView({ frame }: { frame: PlanFrame }): ReactNode {
  return (
    <div className="my-2">
      <TermBox border title="Plan">
        <pre className="whitespace-pre-wrap text-slate-700 dark:text-slate-200">
          {frame.plan}
        </pre>
      </TermBox>
    </div>
  );
}

function TodoRowView({ frame }: { frame: TodoFrame }): ReactNode {
  return (
    <div className="my-2">
      <TermChecklist items={frame.todos} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interactive row (MCP widgets)
// ---------------------------------------------------------------------------

function InteractiveRowView({
  row,
  opts,
}: {
  row: InteractiveRow;
  opts: FrameRenderOptions;
}): ReactNode {
  const submit = opts.onToolResult;
  const disabled = row.resolved !== null;

  switch (row.prompt.kind) {
    case "prompt_secret":
      return (
        <TermInput
          prompt={row.prompt.prompt ?? ""}
          secret={row.prompt.secret}
          placeholder={row.prompt.placeholder ?? null}
          disabled={disabled}
          onSubmit={(value) =>
            submit?.(row.prompt.requestId, "accepted", value)
          }
        />
      );
    case "tool_permission":
      return (
        <TermButton
          action={row.prompt.action ?? ""}
          details={row.prompt.details ?? null}
          disabled={disabled}
          onApprove={() => submit?.(row.prompt.requestId, "approved")}
          onReject={() => submit?.(row.prompt.requestId, "rejected")}
        />
      );
    case "request_choice":
      return (
        <TermChoice
          prompt={row.prompt.prompt ?? ""}
          choices={row.prompt.choices ?? []}
          disabled={disabled}
          onPick={(choice) =>
            submit?.(row.prompt.requestId, "accepted", choice)
          }
        />
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Error row
// ---------------------------------------------------------------------------

function ErrorRowView({ row }: { row: ErrorRow }): ReactNode {
  // Notices are client-synthesized informational messages (permission-mode
  // announcement, "New session started", viewer hint). Render them as a
  // neutral status box so a benign message doesn't look like a red error.
  const isNotice = row.frame.category === "notice";
  return (
    <div className="my-1">
      <TermBox
        border
        title={isNotice ? "Notice" : `Error — ${row.frame.category}`}
      >
        {isNotice ? (
          <TermText>{row.frame.message}</TermText>
        ) : (
          <TermText color="red">{row.frame.message}</TermText>
        )}
      </TermBox>
    </div>
  );
}
