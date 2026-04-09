# Persistent Session Architecture for Spyglass

## Problem

Spyglass currently uses one-shot HTTP requests per message. Each time the user sends a message, the backend spawns a new Claude CLI process in `--print` mode — one prompt in, one response out, process exits. Session continuity relies on `--resume` which reloads the full conversation from disk each time.

This means:
- No persistent session — every message spawns a new CLI process
- Slash commands (`/compact`, `/clear`, `/model`, `/think`, etc.) don't work
- Can't send messages while Claude is thinking
- No interrupt support — only HTTP abort
- No access to Claude Code's native interactive features

## SDK Capabilities (Verified from Source)

The Claude Code SDK (`@anthropic-ai/claude-code`) supports true interactive sessions via `AsyncIterable<SDKUserMessage>`:

### How It Works

When `query()` receives an async iterable as the prompt (instead of a string), the SDK:

1. Spawns the CLI with `--input-format stream-json --output-format stream-json`
2. Keeps stdin/stdout open for the life of the session
3. Reads from the iterable lazily — blocks on `for await`, waiting for each `yield`
4. Writes each yielded `SDKUserMessage` as JSON to the CLI's stdin
5. Reads response messages from stdout as NDJSON
6. Yields response messages continuously to the consumer
7. Session ends when the iterable completes (stdin closes, CLI exits)

### Key SDK Methods (Stream-JSON Mode Only)

- **`query.interrupt()`** — Sends a control request to stop the CLI mid-response. Session stays alive.
- **`query.setPermissionMode(mode)`** — Changes permission behavior without restarting.
- **`query.supportedCommands()`** — Returns the list of available slash commands from the CLI.

### Slash Commands

Slash commands are handled by the CLI, not the SDK. The init message includes `slash_commands: string[]`. When you yield a user message starting with `/`, the CLI interprets it as a command. Available commands include `/compact`, `/clear`, `/cost`, `/model`, `/think`, `/memory`, etc.

### Message Format

The `SDKUserMessage` passed via the iterable:

```typescript
{
  type: "user",
  message: {
    role: "user",
    content: string | ContentBlock[]  // text, or mixed text + image blocks
  },
  parent_tool_use_id: null,
  uuid: UUID,        // optional but recommended
  session_id: string // required
}
```

For images, `ContentBlock[]` includes:

```typescript
{
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp",
    data: string  // base64 encoded
  }
}
```

## Target Architecture

### Data Flow

```
Browser                    Backend                         CLI Process
  |                          |                                |
  |--- WebSocket connect --->|                                |
  |                          |-- query({ prompt: iterable })--|
  |                          |          (stdin open)          |
  |                          |<-- init msg (slash_commands) --|
  |<-- init msg -------------|                                |
  |                          |                                |
  |--- "analyze this" ------>|-- yield SDKUserMessage ------->|
  |                          |<-- assistant msg (streaming) --|
  |<-- assistant msg --------|                                |
  |<-- tool msg -------------|<-- tool_use msg ---------------|
  |<-- tool result ----------|<-- tool_result msg ------------|
  |<-- result msg ---------- |<-- result msg -----------------|
  |                          |       (turn complete)          |
  |                          |    (awaits next yield...)      |
  |                          |                                |
  |--- "/compact" ---------->|-- yield SDKUserMessage ------->|
  |                          |<-- CLI handles /compact -------|
  |<-- result msg ---------- |                                |
  |                          |                                |
  |--- [stop button] ------->|-- query.interrupt() ---------->|
  |                          |<-- remaining msgs, then done --|
  |                          |                                |
  |--- WebSocket close ----->|-- iterable returns ----------->|
  |                          |          (stdin closes)        |
  |                          |<-- CLI exits ------------------|
```

### Backend Components

**1. SessionManager** — One running `query()` per active session.

