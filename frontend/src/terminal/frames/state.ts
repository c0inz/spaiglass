/**
 * Phase B — frame-native state reducer.
 *
 * Pure. No React. Consumes `Frame` values one at a time and produces a
 * `FrameState` shape the renderer can diff against. The reducer is the
 * single source of truth for how frames compose into rows:
 *
 *   - live streaming  → call applyFrame(state, frame) per WS message
 *   - history replay  → call buildFrameState(frames) on the full array
 *
 * Both paths go through the same function, so replay and streaming produce
 * identical row output by construction (spec problem #5).
 *
 * Rendering model:
 *
 *   Assistant content-block order is preserved inside the row itself —
 *   `AssistantRow.content` is the ordered array of text / thinking /
 *   tool_use blocks as Claude emitted them. Tool cards render INLINE at
 *   the position of their tool_use block via a lookup in `toolCalls`,
 *   keyed by `toolCallId`. This is the main correctness win of Phase B:
 *   text → tool → text → tool lands in scrollback in the order Claude
 *   actually said it, instead of all-text-then-all-tools.
 *
 *   Plan, Todo, FileDelivery, Interactive, and Error frames still become
 *   their own standalone rows — they're specialized scrollback entries,
 *   not part of the assistant's content-block stream.
 */

import type {
  Frame,
  AssistantContentBlock,
  UserMessageFrame,
  FileDeliveryFrame,
  PlanFrame,
  TodoFrame,
  InteractivePromptFrame,
  InteractiveResolvedFrame,
  ErrorFrame,
  Json,
} from "../../../../shared/frames";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface BaseRow {
  /** Stable React key — matches the id of the anchor frame. */
  key: string;
  /** Monotonic seq of the anchor frame. Rows are rendered in seq order. */
  seq: number;
  /** Wall-clock ms of the anchor frame. Display only. */
  ts: number;
}

export interface UserRow extends BaseRow {
  kind: "user";
  frame: UserMessageFrame;
}

export interface AssistantRow extends BaseRow {
  kind: "assistant";
  /** Matches the frame's messageId. Tool_use blocks reference this via
   *  `assistantMessageId` in ToolCallState. */
  messageId: string;
  /** Ordered content blocks — preserved from the original AssistantMessageFrame.
   *  Deltas may patch these in place. */
  content: AssistantContentBlock[];
  /** True once the SDK has signaled end-of-turn. */
  complete: boolean;
}

export interface FileDeliveryRow extends BaseRow {
  kind: "file_delivery";
  frame: FileDeliveryFrame;
}

export interface PlanRow extends BaseRow {
  kind: "plan";
  frame: PlanFrame;
}

export interface TodoRow extends BaseRow {
  kind: "todo";
  frame: TodoFrame;
}

export interface InteractiveRow extends BaseRow {
  kind: "interactive";
  prompt: InteractivePromptFrame;
  resolved: InteractiveResolvedFrame | null;
}

export interface ErrorRow extends BaseRow {
  kind: "error";
  frame: ErrorFrame;
}

export type Row =
  | UserRow
  | AssistantRow
  | FileDeliveryRow
  | PlanRow
  | TodoRow
  | InteractiveRow
  | ErrorRow;

// ---------------------------------------------------------------------------
// Tool call state (embedded in AssistantRow rendering)
// ---------------------------------------------------------------------------

export interface ToolCallState {
  toolCallId: string;
  tool: string;
  input: Json;
  assistantMessageId: string;
  status: "running" | "ok" | "error" | "interrupted" | "timeout";
  /** Accumulated stdout across start → update → end. */
  output: string;
  /** Accumulated stderr across start → update → end. */
  errorOutput: string;
  /** Structured payload from tool_call_end (e.g. Edit's structuredPatch). */
  structured: Json | null;
  durationMs: number | null;
  /** seq of the start frame — used for stable display ordering if ever
   *  a tool_call is rendered standalone (currently never — but kept so
   *  replay produces deterministic output in tests). */
  seq: number;
}

// ---------------------------------------------------------------------------
// Session snapshot
// ---------------------------------------------------------------------------

export interface SessionSnapshot {
  sessionId: string | null;
  model: string | null;
  permissionMode:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | null;
  roleFile: string | null;
  workingDirectory: string | null;
  slashCommands: string[];
  /** Aggregated stats from session_meta frames. */
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  /** True once we've seen session_init and not yet session_end. */
  attached: boolean;
  /** Present after session_end. */
  endReason:
    | "user"
    | "error"
    | "timeout"
    | "replaced"
    | null;
}

