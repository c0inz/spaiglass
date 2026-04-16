/**
 * FrameEmitter — translates Claude SDK messages into terminal protocol frames.
 *
 * Phase B of the terminal renderer rework. The emitter is the single source
 * of truth for converting the Claude Agent SDK's message stream into the
 * wire format consumed by the frontend terminal renderer. It replaces the
 * frontend-side `UnifiedMessageProcessor` and moves tool_use_id correlation
 * onto the backend where it belongs (so replay and live streaming produce
 * identical output by construction).
 *
 * Design notes:
 *
 * - The emitter is stateful (it owns a tool cache and tracks the current
 *   assistant message id) but does not own sequence numbers or consumers.
 *   Callers pass a `nextSeq()` closure and a timestamp for each emission;
 *   the emitter stamps each produced frame with them.
 * - Produced frames are plain objects typed against `shared/frames.ts`.
 * - Every SDK message can produce zero or more frames. The common case:
 *   one `assistant` SDK message → one `AssistantMessageFrame` plus one
 *   `ToolCallStartFrame` per tool_use content block.
 * - The emitter does NOT broadcast. It returns arrays; the caller hands
 *   them to `SessionManager.broadcast()`.
 *
 * Test scope: `frame-emitter.test.ts` covers the pure `emitFromSdkMessage`
 * path plus the helper emit methods. Integration with `SessionManager`
 * happens in Phase B Step 3.
 */

import { randomBytes } from "node:crypto";
import type {
  Frame,
  Json,
  SessionInitFrame,
  SessionMetaFrame,
  SessionEndFrame,
  UserMessageFrame,
  AssistantMessageFrame,
  AssistantContentBlock,
  ToolCallStartFrame,
  ToolCallEndFrame,
  InteractivePromptFrame,
  InteractiveResolvedFrame,
  FileDeliveryFrame,
  PlanFrame,
  TodoFrame,
  TodoItemShape,
  ErrorFrame,
} from "../../shared/frames.ts";

// ---------------------------------------------------------------------------
// Types shared with callers
// ---------------------------------------------------------------------------

/**
 * Per-emission context. The emitter does not own cursors or wall-clock
 * time — those are injected so the same emitter can be used for live
 * streaming (cursor from session counter, ts from Date.now) and for tests
 * (deterministic counters and timestamps).
 */
export interface EmitContext {
  /** Called once per produced frame to stamp its `seq`. */
  nextSeq: () => number;
  /** Wall-clock ms stamped on every frame from this call. */
  ts: number;
}

/**
 * Minimal shape of an SDK message we accept. We avoid importing the full
 * SDK types because their shape varies across versions; we only use the
 * fields listed here and tolerate unknown content blocks.
 */
export interface SdkMessageLike {
  type: "system" | "assistant" | "user" | "result";
  session_id?: string;
  subtype?: string;
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
  };
  // Init-message fields (type: "system", subtype: "init")
  slash_commands?: string[];
  model?: string;
  permission_mode?: string;
  // Result-message fields (type: "result")
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  // Tool-result correlation payload (SDK uses snake_case)
  tool_use_result?: unknown;
  // Sub-type for result messages
  // e.g. "success" | "error_max_turns" | ...
  // unused by the emitter directly but kept so the adapter can branch on it
  is_error?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortId(): string {
  return randomBytes(8).toString("hex");
}

