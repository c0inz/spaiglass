# Phase B Specification: Terminal Frame Protocol

**Status:** draft, for discussion
**Owner:** claude (implementation) / john (decisions)
**Depends on:** Phase A terminal improvements (commit 57a7fc9)
**Blocks:** medium-tier items #7 (split markdown), #9 (semantic search),
  #10 (compact/faithful modes), #11 (multimodal rendering), #12 (session
  metadata pin)

---

## Problem

The terminal interpreter is a renderer built on top of `AllMessage`, a flat
chat-oriented shape produced by `UnifiedMessageProcessor`. That processor
was designed for the legacy chat UI, and adapting it to a terminal-style
view means inheriting a pipeline that has already thrown away information
we need:

1. **Content block ordering is lost.** When Claude emits
   `text → tool_use → text → thinking → text`, the processor collapses all
   text into one `ChatMessage.content` string and splits tool/thinking
   blocks off as separate messages. The rendered order no longer matches
   what Claude actually said.

2. **Stable identity is missing.** Rows are keyed by `${timestamp}-${idx}`,
   which is good enough for an append-only chat but brittle for streaming,
   partial updates, and replay. Anything that wants to update a row in
   place (e.g. a tool card transitioning from `running` to `ok`) has no
   stable handle to it.

3. **Tool lifecycle is not first-class.** `tool_use` and `tool_result`
   arrive as separate `SDKMessage` events and the renderer correlates them
   via a side-channel `toolUseCache`. There's no single "this is tool call
   X, here's its lifecycle" object.

4. **Status vs history is conflated.** Transient status (`Reading source
   files…`) and persistent history (the tool card) are emitted from the
   same `processToolResult` and the renderer has to tease them apart.
   Phase A kept both by emitting both, but the coupling makes future
   features like "show only tool activity" awkward.

5. **Batch replay and streaming take different paths.** History processing
   goes through `processMessagesBatch` with `isStreaming=false`, streaming
   goes through `processMessage` with `isStreaming=true`, and the two
   paths render subtly different things (e.g. thinking hits a status line
   live but becomes a `ThinkingMessage` in batch mode). Any fix has to be
   applied twice.

The Phase A improvements (persistent tool cards, real diffs, widget
reconciliation) are all bounded by these limitations. Phase B rebuilds
the contract so the renderer reads a stream of terminal-native frames
directly, and everything downstream becomes straightforward.

---

## Goals

1. Define a single wire format — the "terminal frame protocol" — that the
   backend emits directly from `SessionManager`, without a lossy
   intermediate shape.
2. Preserve Claude's exact content block order inside each assistant turn.
3. Give every logical row a stable, backend-assigned id so the frontend
   can patch in place instead of appending and suppressing.
4. Make tool lifecycle a first-class object with explicit start, update,
   and end frames keyed by `tool_call_id`.
5. Produce one pipeline that handles both live streaming and buffer replay
   — the replay path is just "emit the same frames in order from the ring
   buffer".
6. Keep the legacy chat renderer optional, not load-bearing. It can still
   adapt from these frames later if needed, but the terminal renderer
   stops going through it.

Non-goals for Phase B:
- Rewriting the Claude SDK integration (we still consume `SDKMessage` as
  input to the backend emit path).
- Replacing the React component tree (`TermBox`, `TermToolCard`, etc.) —
  those stay.
- Changing the WebSocket transport itself (still JSON frames, still the
  resume/replay cursor model).

---

## Frame Inventory

All frames share a common envelope:

```ts
interface BaseFrame {
  /** Stable id assigned by the backend. Used as the React key. For frames
   *  that update an existing row, the id matches the earlier frame. */
  id: string;
  /** Monotonic cursor — same semantics as today's lastCursor. */
  seq: number;
  /** Wall-clock ms, for display only. */
  ts: number;
  /** Frame discriminator. */
  type: string;
}
```

### Session lifecycle

```ts
interface SessionInitFrame extends BaseFrame {
  type: "session_init";
  sessionId: string;
  model: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  roleFile: string | null;
  workingDirectory: string;
  slashCommands: string[];
}

interface SessionMetaFrame extends BaseFrame {
  type: "session_meta";
  // Partial update — only fields present are updated.
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

interface SessionEndFrame extends BaseFrame {
  type: "session_end";
  reason: "user" | "error" | "timeout" | "replaced";
  message?: string;
}
```

