# SpaiGlass Multi-Harness Architecture — Design Specification

**Status:** v0.2 — incorporating third-party review
**Author:** SpaiGlass team (drafted with Claude Opus 4.7)
**Date:** 2026-05-01
**Scope:** Adding Qwen3.6 (via a TypeScript-native agent harness) as a first-class peer to the existing Claude CLI integration, without coupling either provider to SpaiGlass's session/UI layer.

**Revision history:**

- **v0.1 (2026-05-01)** — Initial draft.
- **v0.2 (2026-05-01)** — Incorporated third-party review. Material changes:
  - §3.5 added: load-bearing posture statement ("SpaiGlass owns the runtime, providers are adapters").
  - §1 goals 2+3 split into core UX (uniform) vs. capability panels (provider-specific).
  - §5 `ProviderHealth` expanded (status enum, capabilities, auth, queue depth).
  - §5 `ProviderSessionHandle` adds stream lifecycle (`pause`, `resume`, `onStreamEvent`).
  - §5 `Tool` interface formalized (async invoke, streaming flag, availability).
  - §6.5 added: explicit error frame model with stable codes.
  - §7 inverted: SpaiGlass-owned canonical transcript at `~/.spaiglass/sessions/transcripts/<id>.jsonl` is now the source of truth for all providers; provider-native logs are advisory.
  - §9 broker fast-path for auto-allow / auto-deny policies (no async overhead).
  - §16 notes the inflection point at which plugin-loader infrastructure earns its keep.

---

## 1. Goals

1. **Provider-agnostic core.** SpaiGlass's session manager, frame protocol, picker, and permission broker must not assume any specific LLM vendor. Adding a third harness later (DeepSeek, GLM-4, future Qwens) requires implementing one interface, not modifying the core.
2. **Uniform Core UX across providers.** A user resuming a session, opening the file tree, approving a tool call, or streaming output should see the same affordances regardless of which model produced it. The Core UX surface is provider-agnostic by contract.
3. **Native-quality experience via Capability Panels.** Provider-specific capabilities (Claude's MCP servers, Qwen's `thinking_mode`, vision, subagents) appear as opt-in panels gated by the provider's declared capabilities, *outside* the Core UX surface. Identical Core UX and native capabilities are not in tension because they live at different UI layers (see §6).
4. **No translation proxy.** Each provider speaks its native API directly. We will not bridge Claude SDK to Qwen via an Anthropic-compat shim; the architectural cost outweighs the integration savings.
5. **Single source of truth for tool execution.** Reading files, running bash, searching code — these implementations live once in SpaiGlass-owned code and are surfaced to each provider in that provider's tool-call format.
6. **SpaiGlass owns session state.** Every session's normalized transcript is owned by SpaiGlass, not by a provider SDK. This makes the picker, preview, resume, and replay paths provider-agnostic by construction (see §7).

## 2. Non-goals

- **Cross-provider session continuation.** A conversation started with Claude cannot be resumed against Qwen mid-thread. Different models have different tokenizers, system prompts, and tool-output conventions; mid-stream provider swap is out of scope. Users start a new session if they want a different provider.
- **Auto-failover between providers.** If Qwen is unreachable, SpaiGlass surfaces the error; it does not silently retry against Claude. (Auto-failover may be a Phase 5 add-on, gated behind explicit user opt-in per session.)
- **Multi-modal parity in v1.** Vision input may differ between providers; v1 ships text-only. Image support is provider-by-provider as future work.
- **Multi-agent / agent-spawning parity in v1.** Claude's `Task` (subagent) tool is Claude-specific and won't be wired to Qwen until Qwen-Agent's multi-agent primitives are evaluated separately.

## 3. Background — why the current architecture can't accommodate Qwen as-is

SpaiGlass's connector backend is currently structured around the assumption that exactly one agent harness exists: `@anthropic-ai/claude-agent-sdk`. Concretely:

- `backend/session/manager.ts` calls `sdk.startup({...})` to begin every session. The SDK is the harness.
- The frame protocol emitted on the WS (`backend/session/frame-emitter.ts`) is structured around Anthropic SDK message shapes — `SDKAssistantMessage`, `SDKUserMessage`, `SDKCompactBoundaryMessage` — passed through with thin wrapping.
- Session transcripts are persisted by the SDK to `~/.claude/projects/<encoded>/<id>.jsonl`. SpaiGlass reads them back via `parseAllHistoryFiles()` for the picker; it does not own the storage.
- Tool execution happens inside the SDK (the SDK ships built-in handlers for Read/Edit/Write/Bash/etc.). SpaiGlass intercepts via permission hooks but does not implement the tools.

A second harness cannot be inserted alongside this without an abstraction boundary. The required surgery is at the orchestration and persistence layers — not at the front-end (which already deals in our own frame types) and not at the relay (which is provider-agnostic by design).