function coerceInput(raw: unknown): Json {
  if (raw === undefined) return null;
  // JSON.parse(JSON.stringify(x)) would deep-copy and strip functions,
  // but SDK inputs are already plain JSON — cast directly.
  return raw as Json;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

interface TextContentItem {
  type: "text";
  text: string;
}
interface ThinkingContentItem {
  type: "thinking";
  thinking: string;
}
interface ToolUseContentItem {
  type: "tool_use";
  id: string;
  name: string;
  input?: unknown;
}
interface ToolResultContentItem {
  type: "tool_result";
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

type KnownContentItem =
  | TextContentItem
  | ThinkingContentItem
  | ToolUseContentItem
  | ToolResultContentItem;

function isTextItem(x: unknown): x is TextContentItem {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { type?: unknown }).type === "text"
  );
}
function isThinkingItem(x: unknown): x is ThinkingContentItem {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { type?: unknown }).type === "thinking"
  );
}
function isToolUseItem(x: unknown): x is ToolUseContentItem {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { type?: unknown }).type === "tool_use"
  );
}
function isToolResultItem(x: unknown): x is ToolResultContentItem {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { type?: unknown }).type === "tool_result"
  );
}

// Silence "unused warning" for the discriminated union export — it
// documents the full shape for readers even though runtime uses the
// narrower type guards above.
export type _KnownContentItem = KnownContentItem;

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

interface CachedToolUse {
  tool: string;
  input: Json;
  assistantMessageId: string;
  startedAt: number;
}

export class FrameEmitter {
  /**
   * Tracks tool_use_id → metadata across the emitter's lifetime so that
   * later `tool_result` messages can be correlated back to their start.
   * Ownership moves here from the old frontend `UnifiedMessageProcessor`.
   */
  private toolUseCache = new Map<string, CachedToolUse>();

  /**
   * Reset the emitter. Call when a session is destroyed or restarted so
   * stale tool_use_id entries do not leak between sessions.
   */
  public reset(): void {
    this.toolUseCache.clear();
  }

  // -------------------------------------------------------------------------
  // Entry point: SDK message → frames
  // -------------------------------------------------------------------------