function emptySession(): SessionSnapshot {
  return {
    sessionId: null,
    model: null,
    permissionMode: null,
    roleFile: null,
    workingDirectory: null,
    slashCommands: [],
    turns: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
    durationMs: null,
    attached: false,
    endReason: null,
  };
}

// ---------------------------------------------------------------------------
// Top-level state
// ---------------------------------------------------------------------------

export interface FrameState {
  rows: Row[];
  /** Tool calls keyed by toolCallId. Embedded inline in assistant rows at
   *  render time via a lookup on this map. */
  toolCalls: Map<string, ToolCallState>;
  /** Session snapshot — fed by session_init / session_meta / session_end. */
  session: SessionSnapshot;
  /** Highest seq we've consumed. Callers can use this to detect dropped
   *  frames (backend → replay gap). */
  lastSeq: number;
}

export function initialFrameState(): FrameState {
  return {
    rows: [],
    toolCalls: new Map(),
    session: emptySession(),
    lastSeq: 0,
  };
}

/**
 * Safety net: mark any tool calls still stuck in "running" as "ok". Called when
 * a turn or session ends — if the turn is done, every tool must be done too.
 * Covers edge cases like dropped WS connections or relay hiccups.
 */
function finalizeRunningTools(
  toolCalls: Map<string, ToolCallState>,
): Map<string, ToolCallState> {
  let changed = false;
  const next = new Map(toolCalls);
  for (const [id, call] of next) {
    if (call.status === "running") {
      next.set(id, { ...call, status: "ok" });
      changed = true;
    }
  }
  return changed ? next : toolCalls;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Apply one frame to the current state. Returns a NEW state object if
 * anything changed, or the same reference if the frame was a no-op.
 *
 * Immutability: `rows` and `toolCalls` are replaced whenever they change so
 * React.memo / useMemo consumers can rely on referential equality for cheap
 * change detection. Unchanged branches return the previous reference.
 */
export function applyFrame(state: FrameState, frame: Frame): FrameState {
  // Deduplication: frames with a real seq (> 0) that we've already seen
  // are replays from a WS reconnect resume. Skip them — the rows they
  // produced are already in state. Client-synthesized frames (seq === 0)
  // always pass through since they're never replayed.
  if (frame.seq > 0 && frame.seq <= state.lastSeq) {
    return state;
  }

  const lastSeq = frame.seq > state.lastSeq ? frame.seq : state.lastSeq;

  switch (frame.type) {
    case "session_init":
      return {
        ...state,
        lastSeq,
        session: {
          ...state.session,
          sessionId: frame.sessionId || state.session.sessionId,
          model: frame.model || state.session.model,
          permissionMode: frame.permissionMode,
          roleFile: frame.roleFile,
          workingDirectory: frame.workingDirectory,
          slashCommands: [...frame.slashCommands],
          attached: true,
          endReason: null,
        },
      };

    case "session_meta":
      return {
        ...state,
        lastSeq,
        toolCalls: finalizeRunningTools(state.toolCalls),
        session: {
          ...state.session,
          turns: frame.turns ?? state.session.turns,
          inputTokens: frame.inputTokens ?? state.session.inputTokens,
          outputTokens: frame.outputTokens ?? state.session.outputTokens,
          cacheReadTokens:
            frame.cacheReadTokens ?? state.session.cacheReadTokens,
          cacheCreationTokens:
            frame.cacheCreationTokens ?? state.session.cacheCreationTokens,
          costUsd: frame.costUsd ?? state.session.costUsd,
          durationMs: frame.durationMs ?? state.session.durationMs,
        },
      };

    case "session_end":
      return {
        ...state,
        lastSeq,
        toolCalls: finalizeRunningTools(state.toolCalls),
        session: {
          ...state.session,
          attached: false,
          endReason: frame.reason,
        },
      };

    case "user_message": {
      const row: UserRow = {
        kind: "user",
        key: frame.id,
        seq: frame.seq,
        ts: frame.ts,
        frame,
      };
      return { ...state, lastSeq, rows: [...state.rows, row] };
    }

    case "assistant_message": {
      // Check if a row with this messageId already exists.
      const existingIdx = state.rows.findIndex(
        (r) => r.kind === "assistant" && r.messageId === frame.messageId,
      );
      if (existingIdx >= 0) {
        const existing = state.rows[existingIdx] as AssistantRow;
        if (!existing.complete) {
          // Row is still streaming — update in place (e.g. content blocks
          // growing as the SDK sends partial then final content).
          const row: AssistantRow = {
            kind: "assistant",
            key: existing.key,
            seq: existing.seq,
            ts: existing.ts,
            messageId: frame.messageId,
            content: [...frame.content],
            complete: frame.complete,
          };
          const nextRows = state.rows.slice();
          nextRows[existingIdx] = row;
          return { ...state, lastSeq, rows: nextRows };
        }
        // Existing row is ALREADY complete. This is a new assistant turn
        // that happens to share the same messageId (the Claude Code SDK
        // reuses message IDs across turns within a session). Append as a
        // NEW row so previous text isn't destroyed. Without this, every
        // assistant turn replaces the last — the user sees 10 messages
        // appear and disappear, with only the final one surviving.
      }
      const row: AssistantRow = {
        kind: "assistant",
        key: `${frame.id}-${lastSeq}`,
        seq: frame.seq,
        ts: frame.ts,
        messageId: frame.messageId,
        content: [...frame.content],
        complete: frame.complete,
      };
      return { ...state, lastSeq, rows: [...state.rows, row] };
    }

    case "assistant_message_delta": {
      // Patch the matching assistant row in place. Text/thinking blocks
      // get their text appended; tool_use blocks get their input replaced.
      // If the target row doesn't exist, drop the delta — there's nothing
      // to patch (probably a mid-replay reorder; the next full assistant
      // message will re-seed).
      // Find the LAST matching row — with the duplicate-messageId fix
      // above, there may be multiple rows sharing a messageId. Deltas
      // target the most recent one.
      let idx = -1;
      for (let i = state.rows.length - 1; i >= 0; i--) {
        const r = state.rows[i];
        if (r.kind === "assistant" && r.messageId === frame.targetId) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return { ...state, lastSeq };
      const row = state.rows[idx] as AssistantRow;
      if (frame.blockIndex < 0 || frame.blockIndex >= row.content.length) {
        return { ...state, lastSeq };
      }
      const nextContent = row.content.slice();
      const block = nextContent[frame.blockIndex];
      if (
        (block.type === "text" || block.type === "thinking") &&
        typeof frame.textAppend === "string"
      ) {
        nextContent[frame.blockIndex] = {
          type: block.type,
          text: block.text + frame.textAppend,
        };
      } else if (block.type === "tool_use" && frame.input !== undefined) {
        nextContent[frame.blockIndex] = {
          type: "tool_use",
          toolCallId: block.toolCallId,
          tool: block.tool,
          input: frame.input,
        };
      } else {
        // Nothing to apply — leave the row alone.
        return { ...state, lastSeq };
      }
      const nextRow: AssistantRow = { ...row, content: nextContent };
      const nextRows = state.rows.slice();
      nextRows[idx] = nextRow;
      return { ...state, lastSeq, rows: nextRows };
    }

    case "tool_call_start": {
      const call: ToolCallState = {
        toolCallId: frame.toolCallId,
        tool: frame.tool,
        input: frame.input,
        assistantMessageId: frame.assistantMessageId,
        status: "running",
        output: "",
        errorOutput: "",
        structured: null,
        durationMs: null,
        seq: frame.seq,
      };
      const nextToolCalls = new Map(state.toolCalls);
      nextToolCalls.set(frame.toolCallId, call);
      return { ...state, lastSeq, toolCalls: nextToolCalls };
    }

    case "tool_call_update": {
      const call = state.toolCalls.get(frame.toolCallId);
      if (!call) return { ...state, lastSeq };
      const nextCall: ToolCallState = {
        ...call,
        output: frame.outputAppend ? call.output + frame.outputAppend : call.output,
        errorOutput: frame.errorAppend
          ? call.errorOutput + frame.errorAppend
          : call.errorOutput,
      };
      const nextToolCalls = new Map(state.toolCalls);
      nextToolCalls.set(frame.toolCallId, nextCall);
      return { ...state, lastSeq, toolCalls: nextToolCalls };
    }

    case "tool_call_end": {
      const call = state.toolCalls.get(frame.toolCallId);
      if (!call) return { ...state, lastSeq };
      const nextCall: ToolCallState = {
        ...call,
        status: frame.status,
        output: frame.output ?? call.output,
        errorOutput: frame.errorOutput ?? call.errorOutput,
        structured: frame.structured ?? null,
        durationMs: frame.durationMs ?? null,
      };
      const nextToolCalls = new Map(state.toolCalls);
      nextToolCalls.set(frame.toolCallId, nextCall);
      return { ...state, lastSeq, toolCalls: nextToolCalls };
    }

    case "interactive_prompt": {
      const row: InteractiveRow = {
        kind: "interactive",
        key: frame.id,
        seq: frame.seq,
        ts: frame.ts,
        prompt: frame,
        resolved: null,
      };
      return { ...state, lastSeq, rows: [...state.rows, row] };
    }

    case "interactive_resolved": {
      // Find the matching prompt row by requestId and attach the resolution.
      // Leaves untouched if we never saw the prompt (stale replay).
      const idx = state.rows.findIndex(
        (r) =>
          r.kind === "interactive" && r.prompt.requestId === frame.requestId,
      );
      if (idx < 0) return { ...state, lastSeq };
      const row = state.rows[idx] as InteractiveRow;
      const nextRow: InteractiveRow = { ...row, resolved: frame };
      const nextRows = state.rows.slice();
      nextRows[idx] = nextRow;
      return { ...state, lastSeq, rows: nextRows };
    }

    case "file_delivery": {
      const row: FileDeliveryRow = {
        kind: "file_delivery",
        key: frame.id,
        seq: frame.seq,
        ts: frame.ts,
        frame,
      };
      return { ...state, lastSeq, rows: [...state.rows, row] };
    }

    case "plan": {
      const row: PlanRow = {
        kind: "plan",
        key: frame.id,
        seq: frame.seq,
        ts: frame.ts,
        frame,
      };
      return { ...state, lastSeq, rows: [...state.rows, row] };
    }

    case "todo": {
      // TodoWrite is idempotent within a tool call — successive emissions
      // replace the same card rather than stacking. Find any existing Todo
      // row for this toolCallId and replace it; otherwise append.
      const idx = state.rows.findIndex(
        (r) => r.kind === "todo" && r.frame.toolCallId === frame.toolCallId,
      );
      const row: TodoRow = {
        kind: "todo",
        key: frame.id,
        seq: frame.seq,
        ts: frame.ts,
        frame,
      };
      if (idx >= 0) {
        const nextRows = state.rows.slice();
        nextRows[idx] = row;
        return { ...state, lastSeq, rows: nextRows };
      }
      return { ...state, lastSeq, rows: [...state.rows, row] };
    }

    case "error": {
      const row: ErrorRow = {
        kind: "error",
        key: frame.id,
        seq: frame.seq,
        ts: frame.ts,
        frame,
      };
      return { ...state, lastSeq, rows: [...state.rows, row] };
    }
  }
}

/**
 * Build a full FrameState from an ordered array of frames. Used for
 * history replay and as a test helper.
 */
export function buildFrameState(frames: Frame[]): FrameState {
  let state = initialFrameState();
  for (const frame of frames) state = applyFrame(state, frame);
  const finalized = finalizeRunningTools(state.toolCalls);
  if (finalized !== state.toolCalls) {
    state = { ...state, toolCalls: finalized };
  }
  return state;
}

// ---------------------------------------------------------------------------
// Render-time suppression rules
// ---------------------------------------------------------------------------

/**
 * Whether an assistant content block should render an inline tool card.
 *
 * TodoWrite and ExitPlanMode have their own specialized top-level rows
 * (PlanRow / TodoRow) that carry the rich payload. Showing a redundant
 * tool card inline would be visual noise.
 */
export function shouldRenderInlineToolCard(
  block: AssistantContentBlock,
): boolean {
  if (block.type !== "tool_use") return false;
  if (block.tool === "TodoWrite" || block.tool === "ExitPlanMode") return false;
  return true;
}

/**
 * Whether a tool call should render its output card (expanded or collapsed).
 *
 * We preserve the "bug #3" rule from the legacy adapter: successful
 * tool results are noise for the end user — the transient status line
 * already showed what ran. Only show expanded output when the tool
 * errored. Running calls still show a spinner.
 */
export function shouldShowToolOutput(call: ToolCallState): boolean {
  if (call.status === "running") return true;
  return call.status !== "ok";
}