## 3.5 Architectural posture (load-bearing)

**SpaiGlass is a runtime orchestration engine. Providers are adapters.**

This is the load-bearing principle for every other decision in this document. It manifests as four invariants the codebase enforces:

1. **Sessions are SpaiGlass objects.** A session's identity, lifecycle, transcript, and metadata belong to SpaiGlass. Providers operate *within* a session — they do not own sessions.
2. **Tools are SpaiGlass objects.** The registry, schemas, implementations, and execution path are SpaiGlass-controlled. Providers describe *which* tool to invoke; SpaiGlass decides *whether and how* to invoke it.
3. **Frames are the wire contract.** What flows over the WS is the canonical frame protocol (§6). Providers emit frames; they do not emit raw SDK messages, OpenAI deltas, or vendor-specific shapes outside their own internals.
4. **Persistence is SpaiGlass-owned.** Provider-native logs (Claude SDK's JSONL, Qwen agent state) are advisory. The authoritative transcript lives in SpaiGlass storage (§7).

These four invariants mean a provider implementation is a *narrow* thing: a translator between its vendor's API and SpaiGlass's internal contracts. If a provider needs to bypass any of these to function, the design has failed and the contracts need to be widened deliberately — not the provider granted a side door.

Plugin-loader infrastructure (dynamic provider discovery, sandboxed third-party adapters, a versioned plugin API) is **not** built in v1. Two providers in-tree don't earn the complexity. The inflection point is roughly the *fourth* provider, or the first third-party adapter we don't author ourselves; see §16.

## 4. High-level architecture

```
                    ┌───────────────────────────────────────────────────┐
                    │  Browser (React)                                  │
                    │   • SessionPickerModal (provider-aware)           │
                    │   • Provider selector at session start            │
                    │   • Frame renderer (provider-agnostic frames)     │
                    └───────────────────┬───────────────────────────────┘
                                        │  WSS (frame protocol v2)
                    ┌───────────────────▼───────────────────────────────┐
                    │  Relay (sgcleanrelay)                             │
                    │   • Auth, routing, fleet enumeration              │
                    │   • Stateless re: provider                        │
                    └───────────────────┬───────────────────────────────┘
                                        │  WS over tunnel
                    ┌───────────────────▼───────────────────────────────┐
                    │  Connector backend (per VM)                       │
                    │  ┌─────────────────────────────────────────────┐  │
                    │  │  SessionManager                             │  │
                    │  │   • dispatch by provider                    │  │
                    │  │   • shared lifecycle (start/abort/resume)   │  │
                    │  └────────────┬───────────────┬────────────────┘  │
                    │               ▼               ▼                   │
                    │   ┌──────────────────┐  ┌──────────────────┐      │
                    │   │ ClaudeProvider   │  │ QwenProvider     │      │
                    │   │  (SDK adapter)   │  │  (TS agent loop) │      │
                    │   └────────┬─────────┘  └────────┬─────────┘      │
                    │            │ uses              uses │             │
                    │   ┌────────▼─────────────────────────▼─────────┐  │
                    │   │  Shared services                            │  │
                    │   │   • ToolRegistry (single source of impls)   │  │
                    │   │   • PermissionBroker                        │  │
                    │   │   • SessionStore (canonical metadata)       │  │
                    │   │   • FrameEmitter (canonical frame protocol) │  │
                    │   └─────────────────────────────────────────────┘  │
                    └────────────────────────────┬──────────────────────┘
                                                 │
                          ┌──────────────────────┴───────────────────┐
                          ▼                                          ▼
                ┌─────────────────────┐                  ┌──────────────────────┐
                │ Anthropic API       │                  │ Local Qwen (vLLM/    │
                │ (cloud, per-VM auth)│                  │ SGLang on WSL2)      │
                │                     │                  │ shared LAN endpoint  │
                └─────────────────────┘                  └──────────────────────┘
```

## 5. The Provider abstraction

The core contribution. A minimal interface every harness implements; nothing else in SpaiGlass talks to vendor SDKs directly.

```typescript
// backend/runtime/provider.ts
export interface Provider {
  /** Stable provider id used in URLs, persistence, and the WS protocol. */
  readonly id: "claude" | "qwen" | string;

  /** Display label shown in UI badges. */
  readonly displayName: string;

  /** Healthcheck — see ProviderHealth below. Cached for ~30s by the manager. */
  health(): Promise<ProviderHealth>;

  /** Begin or resume a session. Receives the lifecycle context;
   *  emits frames on the provided emitter; calls the broker for permissions;
   *  resolves when the session is fully started (first response begins
   *  streaming) so the orchestrator can ack. */
  start(
    ctx: SessionContext,
    emitter: FrameEmitter,
    broker: PermissionBroker,
  ): Promise<ProviderSessionHandle>;
}

export interface ProviderSessionHandle {
  /** User typed something; stream their input into the active turn. */
  sendUserMessage(text: string): Promise<void>;

  /** User requested abort. Idempotent — safe to call multiple times. */
  abort(): Promise<void>;

  /** Force-end the session and free all resources. */
  close(): Promise<void>;

  /** Subscribe to high-level state transitions (running/waiting/closed). */
  onStateChange(cb: (state: SessionState) => void): void;

  // ---- Stream lifecycle ----------------------------------------------
  // For local providers (Qwen) these map to real backpressure controls
  // on the underlying inference engine. For cloud providers (Claude over
  // Anthropic API) they may no-op gracefully — we don't have streaming
  // control at the API level, but the contract is the same.

  /** Pause the current generation, if supported. */
  pause(): Promise<void>;

  /** Resume from a paused state. */
  resume(): Promise<void>;

  /** Subscribe to fine-grained stream events for telemetry and UI hints
   *  (token rate, queue depth, tool-call boundary detection). Distinct
   *  from frame emission, which goes via the FrameEmitter. */
  onStreamEvent(cb: (e: StreamEvent) => void): void;
}

export type StreamEvent =
  | { type: "token"; tokens: number; ts: number }      // throughput tracking
  | { type: "queue_depth"; depth: number }              // local providers
  | { type: "stalled"; sinceMs: number };               // possible backpressure

export interface SessionContext {
  sessionId: string;             // canonical SpaiGlass id
  resumeSessionId?: string;      // hint to the provider for native resume; if
                                 //   absent or stale, replay from our normalized
                                 //   transcript instead (see §7).
  workingDirectory: string;
  roleFile?: string;             // optional system prompt seed
  model?: string;                // optional sub-model selection (Sonnet vs Opus, etc.)
  toolRegistry: ToolRegistry;    // shared tool implementations
}

export interface ProviderHealth {
  /** Coarse status — picker uses this to badge providers + gate selection. */
  status: "healthy" | "degraded" | "unavailable";

  /** Recent latency to the provider's primary endpoint, when known. */
  latencyMs?: number;

  /** Models the provider can currently serve. Picker exposes this in the
   *  selector when more than one is configured (Sonnet vs Opus, multiple
   *  Qwen variants on a single endpoint, etc.). */
  models: string[];

  /** Capabilities the provider currently supports. Drives Capability Panel
   *  visibility (§6). Stable string set: "mcp" | "thinking" | "vision" |
   *  "subagents" | "file_upload" | "tool_streaming" | ... */
  capabilities: string[];

  /** Auth state for providers that require it (Anthropic OAuth, Qwen
   *  endpoints with API keys). "missing" → user needs to log in;
   *  "expired" → re-auth flow. */
  authStatus: "ok" | "expired" | "missing" | "n/a";

  /** Backpressure indicator for local providers. Picker can warn when
   *  starting a new session against a queue with >N waiting requests. */
  queueDepth?: number;

  /** Human-readable detail when status !== "healthy". */
  detail?: string;
}

// ----------------------------------------------------------------------
// Tool interface — see §8 for execution flow.

export interface Tool {
  /** Stable name. Surfaced to the model verbatim in tool schemas. */
  name: string;

  /** Description used by the model to decide when to call. Identical
   *  across providers. */
  description: string;

  /** JSON Schema for input parameters. Required; we don't accept
   *  loose-prose tool descriptions. See §8 for rationale. */
  inputSchema: JSONSchema;

  /** Execute the tool. Returns a normalized ToolResult. */
  invoke(input: unknown, ctx: ToolContext): Promise<ToolResult>;

  /** True if invoke() may emit progress frames during execution. The
   *  manager wires those frames through the same FrameEmitter the
   *  provider uses. */
  streaming?: boolean;

  /** Restrict this tool to specific provider ids. Omit for "all
   *  providers". Used for vendor-specific tools (Claude's `Task` for
   *  subagents, MCP-only tools, etc.). */
  availableFor?: string[];
}

export interface ToolContext {
  sessionId: string;
  workingDirectory: string;
  emitter: FrameEmitter;          // for streaming tools
  decision: PermissionDecision;   // proof of authorization (see §9)
}

export interface ToolResult {
  ok: boolean;
  content: string;                // model-visible output (always)
  detail?: unknown;               // structured payload for UI rendering
  durationMs: number;
}
```

Two implementations:

- **`ClaudeProvider`** (in `backend/runtime/claude/`) — wraps `@anthropic-ai/claude-agent-sdk`. The current code becomes this provider with thin adapter glue. Tool calls dispatched by the SDK are intercepted via the SDK's permission hook and routed to the shared `PermissionBroker` and `ToolRegistry`. Session transcripts continue to be written by the SDK to `~/.claude/projects/...`; the provider also writes a SpaiGlass metadata stub (see §7).
- **`QwenProvider`** (in `backend/runtime/qwen/`) — TypeScript agent loop using the `openai` Node SDK pointed at the WSL2 vLLM endpoint. Manages its own message history in memory; persists transcripts through the shared `SessionStore`. Tool calls emitted by Qwen are routed identically through `PermissionBroker` and `ToolRegistry`.

Both providers emit identical frame types via the shared `FrameEmitter`.

## 6. Frame protocol v2

Currently the frame protocol surfaces SDK-native message types. v2 narrows it to a canonical set defined by SpaiGlass, emitted by both providers. Existing frames continue to be emitted; v2 adds provider-tagging and standardizes a few edge cases:

| Frame type | Purpose | Both providers emit? |
|---|---|---|
| `session_started` | Includes `provider`, `model`, `cwd`, `roleFile` | Yes |
| `text_delta` | Streaming text chunk | Yes |
| `text_complete` | Turn ended (assistant text) | Yes |
| `thinking_delta` | Streaming reasoning (Claude `thinking`, Qwen `<think>`) | Yes (when enabled) |
| `thinking_complete` | Reasoning ended | Yes |
| `tool_use` | Model is requesting tool execution | Yes |
| `tool_result` | Tool finished | Yes (emitted by SpaiGlass on the provider's behalf) |
| `permission_request` | Tool needs user approval | Yes (broker emits; provider opaque to it) |
| `permission_resolved` | Approval received | Yes |
| `compact_boundary` | Context was summarized | Yes (provider-specific compaction triggers) |
| `state_change` | running / waiting_input / closed / errored | Yes |
| `error` | Recoverable or fatal failure | Yes |
| `model_switched` | (rare) provider swapped sub-model mid-session | Provider-specific |

Every frame carries `{ provider, sessionId, ts, seq }`. The frontend renderer is unchanged below the chrome layer — it cares about frame types, not provider.

### 6.1 Two-layer UX — Core surface vs. Capability Panels

The frame protocol is the contract for the **Core UX surface**: the chat thread, tool approvals, picker, file browser, settings — everything the average user sees on every session, regardless of provider. The Core UX is uniform across providers by construction: any frame that flows over the WS is renderable without provider-specific code.

**Capability Panels** are an orthogonal UI surface. Each provider declares its capabilities via `ProviderHealth.capabilities` (§5). The frontend conditionally mounts a panel for each capability:

| Capability id | Panel | Provider(s) typically supporting |
|---|---|---|
| `mcp` | MCP server browser, configuration | Claude (today), Qwen (Phase 2) |
| `thinking` | Reasoning trace toggle, thinking budget control | Both (Claude `thinking`, Qwen3.6 `<think>`) |
| `vision` | Image upload chip, attachment chip | Both eventually |
| `subagents` | Task tree visualization | Claude (today) |
| `tool_streaming` | Live progress for streaming tools | Provider-dependent |

Capability Panels mount near the chat — typically as a collapsible right-rail or a dropdown in the chat header. They never appear in the picker (which is global) and never affect frame rendering (which is uniform). A user on Claude sees an MCP panel; a user on Qwen sees one if Qwen advertises `mcp` capability and not otherwise. There is no expectation of cross-panel consistency — each panel is provider-specific and may look different.

This is how "uniform Core UX" and "native-quality experience" co-exist: Core handles the 90% of interaction that's the same everywhere; Panels handle the 10% that's genuinely vendor-specific.

## 6.5 Error model

All non-success frames flow as a single typed shape:

```typescript
export type ErrorFrame = {
  type: "error";
  source: "provider" | "tool" | "transport" | "permission" | "system";
  code: ErrorCode;        // stable enum, see below
  message: string;        // human-readable, safe to render
  retryable: boolean;     // UI shows a "Retry" affordance when true
  detail?: unknown;       // structured detail for telemetry / power users
};

export type ErrorCode =
  // provider
  | "provider_unreachable"
  | "provider_auth_expired"
  | "provider_auth_missing"
  | "provider_rate_limited"
  | "provider_model_not_found"
  | "provider_invalid_response"
  | "provider_internal_error"
  // tool
  | "tool_timeout"
  | "tool_not_found"
  | "tool_invalid_input"
  | "tool_execution_failed"
  // transport
  | "transport_disconnected"
  | "transport_protocol_violation"
  // permission
  | "permission_denied"
  | "permission_request_timed_out"
  // system
  | "session_not_found"
  | "session_corrupt"
  | "internal_error";
```

Rules:

1. **Stable codes.** Codes are part of the protocol contract; we don't rename them. Adding new codes is forward-compatible.
2. **Source disambiguates.** UI can render "the provider failed" differently from "the tool failed" without inspecting the code.
3. **Retryable is provider-asserted.** If the provider knows the failure is transient (rate limit with retry-after, transient 5xx) it sets `retryable: true`; if it knows the failure is fatal (auth expired, model removed) it sets `false`. UI surfaces a Retry button only on `retryable: true`.
4. **Tool errors are not session-fatal.** A `tool_*` error becomes a normalized `ToolResult { ok: false, content: <error description> }` frame the *model* sees, so the model can decide whether to retry or abandon the tool call. The model's downstream behavior is its own concern.
5. **Provider errors mid-stream** trigger the manager's retry policy first; only after exhaustion do they surface as `ErrorFrame` to the user.

## 7. Session persistence — SpaiGlass owns the transcript

Per §3.5 invariant 4: persistence is SpaiGlass-owned. Provider-native logs (Claude SDK's `~/.claude/projects/*.jsonl`, Qwen agent state) are **advisory**; the authoritative transcript is a normalized frame log that SpaiGlass writes for *every* session, regardless of provider.

### 7.1 Storage layout

```
~/.spaiglass/sessions/
  index/
    <sessionId>.json                    # canonical metadata (one per session)
  transcripts/
    <sessionId>.jsonl                   # canonical normalized frame log (one per session)
                                        # — written by FrameEmitter alongside WS emission

  # Auto-resume pointer (existing, kept):
  <tupleHash>/meta.json                 # last-session-for-(workingDirectory, role) cache
```

Provider-native logs continue to be written wherever the provider naturally writes them (Claude SDK's `~/.claude/projects/`, etc.) — but SpaiGlass does not depend on them for any user-visible operation.

### 7.2 Index entry shape

```typescript
{
  id: string;                  // canonical SpaiGlass session id
  provider: string;            // "claude" | "qwen" | ...
  model: string | null;        // sub-model if known
  workingDirectory: string;
  roleFile: string | null;
  createdAt: number;
  lastActivity: number;
  lastUserMessage: string;     // first 120 chars, for picker preview
  lastTime: string;            // ISO, for picker sort
  messageCount: number;
  status: "active" | "ended" | "errored";
  providerSessionId: string | null;  // hint to provider for native resume; if
                                     // absent or stale, we replay from our
                                     // transcript instead.
  transcriptFormatVersion: 1;
}
```

### 7.3 Transcript shape

The transcript is a JSONL of *normalized frames* — the same frames that flow over the WS, with timestamps and sequence numbers preserved. One frame per line.

This means the transcript IS the conversation, replayable by any subscriber:

- The picker reads metadata from the index.
- The picker preview reads the first user-message frame from the transcript.
- The replay path reads the transcript and re-emits frames into a fresh consumer.
- The resume path reads the transcript, replays it into the chosen provider via the provider's resume API or via prompt-replay, then continues.

### 7.4 Resume contract

```
1. Frontend posts sessionId.
2. Backend reads index/<sessionId>.json → { provider, providerSessionId, ... }.
3. Backend dispatches to Provider.start({
     sessionId,
     resumeSessionId: providerSessionId,   // hint
     ...
   }).
4. Provider attempts native resume using its own log if it has one (Claude SDK
   resumes from ~/.claude/projects/, Qwen reads its in-memory state if present).
5. If native resume fails or providerSessionId is stale/missing, the manager
   falls back to replay: reads transcripts/<sessionId>.jsonl, walks frames into
   a new provider session, replays user/assistant turns as messages, then
   continues.
6. Either path produces an active session that emits new frames; both append
   to the SAME transcript file.
```

This means a session **survives** loss of provider-native state. A user whose Claude SDK transcript got corrupted or whose Qwen process state died can still resume — they lose nothing the WS frame protocol carried.

### 7.5 Picker preview is provider-agnostic

Because the transcript is normalized frames, the picker preview path never parses provider-specific shapes:

```typescript
// pseudo
function previewFor(sessionId): string {
  const stream = readTranscript(sessionId, { limit: 50 });  // first 50 frames
  for (const frame of stream) {
    if (frame.type === "text_complete" && frame.role === "user") {
      return frame.text.slice(0, 120);
    }
  }
  return "(no user input yet)";
}
```

No special-case for Claude tool-use blocks vs Qwen `<think>` tags vs anything else. The frame layer normalizes those.

### 7.6 Migration

The migration is a one-time backfill, run at backend startup (idempotent):

```
For each <id>.jsonl in ~/.claude/projects/<encoded>/:
  if ~/.spaiglass/sessions/index/<id>.json does not exist:
    parse the SDK JSONL with the existing parser.
    walk it, emitting normalized frames into transcripts/<id>.jsonl.
    write index/<id>.json with extracted metadata.
```

Backfill is bounded by the existing fleet's session count (~hundreds, not millions). One-shot, cached. Future Claude sessions write to *both* the SDK's location (the SDK insists) AND our normalized transcript, via a frame tap in `ClaudeProvider`.

## 8. Tool palette — shared implementations, adapted schemas

```
backend/tools/
  registry.ts          # ToolRegistry — single source of truth
  read.ts              # implementation
  edit.ts
  write.ts
  bash.ts
  grep.ts
  glob.ts
  webfetch.ts          # phase 2
  schema/
    anthropic.ts       # serializes registry → Anthropic tool spec
    openai.ts          # serializes registry → OpenAI tool spec (Qwen uses this)
```

The ToolRegistry is the canonical declaration. Each provider serializes the registry into its native tool-schema format at session start. Tool-call execution flows through the SAME implementation regardless of which provider invoked it.

Provider-specific tools (e.g. Claude's `Task` for subagents, Qwen's MCP tools) are registered conditionally — `registry.register(tool, { availableFor: ["claude"] })` — so the schema serializer for the other provider simply omits them.

## 9. Permission broker

Tool execution decisions are made centrally:

```typescript
export interface PermissionBroker {
  /** Can this tool call execute? Returns synchronously when policy is
   *  "allow" or "deny" (fast path — no async overhead, no frame
   *  emission). Returns a Promise that resolves with the user's choice
   *  when policy is "ask" — at which point the broker has emitted a
   *  permission_request frame and is awaiting the matching
   *  permission_resolved response. */
  authorize(call: ToolCall, ctx: SessionContext): PermissionDecision | Promise<PermissionDecision>;
}

export type PermissionDecision =
  | { kind: "allowed"; token: string }              // token proves authorization
                                                     // — ToolRegistry.execute() requires it
  | { kind: "denied"; reason: string };
```

### 9.1 Fast path (auto-allow / auto-deny)

The hot path matters: tool calls happen many times per turn. The broker resolves synchronously when policy is decided up-front:

```typescript
authorize(call, ctx) {
  const policy = lookupPolicy(call.tool, ctx);  // O(1) hash
  if (policy === "allow") return { kind: "allowed", token: mintToken(call) };
  if (policy === "deny")  return { kind: "denied", reason: "policy" };
  return askUser(call, ctx);                    // async only on "ask"
}
```

This means policy-controlled tool execution adds no measurable latency in steady state.

### 9.2 Ask path

When `lookupPolicy` returns `"ask"`:

1. Broker emits a `permission_request` frame with the tool name + serialized input.
2. UI renders an inline approval card with Allow / Allow & Remember / Deny / Deny & Remember.
3. Frontend posts a `permission_resolved` message back over the WS.
4. Broker matches by request id, resolves the original Promise, optionally updates the policy if "& Remember" was chosen.
5. Broker emits a `permission_resolved` frame so any other consumers see the outcome.

### 9.3 Policy configuration

Policy is configurable per-VM (in `~/.spaiglass/config.json`, see §10) and can be overridden per-session. Default policy stays close to Claude's current behavior (auto-allow Read/Grep, prompt for Bash/Write/Edit).

Per-provider overrides are supported: `permissions.<tool>` accepts either a single value or a per-provider map:

```jsonc
"permissions": {
  "Read": "allow",
  "Bash": { "claude": "ask", "qwen": "ask", "_default": "ask" },
  "WebFetch": { "claude": "allow", "qwen": "ask" }   // we trust Claude's WebFetch sandbox more
}
```

The broker is provider-agnostic in implementation — Qwen's bash call goes through the exact same prompt UX the user sees for Claude. Per-provider policy is data, not code.

## 10. Configuration

A single per-VM config file replaces scattered env vars:

```jsonc
// ~/.spaiglass/config.json
{
  "providers": {
    "claude": {
      "enabled": true,
      "auth": "oauth",                  // implies subscription via `claude login`
      "defaultModel": "claude-sonnet-4-6"
    },
    "qwen": {
      "enabled": true,
      "endpoint": "http://192.168.1.50:8000/v1",
      "model": "Qwen/Qwen3.6-35B-A3B",
      "apiKey": null,                   // optional — Qwen endpoints typically don't require it
      "maxContextTokens": 262144,
      "compactionThreshold": 0.80,      // % of max before summarize-and-trim
      "thinkingMode": "on-demand"       // off | on-demand | always
    }
  },
  "defaultProvider": "claude",
  "permissions": {
    "Bash": "ask",
    "Write": "ask",
    "Edit": "ask",
    "Read": "allow",
    "Grep": "allow"
  }
}
```

Backend reads this on startup; falls back to env vars for compatibility (`QWEN_BASE_URL`, etc.). Frontend's settings UI edits this file. Connectors that don't have Qwen configured simply don't expose it as a choice.

## 11. Per-session selection flow

1. User on `/vm/<conn>/<segment>/` clicks "New Session" or picks "New Session" from the picker.
2. Frontend asks `/api/providers` (new endpoint) for the provider list available on this connector. Backend returns the `providers` block from config (with health probes attached).
3. UI shows a small selector defaulting to `defaultProvider`. User confirms or switches.
4. WS `session_start` carries `provider: "qwen" | "claude"`.
5. Backend `SessionManager.dispatch(provider)` selects the right `Provider` instance and calls `start()`.
6. From here the lifecycle is provider-agnostic at the SpaiGlass layer.

If a connector has only one provider enabled (or one is unhealthy at session start), the selector hides automatically.

## 12. Resilience model

Each provider declares its own probe + retry policy via `health()`. The SessionManager:

- Probes selected provider before session start. If unavailable, returns a `provider_unavailable` error frame with the broker's `detail` and recommended action.
- During a session, if the provider raises a recoverable error, the manager applies the provider's declared retry policy (count + backoff) before surfacing.
- Unrecoverable errors mid-session emit a `state_change: errored` frame; user can retry the last turn or abandon.
- A "Provider down" panel in the UI shows the most recent health probe per provider — visible from the session picker so users see *before they start* whether Qwen is reachable.

For Qwen specifically (the more failure-prone path):

- Health probe: `GET <endpoint>/v1/models` with 3s timeout, cached 30s.
- Mid-session retry: 3 attempts, 2s/4s/8s backoff for connection-level errors. No retry for tool execution errors (those bubble up as tool results).
- Connection abort during stream: emit `error` frame with last successful position; UI offers "retry from here."

## 13. Security considerations

- **Tool execution always runs as the connector's user.** No escalation across providers.
- **Permission broker is the single gate.** Both providers go through it; bypass is not possible from a provider implementation (`ToolRegistry.execute()` only accepts a `PermissionDecision` token issued by the broker).
- **Qwen endpoint trust:** the LAN endpoint is unauthenticated by default. We rely on LAN segmentation. If the endpoint is exposed beyond the LAN, the user must set `apiKey` in config and configure vLLM to enforce it. This must be documented prominently.
- **Transcript storage:** Qwen transcripts at `~/.spaiglass/qwen-transcripts/` may contain credentials echoed in tool output. Same risk profile as Claude's `~/.claude/projects/` — we already mitigate by not surfacing arbitrary tool output in picker previews (only first user message).
- **Provider info leak:** Frame protocol carries `provider` + `model` fields. Visible to the user only — never sent across the connector boundary in either direction.

## 14. Failure modes / observability

| Scenario | Detection | User-visible result |
|---|---|---|
| Qwen WSL2 down | Health probe 3s timeout | "Qwen unreachable — start the WSL2 service or pick Claude" |
| Anthropic auth expired | SDK error on first turn | Inline frame with `claude login` instructions |
| Qwen returns malformed tool call | Provider parse failure | Inline error frame; user can retry |
| Mid-stream connection drop | WS error during `text_delta` | `state_change: errored`; turn marked partial |
| Tool execution timeout | ToolRegistry timeout (60s default) | `tool_result` with error; LLM sees it and decides whether to retry |
| Permission denied by user | Broker returns `denied` | LLM sees a synthetic tool result explaining denial |

Logs:

- Per-frame structured logs at the connector, namespaced `provider.claude.*` / `provider.qwen.*` for filterability.
- Health probes published on a `/api/providers` poll endpoint (every 30s by default) — frontend uses this to badge status.

## 15. Migration plan

The architecture is additive. Existing Claude-only deployments are not broken at any step.

**Step 1: Provider abstraction shim.**

- Introduce `Provider` interface and `ToolRegistry` types.
- Wrap existing SDK code as `ClaudeProvider`.
- All current sessions still work; the only change is one indirection layer.
- Ship to fleet. Verify no regression.

**Step 2: SessionStore canonicalization.**

- New `~/.spaiglass/sessions/index/<id>.json` written for every Claude session as it's created.
- One-time backfill scan for existing Claude sessions.
- Picker reads the new index. Old read path remains as fallback.
- Ship to fleet. Verify picker still shows everything.

**Step 3: QwenProvider Phase 1.**

- Implement against WSL2 endpoint.
- Single test connector enables it via config.
- End-to-end: start a Qwen session, run a Bash tool, see the output.
- Verify in isolation; do NOT enable on fleet broadly.

**Step 4: Frontend selector + picker badging.**

- Provider selector at session start.
- Picker rows show provider badge.
- Ship to fleet behind a feature flag.

**Step 5: Phase rollout.**

- Enable Qwen provider on connectors that have configured `qwen.endpoint`.
- All other connectors continue Claude-only.

Each step ships independently. Rollback at any step is reverting one git commit.

## 16. Open questions / decisions deferred

- **Tokenizer for Qwen compaction:** call vLLM's `/tokenize` (network round-trip) vs. bundle `@huggingface/tokenizers` in-process (~200KB, locks tokenizer to one model variant). Recommend bundled for v1; revisit if we add multiple Qwen variants.
- **Should `defaultProvider` be per-VM or per-user?** Per-VM is simpler; per-user requires tying to the relay's auth identity. Recommend per-VM for v1.
- **Single shared Qwen endpoint vs. per-connector endpoint:** v1 assumes one shared LAN Qwen serving multiple connectors. If load becomes a concern, providers can be configured to a connector-local endpoint with no architectural change — only `qwen.endpoint` differs.
- **Picker section vs. interleaved:** recommend interleaved by recency with provider badges.
- **Thinking-mode rendering:** default-collapsed expandable chevron in chat UI. Show only when present in frames.
- **MCP support for Qwen:** Qwen3.6 has first-class MCP support per its model card. Qwen-Agent's MCP integration is the reference. v1 ships without MCP; Phase 2 adds it once the runtime is stable.
- **Provider-specific permission policy overrides:** *resolved* — supported in §9.3 via the `permissions.<tool>` per-provider map.
- **Plugin-loader infrastructure (deferred):** §3.5 commits to "providers as adapters, not plugins" for v1. Inflection points where this becomes worth revisiting:
  1. The fourth in-tree provider (when adding a provider stops being trivial because of cross-cutting changes to the Provider interface).
  2. The first third-party adapter we don't author ourselves (security boundary, sandboxing, API versioning all start mattering).
  3. Provider configuration becoming user-data rather than ops-data (users uploading custom adapter packages).
  Until any of those land, "two-three providers in-tree, statically linked" is the correct posture.

## 17. Implementation phasing (code-side)

| Phase | Deliverable | Lines | Days |
|---|---|---|---|
| **A. Abstraction** | `Provider` interface, `ToolRegistry`, `PermissionBroker`, `FrameEmitter` v2 — Claude wrapped as `ClaudeProvider`, no behavior change | ~600 | 2 |
| **B. SessionStore** | Canonical index + backfill, picker reads new format | ~400 | 1.5 |
| **C. QwenProvider MVP** | Agent loop, tool palette MVP (Read/Edit/Write/Bash/Grep), no thinking, no MCP | ~900 | 3 |
| **D. Frontend selector** | Provider dropdown, picker badges, settings panel | ~300 | 1.5 |
| **E. Resilience** | Health probes, retry policy, error frames, status panel | ~300 | 1 |
| **F. Polish** | Thinking-mode rendering, compaction, observability, docs | ~400 | 2 |

**MVP (A through E):** ~9 working days. **Production-ready (through F):** ~11 days.

---

## Open for review

v0.2 questions for reviewers:

1. **Phase 1 ships QwenProvider with a hand-rolled TS agent loop.** Alternative: embed Qwen-Agent (Python) as a subprocess for v1, port to TS later. Tradeoff is correctness-vs-debt. Hand-roll is the current plan.
2. **`StreamEvent` shape.** Listed three event types (`token`, `queue_depth`, `stalled`) — sufficient for current backpressure / telemetry needs, or premature?
3. **Transcript backfill** (§7.6) — happens at backend startup. Acceptable for fleet-scale (hundreds of sessions per VM, one-time)? Or should it be lazy on first picker query?
4. **Per-provider permission policy map** (§9.3). Worth the config complexity, or should we ship a simpler global-policy v1 and add per-provider overrides only if real use cases demand it?
5. **Capability Panel discovery.** Currently the frontend hardcodes which capability id maps to which panel. As more capabilities accrete (`mcp`, `thinking`, `vision`, `subagents`, ...) does this stay maintainable, or do we need a panel registry on the frontend mirroring the provider/tool registries on the backend?

Resolved in v0.2 from v0.1 review:

- ✅ Transcript ownership flipped (§7).
- ✅ Two-layer UX explicit (§6.1).
- ✅ `ProviderHealth` expanded (§5).
- ✅ Stream lifecycle on the handle (§5).
- ✅ Error frame model (§6.5).
- ✅ Tool interface formalized with strict schema requirement (§5, §8).
- ✅ Broker fast path for non-"ask" policies (§9.1).
- ✅ Architectural posture stated up-front (§3.5).
- ✅ Plugin-loader inflection point named (§16).