`session_init` lands once per session. `session_meta` updates the pinned
metadata area (medium-tier item #12). `session_end` tells the frontend to
drop `attached` state (same semantics as today's `session_ended`).

### User messages

```ts
interface UserMessageFrame extends BaseFrame {
  type: "user_message";
  content: UserContentBlock[];
}

type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; dataUrl: string }
  | { type: "file"; path: string; filename: string; sizeBytes?: number };
```

Multimodal-ready from day one (medium-tier item #11). Today's frontend
only sends text, but the shape has the slots.

### Assistant messages with preserved ordering

The core change. One assistant turn becomes *one* `assistant_message`
frame whose `content` is an ordered list of blocks. Streaming is done via
`assistant_message_delta` frames that patch specific block indices.

```ts
interface AssistantMessageFrame extends BaseFrame {
  type: "assistant_message";
  /** Matches the incoming SDK message's id. */
  messageId: string;
  content: AssistantContentBlock[];
  /** True once the model has signaled end-of-turn for this message. */
  complete: boolean;
}

type AssistantContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; toolCallId: string; tool: string; input: Json }
  /** Server-side tool_use_result shown inline (rare — for SDK-native
   *  tools that return inline results). Most tools go through the
   *  tool_call lifecycle frames below instead. */
  | { type: "inline_tool_result"; toolCallId: string; result: Json };

interface AssistantMessageDeltaFrame extends BaseFrame {
  type: "assistant_message_delta";
  /** id === the AssistantMessageFrame this patches. */
  targetId: string;
  /** Position in the content array to patch. */
  blockIndex: number;
  /** Partial block update. For text/thinking blocks, `textAppend` is
   *  concatenated onto the existing block's text. For tool_use, `input`
   *  replaces the current input (handles the SDK's progressive JSON). */
  textAppend?: string;
  input?: Json;
}
```

This is the fix for problem #1. The renderer iterates the `content` array
in order and emits one row per block, preserving Claude's exact sequence.

### Tool call lifecycle

Tools get their own frame type separate from the assistant message they
live inside, because their lifecycle outlives a single content block:

```ts
interface ToolCallStartFrame extends BaseFrame {
  type: "tool_call_start";
  /** Stable id — same value that appears in the AssistantContentBlock's
   *  `toolCallId`. Used to correlate with update/end frames. */
  toolCallId: string;
  tool: string;
  input: Json;
  /** The messageId of the AssistantMessageFrame that called this tool.
   *  Lets the renderer place the card next to the right assistant turn
   *  instead of at the bottom of the transcript. */
  assistantMessageId: string;
}

interface ToolCallUpdateFrame extends BaseFrame {
  type: "tool_call_update";
  toolCallId: string;
  /** Partial progress output, e.g. streaming stdout from Bash. */
  outputAppend?: string;
  errorAppend?: string;
}

interface ToolCallEndFrame extends BaseFrame {
  type: "tool_call_end";
  toolCallId: string;
  status: "ok" | "error" | "interrupted" | "timeout";
  /** Final output if not streamed incrementally. */
  output?: string;
  errorOutput?: string;
  /** Structured payload for rich renderers (e.g. Edit's structuredPatch,
   *  Read's file metadata). Shape is tool-specific. */
  structured?: Json;
  durationMs?: number;
}
```

This is the fix for problems #3 and #4. A tool card renders from the
lifecycle: `start` creates the row in `running` state, `update` patches
output, `end` sets final state. The transient status line becomes a
derived view of the most recent unfinished `tool_call_start` — no
separate channel needed.

### Interactive widgets

Unchanged in spirit from today, but promoted to first-class frames:

```ts
interface InteractivePromptFrame extends BaseFrame {
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

interface InteractiveResolvedFrame extends BaseFrame {
  type: "interactive_resolved";
  /** Targets the InteractivePromptFrame with this id. */
  requestId: string;
  resolution: "accepted" | "approved" | "rejected" | "timeout" | "closed";
}
```

Phase A's `answered` bit becomes an explicit `interactive_resolved` frame
emitted by the backend when the `tool_result` round-trip completes. That
makes replay correct for free — the replay stream just contains both
frames.

### File delivery, plans, todos

These keep their existing semantics but move into the frame envelope:

```ts
interface FileDeliveryFrame extends BaseFrame {
  type: "file_delivery";
  path: string;
  filename: string;
  action: "write" | "edit";
  oldString?: string;
  newString?: string;
  /** Link to the tool call this came from, so the card can be rendered
   *  inside the tool card instead of as a sibling row. */
  toolCallId?: string;
}

interface PlanFrame extends BaseFrame {
  type: "plan";
  toolCallId: string;
  plan: string;
}

interface TodoFrame extends BaseFrame {
  type: "todo";
  toolCallId: string;
  todos: Array<{
    content: string;
    activeForm: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}
```

### Errors

```ts
interface ErrorFrame extends BaseFrame {
  type: "error";
  category: "stream_error" | "tool_error" | "session_error" | "auth_error";
  message: string;
  /** Optional scope — if set, the renderer can badge the specific row
   *  instead of emitting a top-level error card. */
  scopeId?: string;
}
```

---

## Backend Changes

### Where the frames come from

Today: `SessionManager` receives `SDKMessage` events from the Claude
Agent SDK, wraps them in a `sdk_message` WS frame, and ships them to
consumers. `UnifiedMessageProcessor` on the frontend turns them into
`AllMessage`.

Phase B: `SessionManager` (or a new `FrameEmitter` co-located with it)
translates `SDKMessage` into the frame types above *before* sending them
over the wire. The WS frame becomes a tagged union of the Base + specific
frames — no more `sdk_message` passthrough for the terminal path.

Files affected:
- `backend/session/manager.ts` — new emit path; preserves `seq` via the
  existing ring-buffer cursor.
- `backend/session/ws-handler.ts` — updates the frame dispatch switch.
- `backend/session/frame-emitter.ts` (new) — translates SDKMessage →
  frame list, assigns ids, manages tool call correlation.

### ID assignment

Every frame gets a backend-assigned `id`. For frames that correspond to
SDK-provided ids (assistant messages, tool calls), reuse the SDK id. For
frames we synthesize (status updates, session meta), generate a short
random id.

Tool correlation: the SDK already gives us `tool_use_id`. Use it directly
as `toolCallId`. The current `toolUseCache` in `UnifiedMessageProcessor`
moves to the backend `FrameEmitter` where it belongs — the frontend
never has to correlate.

### Replay

The ring buffer today stores `sdk_message` frames with cursor seq. Phase
B stores the already-translated terminal frames. `resumeFromCursor`
becomes a straight replay of frames with `seq > lastCursor`. No
re-translation needed, which means replay and live streaming are
guaranteed to produce identical output — fix for problem #5.

### The old sdk_message path

The legacy chat renderer is still used by anything that consumes
`sdk_message` (DemoPage? historical scripts?). Two options:

**Option A: Dual emission.** The backend emits both `sdk_message` (for
legacy) and the new frame types (for terminal), doubling the WS traffic.
Lower risk, more bytes.

**Option B: Single emission + frontend adapter.** The backend only emits
new frames. Legacy callers that need `sdk_message`-shaped data get a
frontend adapter that rebuilds it from the frames. Higher risk if a
consumer depends on an SDK field we don't preserve.

**Recommendation:** Option B, scoped to whatever still consumes
`sdk_message`. Phase A already proved the terminal path is the only
renderer that matters — the legacy path is likely dead code that can be
deleted. Audit before committing.

---

## Frontend Changes

### New interpreter

`interpreter.tsx` stops taking `AllMessage` and starts taking `Frame[]`.
Every case becomes a one-liner: "given this frame, return a row." The
render functions become genuinely pure because the frame carries
everything they need.

```tsx
export function renderFrame(frame: Frame, opts: RenderOptions): ReactNode {
  switch (frame.type) {
    case "user_message":
      return <UserMessageRow frame={frame} opts={opts} />;
    case "assistant_message":
      return <AssistantMessageRow frame={frame} opts={opts} />;
    case "tool_call_start":
    case "tool_call_update":
    case "tool_call_end":
      // Handled by a lookup below — tool frames collapse into one row.
      return null;
    // ... etc
  }
}
```

### Row assembly

`TerminalChat.tsx` stops mapping `messages.map(msg => <Row key=...>`)
and instead builds a row model from the frame stream. Tool call frames
get collapsed into a single `ToolCallRow` indexed by `toolCallId`. Row
order is derived from the first frame that introduced each row.

```tsx
interface Row {
  key: string;           // stable across updates
  kind: "user" | "assistant" | "tool_call" | "interactive" | "file" | ...;
  // Frame(s) that compose this row. Tool call rows may have start +
  // updates + end all bundled here.
  frames: Frame[];
}
```

`useChatState` stops holding `messages: AllMessage[]` and holds
`frames: Frame[]` plus a derived `rows: Row[]` computed via `useMemo`.
The derivation is pure, so replay and live streaming produce identical
rows.

### Stable keys

Every row uses `row.key = frame.id` of the first frame in the row. React
reconciliation becomes sane: appending a frame to an existing tool call
patches the same row instead of unmounting and remounting. Fix for
problem #2.

### `UnifiedMessageProcessor` removal

Once the frame protocol is live, `UnifiedMessageProcessor` is dead code.
Delete it along with the `AllMessage` union type and the legacy chat
renderer if Option B was chosen.

---

## Migration Path

1. **Land the frame types in `frontend/src/types/frames.ts`.** No behavior
   change — just the shapes and helpers. Reviewable alone.

2. **Write the backend `FrameEmitter` in isolation.** Takes `SDKMessage`
   in, returns `Frame[]` out. Unit-tested against recorded SDK traces.
   No wiring yet.

3. **Dual-emit from `SessionManager`.** For one release, emit both
   `sdk_message` (legacy) and the new frames. The frontend still reads
   the legacy path. This catches bugs in the emitter without breaking
   anything.

4. **Build the new interpreter behind `?renderer=frames`.** Same trick
   as the original terminal cutover. Runs side-by-side with the current
   terminal renderer; you can A/B them in the browser.

5. **Cut over.** Drop the query flag, delete `UnifiedMessageProcessor`
   and `AllMessage`, delete the legacy chat renderer if applicable.

Each step is independently reverting-safe.

---

## What Phase B Unlocks

Once stable ids and structured frames exist, the medium-tier items
become small:

- **#7 Split markdown into pluggable blocks.** Each `AssistantContentBlock`
  renders through a dispatch map. Adding a new block type (e.g. a chart
  widget) is a one-file addition.
- **#8 ANSI/long-command progress handling.** `tool_call_update` already
  carries `outputAppend`. Detecting the "last live line" is just
  `lastLine(output)`.
- **#9 Semantic transcript search.** Filter by frame type:
  `frames.filter(f => f.type === "tool_call_end")` for "file edits only".
- **#10 Compact vs faithful mode.** Compact mode hides
  `thinking` content blocks and collapses tool cards more aggressively.
  Faithful mode preserves every frame. Same data, two renderers.
- **#11 Multimodal user messages.** The `UserContentBlock` union already
  has `image` and `file` arms — just wire the dispatch.
- **#12 Pinned session metadata.** `SessionInitFrame` + `SessionMetaFrame`
  feed a pinned header panel; no scrollback allocation needed.

---

## Open Questions

1. **Option A vs B for legacy `sdk_message` emission.** Needs an audit of
   what still depends on the legacy path.
2. **Do we keep `ChatMessage`-shaped data on disk?** The existing session
   save format stores messages somewhere — does Phase B change the disk
   format, or does the backend translate from Frame[] → ChatMessage[]
   for persistence?
3. **Tool input streaming.** The SDK delivers tool_use input as a single
   JSON object, but larger inputs (e.g. Write with a full file body) can
   be multi-kilobyte. Should `tool_call_start.input` be optional and
   `tool_call_update.inputAppend` carry the body, or do we live with a
   single big frame?
4. **Error scoping.** `ErrorFrame.scopeId` assumes errors are tied to
   specific rows. Some errors (auth, session) aren't — is a separate
   top-level error frame better?
5. **Should the `prompt_secret` flow tie into the SecretsPanel?** Today
   a submitted secret is handed to Claude and discarded. If the frame
   protocol includes a "suggested name" on `interactive_prompt`, we
   could let the user check a box to persist it via `/api/secrets`. Not
   strictly a frame-protocol question, but natural to consider here.
6. **Timeline for the legacy chat renderer.** Deletion candidate, or
   keep as a fallback?

---

## Effort estimate

Rough, assuming no surprises:

- Step 1 (frame types): half a day.
- Step 2 (backend emitter + unit tests): 1–2 days.
- Step 3 (dual emission): half a day.
- Step 4 (new interpreter + row assembly): 2–3 days.
- Step 5 (cutover + cleanup): half a day.

Total: **4.5–6.5 days** of focused work, spread across as many sessions
as needed. Each step is committable and reversible on its own.