- A message queue (async channel) backs the iterable. WebSocket handler pushes messages to the queue, the SDK's `streamInput()` reads from it.
- Stores the `Query` object so we can call `interrupt()` and `setPermissionMode()`.
- Tracks session state: initializing, active, interrupted, closed.
- Cleanup: timeout after inactivity, kill child process on disconnect.

**2. WebSocket Endpoint** — Replaces the per-message HTTP `/api/chat` endpoint.

- Hono supports WebSocket via `hono/ws` adapter.
- Single persistent connection per browser session.
- Inbound messages from browser: user messages, slash commands, interrupt signals, permission mode changes, file attachments.
- Outbound messages to browser: all SDK messages in the same NDJSON format currently used.

**3. Attachment Handling** — Files uploaded via existing `/api/upload` endpoint.

- Text files: read content, inline into the text prompt string.
- Images: include as base64 content blocks in the `SDKUserMessage.message.content` array.
- Works naturally since we control the `SDKUserMessage` construction.

### Frontend Components

**4. WebSocket Client** — Replaces `fetch()` + NDJSON reader.

- Connects on session start, stays open.
- Sends JSON messages for user input, commands, control signals.
- Receives SDK messages and feeds them to the existing `UnifiedMessageProcessor` (no changes needed to message parsing/rendering).

**5. Slash Command Dropdown** — Triggered when user types `/` in the input.

- Same UI pattern as the existing `@` file mention dropdown.
- Command list comes from the init message's `slash_commands` field.
- Filterable, keyboard navigable.

**6. Interrupt** — Stop button calls `interrupt()` via WebSocket control message.

- Actually interrupts the CLI mid-response (not just an HTTP abort).
- Session stays alive, ready for the next message.

**7. Queue-While-Thinking** — Messages sent during a response get queued.

- The async iterable holds them until the current turn completes.
- Then yields the next one immediately.
- CLI processes them in order.

## Hurdles

| Hurdle | Difficulty | Notes |
|---|---|---|
| WebSocket layer | Medium | Need WS endpoint on Hono, WS client on frontend. Hono supports WS via `hono/ws`. |
| Session lifecycle | Medium | Start, resume, crash recovery, timeout, tab close, reconnect. Each session holds a live child process. |
| Frontend refactor | Medium | Replace `fetch` + NDJSON with WS message handler. Message processing pipeline stays the same. |
| Backward compatibility | Low | Can keep HTTP endpoint working alongside WS during migration. |
| Multiple tabs | Medium | Two tabs on same session fight over one CLI stdin. Need tab locking or session-per-tab. |
| Resource cleanup | Medium | Each session = one child process. Need aggressive timeouts for abandoned sessions. |
| Slash command UI | Low | Same pattern as existing `@` mention dropdown. |
| Resume sessions | Low | Pass `resume: sessionId` in SDK options. Works with stream-json mode. |
| File attachments with images | Low | Content blocks work naturally in SDKUserMessage. |

## Migration Path

1. **Phase A:** Build SessionManager + WebSocket endpoint alongside existing HTTP. Both work simultaneously.
2. **Phase B:** Move frontend to WebSocket transport. Message format stays identical — only the delivery mechanism changes.
3. **Phase C:** Add slash command dropdown, interrupt button, queue-while-thinking.
4. **Phase D:** Remove old HTTP chat endpoint.

## SDK Source References

- `sdk.mjs` line 6373: CLI args construction (`--input-format stream-json`)
- `sdk.mjs` lines 7011-7025: `streamInput()` — async iterable consumption
- `sdk.mjs` lines 6966-6981: `interrupt()` and `setPermissionMode()`
- `sdk.mjs` lines 7002-7009: `supportedCommands()`
- `sdk.mjs` lines 6586-6592: `readMessages()` — NDJSON parsing from CLI stdout
- `sdk.d.ts` lines 240-254: `SDKSystemMessage` with `slash_commands` field
- `sdk.d.ts` lines 256-266: `Query` type with `interrupt()` and `setPermissionMode()`
- `sdk.d.ts` lines 283-286: `query()` function signature
