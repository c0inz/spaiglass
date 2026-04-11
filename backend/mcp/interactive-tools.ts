/**
 * Phase 6.4 — Interactive widgets implemented as MCP tools.
 *
 * The host backend registers an in-process MCP server with the Claude Agent
 * SDK. When Claude calls one of these tools, the handler:
 *
 *   1. Generates a request UUID.
 *   2. Broadcasts a frame to all consumers of the active session asking the
 *      browser to render an input/approval/choice widget.
 *   3. Awaits a Promise that resolves when a `tool_result` frame with the
 *      matching `original_request_id` arrives back over the WebSocket.
 *   4. Returns the user's reply to Claude as the tool result.
 *
 * Why MCP and not a WebSocket-only convention? Because Claude already knows
 * how to call MCP tools — they get the same surface area as Read/Write/Bash
 * and Claude can decide to call them from inside a multi-step plan. A pure
 * WebSocket convention would require teaching Claude a new protocol via
 * heavy system-prompt scaffolding, and the model would still happily ask for
 * passwords in plain text instead. See `docs/spike-mcp-tools.md` for the
 * spike report that gated this work.
 *
 * Three tools are registered:
 *
 *   - `request_user_input`  → frontend renders a (possibly masked) input
 *   - `request_approval`    → frontend renders an Approve/Reject button pair
 *   - `request_choice`      → frontend renders a single-select picker
 *
 * Each tool's handler is per-session — the closure captures a `PendingToolBroker`
 * that knows how to broadcast to the session's consumers and how to register a
 * pending request against the session's `pendingToolRequests` map. SessionManager
 * builds the broker when it constructs each session.
 */

import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

/**
 * Default per-call timeout. The user may take a while to read a prompt, but a
 * dropped browser tab should not pin the SDK forever. Five minutes matches the
 * default in `agent-terminal-json.md`. Tools accept a per-call override via
 * the `timeout_seconds` argument.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Reply payload the broker resolves with when a tool_result frame arrives.
 *
 *   - `accepted` → user submitted a value (input or choice)
 *   - `approved` → user clicked Approve on a tool_permission widget
 *   - `rejected` → user clicked Reject (or denied a permission)
 *   - `timeout`  → no reply within the deadline
 *   - `closed`   → the session ended before a reply arrived
 */
export type ToolReplyStatus =
  | "accepted"
  | "approved"
  | "rejected"
  | "timeout"
  | "closed";

export interface ToolReply {
  status: ToolReplyStatus;
  data?: unknown;
  /**
   * If the user gave a free-form reason (e.g. why they rejected an action),
   * surface it on the reply so the tool's text result can include it.
   */
  reason?: string;
}

/**
 * Per-session broker that the tool handlers close over. SessionManager
 * implements this against its own `pendingToolRequests` map and `broadcast()`.
 */
export interface PendingToolBroker {
  /**
   * Broadcast an interactive widget frame to all consumers of this session
   * AND register a pending entry in the session's request map.
   *
   * Returns a Promise that resolves when a matching `tool_result` frame
   * arrives, or when the timeout fires, or when the session ends.
   */
  request(
    frame: Record<string, unknown>,
    requestId: string,
    timeoutMs: number,
  ): Promise<ToolReply>;
}

/**
 * Construct an MCP server pre-bound to one session's broker. Returns the
 * value SessionManager passes into `startup({ options: { mcpServers: ... } })`.
 *
 * Naming: the server is named "spaiglass" so the canonical tool names Claude
 * sees are `mcp__spaiglass__request_user_input` etc. (per the Anthropic MCP
 * naming convention).
 */
