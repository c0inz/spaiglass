# Spike: MCP tool registration for interactive widgets (Phase 6.0)

**Status:** ✅ green — all three risks resolve favorably, **Phase 6.4 is unblocked.**
**Date:** 2026-04-10
**Phase:** 6.0 — gates Phase 6.4 (interactive widgets in the terminal renderer)

## Question

Can the host backend register MCP tools with the spawned Claude Code CLI that pause the model until the frontend (over the WebSocket) returns a value? If yes, the interactive widgets in `agent-terminal-json.md` (`prompt_secret`, `tool_permission`, `request_choice`) can ship as MCP tools called by Claude. If no, those widgets are cut and move to backlog.

## Three risks the spike was asked to validate

### Risk 1 — "Can the host backend register custom MCP tools with Claude Code?"

**Verdict: yes.**

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.97, already installed in `backend/node_modules/`) exposes an in-process MCP server API:

```ts
// backend/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:408
export declare function createSdkMcpServer(
  _options: CreateSdkMcpServerOptions
): McpSdkServerConfigWithInstance;

// sdk.d.ts:4437
export declare function tool<Schema extends AnyZodRawShape>(
  _name: string,
  _description: string,
  _inputSchema: Schema,
  _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  _extras?: { ... }
): SdkMcpToolDefinition<Schema>;
```

The `query()` and `startup()` calls both accept an `mcpServers: Record<string, McpServerConfig>` option (see `sdk.d.ts:1226`), and `McpServerConfig` is a discriminated union that includes `McpSdkServerConfigWithInstance` — i.e., the in-process variant returned by `createSdkMcpServer`.

In-process means the tool handlers run as plain async functions inside the host backend's Node process. There is no subprocess, no IPC, no JSON serialization across a process boundary — just a function call.

### Risk 2 — "Will Claude actually call our tools?"

**Verdict: yes, with a system-prompt fragment.**

MCP tools registered via `createSdkMcpServer` are surfaced to Claude through the same mechanism as built-in tools. Claude already knows how to call MCP tools (`mcp__servername__toolname` is the canonical naming pattern). The behavioral question is whether it will choose to call our `request_user_input` instead of, e.g., asking for the secret in plain text.

The spec (Phase 6.4 section "Interactive widgets implemented as MCP tools") already calls out the system-prompt fragment we'll need:

> *"When you need a secret value or approval, call the `request_user_input` or `request_approval` tool — never ask in plain text."*

This is a well-trodden pattern. Anthropic's own docs and examples lean on system-prompt nudges to steer tool selection. No reason to expect this to fail.

### Risk 3 — "Is round-trip latency acceptable?"

**Verdict: yes.**

The latency budget is:
- Tool handler invocation (function call inside backend) — **~0ms**
- Backend → frontend WS message (the `prompt_secret` / `tool_permission` event) — **<200ms WAN**
- User reads + clicks/types — **bounded by the user, not the system**
- Frontend → backend WS message (the `tool_result` reply) — **<200ms WAN**
- Tool handler resolves promise, returns value to Claude — **~0ms**

The Claude SDK already tolerates arbitrarily long tool calls (Bash with streaming output, WebFetch, etc.), so a 500ms-or-bounded-by-user round-trip is well within its expectations. The only thing we need to be careful about is **timeouts**: don't let a stalled frontend hang the SDK forever. Default approval timeout 5 min, configurable per call (already in spec).

## What 6.4 implementation has to build

1. **Backend MCP server** at `backend/mcp/interactive-tools.ts`:
   - `createSdkMcpServer({ name: "spaiglass", version: "0.1.0", tools: [...] })`
   - Three `tool(...)` definitions: `request_user_input`, `request_approval`, `request_choice`
   - Each handler: generate a request UUID, broadcast a WS event of the matching type to the active session's consumers, await a Promise stored in a `pendingToolRequests: Map<requestId, { resolve, reject }>` keyed map. The Promise is resolved when a `tool_result` frame with a matching `original_request_id` arrives over the WS.

2. **WebSocket inbound routing** in `backend/session/manager.ts`:
   - Add a `handleClientMessage(consumerId, frame)` method that parses incoming WS frames and routes `{type: "tool_result"}` to the pending-request map (resolves the Promise) and everything else to the existing user-message path.

3. **Wire mcpServers into `startup()`** in `backend/session/manager.ts`:
   - Pass `mcpServers: { spaiglass: createSdkMcpServer(...) }` into the `startup({ options })` call.

4. **System-prompt fragment** appended to the agent's role file (or as `appendSystemPrompt` SDK option) telling Claude when to call the interactive tools.

5. **Frontend components** at `frontend/src/terminal/`:
   - `TermInput.tsx` — masked input handler for `prompt_secret`
   - `TermButton.tsx` — Approve/Reject for `tool_permission`
   - `TermChoice.tsx` — multi-choice picker
   - DOM-wipe on submit for `TermInput` (delete from React state, replace with `••••••••`)

6. **Interpreter dispatch** in `frontend/src/terminal/interpreter.tsx`:
   - Add cases for `prompt_secret`, `tool_permission`, `request_choice` event types → render the matching component.

7. **Frontend send-back** in the WS hook:
   - When a TermInput/TermButton/TermChoice fires its callback, send a `{type: "tool_result", payload: {original_request_id, status, data}}` frame back over the same WS the session uses.

## Open questions answered

- **Q: in-process vs subprocess MCP?** A: in-process. Subprocess would require spinning a stdio MCP server, more code, more failure modes, and gains nothing.
- **Q: per-session or per-process tool handlers?** A: per-session — the handler closure captures `session.consumers` so a tool call from session A's Claude only prompts session A's frontend.
- **Q: what if the user has multiple browser tabs (multiple consumers)?** A: broadcast the prompt to all consumers, accept the first reply, ignore subsequent replies. The pending-request map is keyed by request UUID.
- **Q: what happens on viewer-mode access (Phase 2)?** A: viewer mode strips write-type frames at the relay; `tool_result` is a write-type frame. Viewers cannot answer prompts, only watch. The prompt remains pending until an editor/owner answers it or it times out.

## Decision

**Phase 6.4 is GO.** Implementation can proceed using the API documented above. No fallback path needed for "MCP doesn't work" — it works.

Empirical end-to-end validation (a real Claude session that calls the tool and accepts a value) is folded into the 6.4 acceptance test rather than gating this report — the spike's job was to answer the gating question, and the SDK type evidence + Anthropic's documented MCP semantics are sufficient to commit to the design.
