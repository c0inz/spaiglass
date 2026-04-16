/**
 * Terminal Frame Protocol (Phase B)
 *
 * This is the wire format the backend emits for the terminal renderer.
 * Every frame has a stable id assigned by the backend, a monotonic `seq`
 * cursor (same semantics as today's ring-buffer cursor), and a type
 * discriminator. The frontend renders one row per frame (or collapses
 * related frames into a single row via `toolCallId`), using `frame.id`
 * as the React key.
 *
 * See research/SPEC-PHASE-B-TERMINAL-FRAME-PROTOCOL.md for design rationale.
 *
 * Invariants:
 *   - `id` is stable. Frames that update a previously-sent row repeat
 *     that row's first `id` in a `targetId` field (AssistantMessageDelta)
 *     or match via `toolCallId` / `requestId`.
 *   - `seq` is monotonically increasing across the entire session.
 *   - `ts` is wall-clock ms; for display only, do not sort by it.
 */

// ---------------------------------------------------------------------------
// Base envelope
// ---------------------------------------------------------------------------

/** JSON-compatible value type used for tool inputs and structured results. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export interface BaseFrame {
  /** Stable id assigned by the backend. Used as the React key. */
  id: string;
  /** Monotonic cursor — same semantics as today's lastCursor. */
  seq: number;
  /** Wall-clock ms, for display only. */
  ts: number;
  /** Frame discriminator. */
  type: string;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface SessionInitFrame extends BaseFrame {
  type: "session_init";
  sessionId: string;
  model: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  roleFile: string | null;
  workingDirectory: string;
  slashCommands: string[];
}

/**
 * Partial update to the pinned session metadata area (token counts, cost,
 * turn counter). Any field present is updated; omitted fields are left
 * alone by the renderer.
 */
export interface SessionMetaFrame extends BaseFrame {
  type: "session_meta";
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

export interface SessionEndFrame extends BaseFrame {
  type: "session_end";
  reason: "user" | "error" | "timeout" | "replaced";
  message?: string;
}

// ---------------------------------------------------------------------------
// User messages (multimodal-ready)
// ---------------------------------------------------------------------------

export type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; dataUrl: string }
  | { type: "file"; path: string; filename: string; sizeBytes?: number };

export interface UserMessageFrame extends BaseFrame {
  type: "user_message";
  content: UserContentBlock[];
}

// ---------------------------------------------------------------------------
// Assistant messages (with preserved content-block ordering)
// ---------------------------------------------------------------------------

/**
 * One block within an assistant turn. The order of these blocks inside
 * `AssistantMessageFrame.content` matches the order Claude emitted them.
 *
 * - `text` / `thinking`: leaf content, rendered as prose.
 * - `tool_use`: reference to a tool call. The actual lifecycle (running,
 *   output, completion) is carried by the ToolCall*Frame series, keyed
 *   by `toolCallId`. The renderer uses this block to anchor the tool card
 *   inline at the right position within the assistant turn.
 * - `inline_tool_result`: rare — for SDK-native tools that return results
 *   inline without going through the normal lifecycle.
 */
export type AssistantContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; toolCallId: string; tool: string; input: Json }
  | { type: "inline_tool_result"; toolCallId: string; result: Json };

export interface AssistantMessageFrame extends BaseFrame {
  type: "assistant_message";
  /** Matches the incoming SDK message's id. */
  messageId: string;
  content: AssistantContentBlock[];
  /** True once the model has signaled end-of-turn for this message. */
  complete: boolean;
}

/**
 * Streaming update to a specific block within an AssistantMessageFrame.
 * Patches `content[blockIndex]` by appending text (for text/thinking) or
 * replacing input (for tool_use, since the SDK delivers progressive JSON
 * for streaming tool inputs).
 */
export interface AssistantMessageDeltaFrame extends BaseFrame {
  type: "assistant_message_delta";
  /** id === the AssistantMessageFrame this patches. */
  targetId: string;
  /** Position in the content array to patch. */
  blockIndex: number;
  /** For text/thinking blocks, concatenated onto the block's text. */
  textAppend?: string;
  /** For tool_use blocks, replaces the current input. */
  input?: Json;
}

// ---------------------------------------------------------------------------
// Tool call lifecycle
// ---------------------------------------------------------------------------