  /**
   * Translate one SDK message into zero or more frames.
   *
   * Ordering guarantees:
   *   - The returned array is in emission order. Callers should broadcast
   *     them in array order so `seq` matches wire order.
   *   - For an `assistant` message containing both text and tool_use blocks,
   *     the `AssistantMessageFrame` comes first, then one `ToolCallStartFrame`
   *     per tool call in content order.
   *   - For a `user` message containing tool_result blocks, one
   *     `ToolCallEndFrame` per tool_result is emitted, in content order.
   */
  public emitFromSdkMessage(
    sdk: SdkMessageLike,
    ctx: EmitContext,
  ): Frame[] {
    switch (sdk.type) {
      case "system":
        return this.emitSystem(sdk, ctx);
      case "assistant":
        return this.emitAssistant(sdk, ctx);
      case "user":
        return this.emitUser(sdk, ctx);
      case "result":
        return this.emitResult(sdk, ctx);
      default:
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // SDK message handlers
  // -------------------------------------------------------------------------

  private emitSystem(sdk: SdkMessageLike, ctx: EmitContext): Frame[] {
    // Only `init` system messages translate to SessionInitFrame today.
    // Other system sub-types are swallowed — callers that need them
    // should route through emitError / emitSessionEnd explicitly.
    if (sdk.subtype !== "init") return [];

    const frame: SessionInitFrame = {
      id: shortId(),
      seq: ctx.nextSeq(),
      ts: ctx.ts,
      type: "session_init",
      sessionId: sdk.session_id ?? "",
      model: sdk.model ?? "",
      permissionMode: this.normalizePermissionMode(sdk.permission_mode),
      // Role file is not on the SDK init message — populated later by
      // SessionManager via emitSessionInitExt() if it needs to override.
      roleFile: null,
      workingDirectory: "",
      slashCommands: Array.isArray(sdk.slash_commands)
        ? [...sdk.slash_commands]
        : [],
    };
    return [frame];
  }

  private normalizePermissionMode(
    raw: unknown,
  ): SessionInitFrame["permissionMode"] {
    if (raw === "acceptEdits") return "acceptEdits";
    if (raw === "bypassPermissions") return "bypassPermissions";
    if (raw === "plan") return "plan";
    return "default";
  }

  private emitAssistant(sdk: SdkMessageLike, ctx: EmitContext): Frame[] {
    const frames: Frame[] = [];
    const messageId = sdk.message?.id ?? shortId();
    const rawContent = sdk.message?.content;

    const contentBlocks: AssistantContentBlock[] = [];
    const toolCallFrames: (
      | ToolCallStartFrame
      | PlanFrame
      | TodoFrame
    )[] = [];

    if (Array.isArray(rawContent)) {
      for (const item of rawContent) {
        if (isTextItem(item)) {
          contentBlocks.push({ type: "text", text: item.text });
        } else if (isThinkingItem(item)) {
          contentBlocks.push({ type: "thinking", text: item.thinking });
        } else if (isToolUseItem(item)) {
          const input = coerceInput(item.input);
          contentBlocks.push({
            type: "tool_use",
            toolCallId: item.id,
            tool: item.name,
            input,
          });

          // Cache for later tool_result correlation. Must happen before
          // we emit the start frame so tests that replay can observe it.
          this.toolUseCache.set(item.id, {
            tool: item.name,
            input,
            assistantMessageId: messageId,
            startedAt: ctx.ts,
          });

          // Emit the lifecycle start frame for every tool, even the
          // specialized Plan/Todo tools — their cards still need a
          // running→complete transition, and the frontend can choose
          // to hide the card in favor of the specialized frame.
          const startFrame: ToolCallStartFrame = {
            id: shortId(),
            seq: 0, // assigned below after assistant_message seq
            ts: ctx.ts,
            type: "tool_call_start",
            toolCallId: item.id,
            tool: item.name,
            input,
            assistantMessageId: messageId,
          };
          toolCallFrames.push(startFrame);

          // Specialized frame for Plan / Todo. These carry the rich
          // payload; the ToolCallStart above carries the lifecycle.
          if (item.name === "ExitPlanMode") {
            const planText =
              (input && typeof input === "object" && !Array.isArray(input)
                ? (input.plan as unknown)
                : undefined) ?? "";
            const planFrame: PlanFrame = {
              id: shortId(),
              seq: 0, // assigned below after assistant_message seq
              ts: ctx.ts,
              type: "plan",
              toolCallId: item.id,
              plan: typeof planText === "string" ? planText : String(planText),
            };
            toolCallFrames.push(planFrame);
          } else if (item.name === "TodoWrite") {
            const todos = extractTodoItems(input);
            if (todos) {
              const todoFrame: TodoFrame = {
                id: shortId(),
                seq: 0, // assigned below after assistant_message seq
                ts: ctx.ts,
                type: "todo",
                toolCallId: item.id,
                todos,
              };
              toolCallFrames.push(todoFrame);
            }
          }
        }
        // Unknown content item types are dropped silently. The spec
        // allows future block types — adding one requires a new case
        // here and a corresponding AssistantContentBlock variant.
      }
    }

    // IMPORTANT: The assistant_message must get a seq BEFORE the
    // tool_call_start frames so that when they're pushed in this order
    // (assistant first, tool calls second) the seq numbers are monotonically
    // increasing. The frontend's dedup check drops any frame whose seq <=
    // lastSeq, so broadcasting a higher-seq frame before a lower-seq one
    // causes the lower-seq frame to be silently discarded.
    const assistantSeq = ctx.nextSeq();
    for (const tcf of toolCallFrames) {
      (tcf as { seq: number }).seq = ctx.nextSeq();
    }
    const assistantFrame: AssistantMessageFrame = {
      id: messageId,
      seq: assistantSeq,
      ts: ctx.ts,
      type: "assistant_message",
      messageId,
      content: contentBlocks,
      complete: true,
    };
    frames.push(assistantFrame);
    frames.push(...toolCallFrames);

    return frames;
  }

  private emitUser(sdk: SdkMessageLike, ctx: EmitContext): Frame[] {
    const frames: Frame[] = [];
    const rawContent = sdk.message?.content;
    const toolUseResult = sdk.tool_use_result;

    // User messages can be either a plain string (from the browser) or
    // a content array (from the SDK echoing tool_result entries back to
    // Claude). Handle both.

    if (typeof rawContent === "string") {
      const frame: UserMessageFrame = {
        id: shortId(),
        seq: ctx.nextSeq(),
        ts: ctx.ts,
        type: "user_message",
        content: [{ type: "text", text: rawContent }],
      };
      frames.push(frame);
      return frames;
    }

    if (!Array.isArray(rawContent)) return frames;

    // Separate the two cases: a user message can carry either direct
    // user text/image content OR tool_result blocks from prior tool calls.
    // In practice these do not mix inside a single SDK message, but we
    // handle both shapes to be safe.
    const userBlocks: UserMessageFrame["content"] = [];
    const toolEndFrames: ToolCallEndFrame[] = [];

    for (const item of rawContent) {
      if (isTextItem(item)) {
        userBlocks.push({ type: "text", text: item.text });
      } else if (isToolResultItem(item)) {
        const endFrame = this.toolResultToEndFrame(item, toolUseResult, ctx);
        if (endFrame) toolEndFrames.push(endFrame);
      }
      // Image / file user content blocks not yet emitted — frontend does
      // not support them on input. Phase B keeps the frame shape ready
      // for when we wire them.
    }

    if (userBlocks.length > 0) {
      const userFrame: UserMessageFrame = {
        id: shortId(),
        seq: ctx.nextSeq(),
        ts: ctx.ts,
        type: "user_message",
        content: userBlocks,
      };
      frames.push(userFrame);
    }
    frames.push(...toolEndFrames);

    return frames;
  }

  private toolResultToEndFrame(
    item: ToolResultContentItem,
    toolUseResult: unknown,
    ctx: EmitContext,
  ): ToolCallEndFrame | null {
    const toolUseId = item.tool_use_id ?? "";
    if (!toolUseId) return null;

    const cached = this.toolUseCache.get(toolUseId);
    const durationMs = cached
      ? Math.max(0, ctx.ts - cached.startedAt)
      : undefined;

    // Compute the output text.
    const output = extractText(item.content);
    const status: ToolCallEndFrame["status"] =
      item.is_error === true ? "error" : "ok";

    // The SDK sometimes attaches a structured payload (toolUseResult)
    // alongside text content — e.g. Edit returns structuredPatch. Pass
    // it through unchanged so the frontend can render rich views.
    const structured =
      toolUseResult && typeof toolUseResult === "object"
        ? (toolUseResult as Json)
        : undefined;

    const frame: ToolCallEndFrame = {
      id: shortId(),
      seq: ctx.nextSeq(),
      ts: ctx.ts,
      type: "tool_call_end",
      toolCallId: toolUseId,
      status,
      output: output.length > 0 ? output : undefined,
      errorOutput:
        status === "error" && output.length > 0 ? output : undefined,
      structured,
      durationMs,
    };
    return frame;
  }

  private emitResult(sdk: SdkMessageLike, ctx: EmitContext): Frame[] {
    // Translate the SDK's `result` message into a SessionMetaFrame
    // carrying token counts and cost. The frame is partial — only
    // fields present on the SDK message are included.
    const frame: SessionMetaFrame = {
      id: shortId(),
      seq: ctx.nextSeq(),
      ts: ctx.ts,
      type: "session_meta",
    };
    if (typeof sdk.num_turns === "number") frame.turns = sdk.num_turns;
    if (typeof sdk.total_cost_usd === "number") frame.costUsd = sdk.total_cost_usd;
    if (typeof sdk.duration_ms === "number") frame.durationMs = sdk.duration_ms;
    if (sdk.usage) {
      if (typeof sdk.usage.input_tokens === "number")
        frame.inputTokens = sdk.usage.input_tokens;
      if (typeof sdk.usage.output_tokens === "number")
        frame.outputTokens = sdk.usage.output_tokens;
      if (typeof sdk.usage.cache_read_input_tokens === "number")
        frame.cacheReadTokens = sdk.usage.cache_read_input_tokens;
      if (typeof sdk.usage.cache_creation_input_tokens === "number")
        frame.cacheCreationTokens = sdk.usage.cache_creation_input_tokens;
    }
    return [frame];
  }

  // -------------------------------------------------------------------------
  // Direct emit helpers — for non-SDK inputs the SessionManager produces
  // (file delivery, interactive prompts, errors, session lifecycle).
  // -------------------------------------------------------------------------

  public emitSessionInitFromManager(
    data: {
      sessionId: string;
      model: string;
      permissionMode: SessionInitFrame["permissionMode"];
      roleFile: string | null;
      workingDirectory: string;
      slashCommands: string[];
    },
    ctx: EmitContext,
  ): SessionInitFrame {
    return {
      id: shortId(),
      seq: ctx.nextSeq(),
      ts: ctx.ts,
      type: "session_init",
      ...data,
      slashCommands: [...data.slashCommands],
    };
  }

  public emitSessionEnd(
    reason: SessionEndFrame["reason"],
    message: string | undefined,
    ctx: EmitContext,
  ): SessionEndFrame {
    return {
      id: shortId(),
      seq: ctx.nextSeq(),
      ts: ctx.ts,
      type: "session_end",
      reason,
      message,
    };
  }

  public emitError(
    category: ErrorFrame["category"],
    message: string,
    scopeId: string | undefined,
    ctx: EmitContext,
  ): ErrorFrame {
    return {
      id: shortId(),
      seq: ctx.nextSeq(),
      ts: ctx.ts,
      type: "error",
      category,
      message,
      scopeId,
    };
  }

  public emitFileDelivery(
    data: {
      path: string;
      filename: string;
      action: "write" | "edit";
      oldString?: string;
      newString?: string;
      toolCallId?: string;
    },
    ctx: EmitContext,
  ): FileDeliveryFrame {
    return {
      id: shortId(),
      seq: ctx.nextSeq(),
      ts: ctx.ts,
      type: "file_delivery",
      ...data,
    };
  }

  public emitInteractivePrompt(
    data: {
      requestId: string;
      kind: InteractivePromptFrame["kind"];
      prompt?: string;
      secret?: boolean;
      placeholder?: string | null;
      action?: string;
      details?: string | null;
      choices?: string[];
    },
    ctx: EmitContext,
  ): InteractivePromptFrame {
    return {
      id: shortId(),
      seq: ctx.nextSeq(),
      ts: ctx.ts,
      type: "interactive_prompt",
      ...data,
    };
  }

  public emitInteractiveResolved(
    requestId: string,
    resolution: InteractiveResolvedFrame["resolution"],
    ctx: EmitContext,
  ): InteractiveResolvedFrame {
    return {
      id: shortId(),
      seq: ctx.nextSeq(),
      ts: ctx.ts,
      type: "interactive_resolved",
      requestId,
      resolution,
    };
  }
}

// ---------------------------------------------------------------------------
// Local helpers (not methods — no emitter state needed)
// ---------------------------------------------------------------------------

function extractTodoItems(input: Json): TodoItemShape[] | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;

  const out: TodoItemShape[] = [];
  for (const t of todos) {
    if (!t || typeof t !== "object") return null;
    const obj = t as Record<string, unknown>;
    if (
      typeof obj.content !== "string" ||
      typeof obj.activeForm !== "string" ||
      typeof obj.status !== "string" ||
      (obj.status !== "pending" &&
        obj.status !== "in_progress" &&
        obj.status !== "completed")
    ) {
      return null;
    }
    out.push({
      content: obj.content,
      activeForm: obj.activeForm,
      status: obj.status,
    });
  }
  return out;
}