export function createInteractiveToolsServer(broker: PendingToolBroker) {
  return createSdkMcpServer({
    name: "spaiglass",
    version: "0.1.0",
    tools: [
      tool(
        "request_user_input",
        "Ask the human user to enter a value (e.g. an API key, a passphrase, " +
          "a one-time code, or any other secret you should not see written in " +
          "plain text). The frontend renders a focused input field; if " +
          "`secret` is true the field is masked, the value is wiped from the " +
          "DOM after submission, and the value is never logged. " +
          "ALWAYS prefer this tool over asking for secrets in chat.",
        {
          prompt: z
            .string()
            .describe(
              "Short label shown above the input field — for example: " +
                "'Paste the OPENAI_API_KEY you want to use'.",
            ),
          secret: z
            .boolean()
            .optional()
            .describe(
              "If true, the field is masked and the value is wiped from " +
                "the DOM after submission. Default: false.",
            ),
          placeholder: z
            .string()
            .optional()
            .describe(
              "Optional placeholder text shown inside the empty input.",
            ),
          timeout_seconds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Override the default 300s timeout for this single call.",
            ),
        },
        async (args) => {
          const requestId = randomId();
          const timeoutMs =
            (args.timeout_seconds ?? 300) * 1000 || DEFAULT_TIMEOUT_MS;
          const reply = await broker.request(
            {
              type: "prompt_secret",
              request_id: requestId,
              prompt: args.prompt,
              secret: args.secret ?? false,
              placeholder: args.placeholder ?? null,
            },
            requestId,
            timeoutMs,
          );
          return formatReply(reply, "User submitted a value.");
        },
      ),

      tool(
        "request_approval",
        "Ask the human to approve or reject a specific action you are about " +
          "to take (e.g. 'I'm about to run `rm -rf node_modules` — proceed?'). " +
          "The frontend shows the action description and an Approve / Reject " +
          "button pair. Use this whenever an action is irreversible, costly, " +
          "or has security implications.",
        {
          action: z
            .string()
            .describe(
              "Short, human-readable description of what you're about to do.",
            ),
          details: z
            .string()
            .optional()
            .describe(
              "Optional longer explanation rendered below the action label.",
            ),
          timeout_seconds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Override the default 300s timeout for this single call.",
            ),
        },
        async (args) => {
          const requestId = randomId();
          const timeoutMs =
            (args.timeout_seconds ?? 300) * 1000 || DEFAULT_TIMEOUT_MS;
          const reply = await broker.request(
            {
              type: "tool_permission",
              request_id: requestId,
              action: args.action,
              details: args.details ?? null,
            },
            requestId,
            timeoutMs,
          );
          return formatReply(reply, "User responded to the approval prompt.");
        },
      ),

      tool(
        "request_choice",
        "Ask the human to pick one option from a small list. Use this when " +
          "you have a discrete set of valid next steps and you want the user " +
          "to choose between them rather than typing a free-form answer.",
        {
          prompt: z
            .string()
            .describe("The question shown above the choice list."),
          choices: z
            .array(z.string())
            .min(2)
            .max(10)
            .describe(
              "The choices shown to the user. Each entry must be unique.",
            ),
          timeout_seconds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Override the default 300s timeout for this single call.",
            ),
        },
        async (args) => {
          const requestId = randomId();
          const timeoutMs =
            (args.timeout_seconds ?? 300) * 1000 || DEFAULT_TIMEOUT_MS;
          const reply = await broker.request(
            {
              type: "request_choice",
              request_id: requestId,
              prompt: args.prompt,
              choices: args.choices,
            },
            requestId,
            timeoutMs,
          );
          return formatReply(reply, "User picked a choice.");
        },
      ),
    ],
  });
}

/**
 * Convert a `ToolReply` from the broker into the `CallToolResult` shape the
 * SDK expects. Each path returns a single text content block — the SDK only
 * cares that we return *something*; the model reads it as the tool result.
 */
function formatReply(reply: ToolReply, defaultMessage: string) {
  switch (reply.status) {
    case "accepted":
      return {
        content: [
          {
            type: "text" as const,
            text:
              typeof reply.data === "string"
                ? reply.data
                : JSON.stringify(reply.data ?? defaultMessage),
          },
        ],
      };
    case "approved":
      return {
        content: [
          {
            type: "text" as const,
            text: reply.reason
              ? `User approved. Note: ${reply.reason}`
              : "User approved the action. Proceed.",
          },
        ],
      };
    case "rejected":
      return {
        content: [
          {
            type: "text" as const,
            text: reply.reason
              ? `User rejected the action. Reason: ${reply.reason}`
              : "User rejected the action. Do not proceed.",
          },
        ],
        isError: true,
      };
    case "timeout":
      return {
        content: [
          {
            type: "text" as const,
            text:
              "No response from the user within the timeout. " +
              "Continue with a sensible default or stop and report.",
          },
        ],
        isError: true,
      };
    case "closed":
      return {
        content: [
          {
            type: "text" as const,
            text: "The user session ended before a reply was received.",
          },
        ],
        isError: true,
      };
  }
}

/**
 * Short request id. crypto.randomUUID() is overkill for an ephemeral key in
 * a per-session map and the long form is annoying to log; this is 16 hex
 * chars which is plenty for collision avoidance inside a single session.
 */
function randomId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * System-prompt fragment appended to every interactive session so Claude
 * knows when to call the three MCP tools instead of asking the user in
 * plain text. Imported by SessionManager and passed via the SDK's
 * `systemPrompt: { append }` option.
 */
export const INTERACTIVE_TOOLS_SYSTEM_PROMPT = `
You have three interactive tools available for talking to the human:

- mcp__spaiglass__request_user_input — When you need a value the user must
  type or paste (an API key, a passphrase, a OAuth code, a path, a name).
  Set "secret": true for anything sensitive — the frontend will mask the
  field and wipe the value after submission. NEVER ask for a secret in
  plain text in chat.

- mcp__spaiglass__request_approval — Before any irreversible, destructive,
  costly, or security-sensitive action (rm -rf, force-push, dropping a
  table, paying for an API call with an unknown bound, sending an email).
  Wait for explicit approval before proceeding.

- mcp__spaiglass__request_choice — When the next step has a small discrete
  set of valid options and you want the user to pick rather than type.

Default to these tools whenever they fit. They are faster for the user
than scrolling chat, they document the request in the session transcript,
and they enforce the security boundary around secrets and approvals.
`.trim();