export interface ToolCallStartFrame extends BaseFrame {
  type: "tool_call_start";
  /** Stable id — same value as the AssistantContentBlock's `toolCallId`. */
  toolCallId: string;
  tool: string;
  input: Json;
  /**
   * The messageId of the AssistantMessageFrame that called this tool.
   * Lets the renderer anchor the card inside the correct assistant turn.
   */
  assistantMessageId: string;
}

export interface ToolCallUpdateFrame extends BaseFrame {
  type: "tool_call_update";
  toolCallId: string;
  /** Partial progress output, e.g. streaming stdout from Bash. */
  outputAppend?: string;
  errorAppend?: string;
}

export interface ToolCallEndFrame extends BaseFrame {
  type: "tool_call_end";
  toolCallId: string;
  status: "ok" | "error" | "interrupted" | "timeout";
  /** Final output if not streamed incrementally. */
  output?: string;
  errorOutput?: string;
  /**
   * Structured payload for rich renderers (Edit's structuredPatch,
   * Read's file metadata, etc.). Shape is tool-specific.
   */
  structured?: Json;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Interactive widgets
// ---------------------------------------------------------------------------

export interface InteractivePromptFrame extends BaseFrame {
  type: "interactive_prompt";
  requestId: string;
  kind: "prompt_secret" | "tool_permission" | "request_choice";
  prompt?: string;
  secret?: boolean;
  placeholder?: string | null;
  action?: string;
  details?: string | null;
  choices?: string[];
}

export interface InteractiveResolvedFrame extends BaseFrame {
  type: "interactive_resolved";
  /** Targets the InteractivePromptFrame with this requestId. */
  requestId: string;
  resolution: "accepted" | "approved" | "rejected" | "timeout" | "closed";
}

// ---------------------------------------------------------------------------
// File delivery, plans, todos
// ---------------------------------------------------------------------------

export interface FileDeliveryFrame extends BaseFrame {
  type: "file_delivery";
  path: string;
  filename: string;
  action: "write" | "edit";
  oldString?: string;
  newString?: string;
  /**
   * Link to the tool call this came from, so the card can be rendered
   * inside the tool card instead of as a sibling row.
   */
  toolCallId?: string;
}

export interface PlanFrame extends BaseFrame {
  type: "plan";
  toolCallId: string;
  plan: string;
}

export interface TodoItemShape {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoFrame extends BaseFrame {
  type: "todo";
  toolCallId: string;
  todos: TodoItemShape[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ErrorFrame extends BaseFrame {
  type: "error";
  /**
   * Category of the frame:
   *   - stream_error / tool_error / session_error / auth_error: real errors
   *     rendered as a red error card.
   *   - notice: client-synthesized informational notice (e.g. permission-mode
   *     announcement, "/reset started", viewer read-only hint). Rendered as
   *     a neutral notice card — same row type so the reducer stays simple,
   *     different visual so the user doesn't see a red error for a benign
   *     status message.
   */
  category:
    | "stream_error"
    | "tool_error"
    | "session_error"
    | "auth_error"
    | "notice";
  message: string;
  /**
   * Optional scope. If set, the renderer badges the specific row instead
   * of emitting a top-level error card. Session-wide errors (auth, stream
   * died) omit `scopeId`.
   */
  scopeId?: string;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type Frame =
  | SessionInitFrame
  | SessionMetaFrame
  | SessionEndFrame
  | UserMessageFrame
  | AssistantMessageFrame
  | AssistantMessageDeltaFrame
  | ToolCallStartFrame
  | ToolCallUpdateFrame
  | ToolCallEndFrame
  | InteractivePromptFrame
  | InteractiveResolvedFrame
  | FileDeliveryFrame
  | PlanFrame
  | TodoFrame
  | ErrorFrame;

export type FrameType = Frame["type"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Narrow a Frame to a specific type. */
export function isFrameType<T extends FrameType>(
  frame: Frame,
  type: T,
): frame is Extract<Frame, { type: T }> {
  return frame.type === type;
}

/**
 * Type guard for "this frame introduces a new row" vs "this frame patches
 * an existing row". Useful for row assembly on the frontend.
 */
export function isRowAnchorFrame(frame: Frame): boolean {
  switch (frame.type) {
    case "user_message":
    case "assistant_message":
    case "tool_call_start":
    case "interactive_prompt":
    case "file_delivery":
    case "plan":
    case "todo":
    case "error":
      return true;
    // These patch existing rows rather than introducing new ones.
    case "assistant_message_delta":
    case "tool_call_update":
    case "tool_call_end":
    case "interactive_resolved":
    case "session_init":
    case "session_meta":
    case "session_end":
      return false;
  }
}
