/**
 * SessionManager — Manages persistent Claude CLI sessions.
 *
 * Each session is keyed by (userId, workingDirectory, roleFile) and holds:
 * - A warm SDK session (via startup()) with an AsyncQueue feeding messages
 * - A set of WebSocket consumers (multiple devices, Telegram model)
 * - Session metadata
 *
 * Uses startup() for reliable initialization, then .query(asyncQueue) for
 * multi-turn messaging. Push user messages into the queue; the SDK yields
 * response messages which we broadcast to all consumers.
 */

import { type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Query, Options } from "@anthropic-ai/claude-agent-sdk";

// startup() is exported at runtime but missing from sdk.d.ts in 0.2.97
const { startup } =
  (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
    startup: (params: { options?: Options }) => Promise<{
      query: (prompt: string | AsyncIterable<SDKUserMessage>) => Query;
      close: () => void;
    }>;
  };
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";
import { AsyncQueue } from "./queue.ts";
import {
  pushFrame,
  isCursorLost,
  framesAfter,
  type BufferState,
} from "./buffer.ts";
import { FrameEmitter, type EmitContext } from "./frame-emitter.ts";
import type { Frame, InteractivePromptFrame } from "../../shared/frames.ts";
import { logger } from "../utils/logger.ts";
import { getClaudeSpawnEnv } from "../utils/anthropic-key.ts";
import { parseAgentFile } from "../utils/agent-config.ts";
import {
  createInteractiveToolsServer,
  INTERACTIVE_TOOLS_SYSTEM_PROMPT,
  type PendingToolBroker,
  type ToolReply,
} from "../mcp/interactive-tools.ts";

/**
 * Phase 6.4: in-flight interactive tool calls. Each entry is keyed by the
 * request_id that the MCP tool handler generated. The handler awaits the
 * Promise; the WS layer resolves it when a matching `tool_result` frame
 * arrives from the browser.
 */
interface PendingToolEntry {
  resolve: (reply: ToolReply) => void;
  // Stored as `unknown` because the timer types differ between Node and Bun
  // and we never read the value — only clearTimeout it.
  timer: ReturnType<typeof setTimeout>;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function mediaTypeForExt(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return map[ext] || "image/png";
}

export interface SessionConsumer {
  send: (data: string) => void;
  close: () => void;
  id: string;
}

export interface SessionInfo {
  id: string;
  userId: string;
  workingDirectory: string;
  roleFile: string;
  slashCommands: string[];
  createdAt: number;
  lastActivity: number;
  consumerCount: number;
}

interface Session {
  id: string;
  userId: string;
  workingDirectory: string;
  roleFile: string;
  sessionId: string | null; // Claude session ID (set after init)
  query: Query | null;
  queue: AsyncQueue<SDKUserMessage>;
  consumers: Map<string, SessionConsumer>;
  slashCommands: string[];
  createdAt: number;
  lastActivity: number;
  running: boolean;
  warmClose: (() => void) | null; // cleanup function from startup()
  // --- Phase 1: replay buffer (managed via session/buffer.ts helpers) ---
  buffer: BufferState;
  nextCursor: number; // monotonic, never reused, never resets
  // --- Phase 6.4: pending interactive tool calls ---
  pendingToolRequests: Map<string, PendingToolEntry>;
  // --- Phase B: terminal frame protocol emitter ---
  emitter: FrameEmitter;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private sessionLocks = new Map<string, Promise<SessionInfo>>();
  private cliPath: string;
  private maxSessions: number;

  constructor(cliPath: string, maxSessions = 10) {
    this.cliPath = cliPath;
    this.maxSessions = maxSessions;
  }

  private sessionKey(
    userId: string,
    workingDirectory: string,
    roleFile: string,
  ): string {
    return `${userId}:${workingDirectory}:${roleFile}`;
  }

  /**
   * Get or create a session for a (userId, workingDirectory, roleFile) tuple.
   * If a session exists and is alive, returns it (Telegram model).
   * Attaches the consumer to receive messages.
   */
  async getOrCreateSession(
    userId: string,
    workingDirectory: string,
    roleFile: string,
    consumer: SessionConsumer,
    contextContent?: string,
  ): Promise<SessionInfo> {
    const key = this.sessionKey(userId, workingDirectory, roleFile);

    // Mutex: if another call is already creating this session, wait for it
    const pending = this.sessionLocks.get(key);
    if (pending) {
      await pending;
      // After the lock resolves, the session exists — re-enter to attach consumer
      return this.getOrCreateSession(
        userId,
        workingDirectory,
        roleFile,
        consumer,
        contextContent,
      );
    }

    let session = this.sessions.get(key);

    if (session && session.running) {
      // Existing session — attach consumer
      session.consumers.set(consumer.id, consumer);
      session.lastActivity = Date.now();

      logger.app.info(
        "Consumer {consumerId} attached to existing session {sessionId}",
        {
          consumerId: consumer.id,
          sessionId: session.id,
        },
      );

      return this.toSessionInfo(session);
    }

    // Clean up dead session if exists
    if (session) {
      this.destroySession(key);
    }

    // Check capacity
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Max sessions (${this.maxSessions}) reached`);
    }

    // Lock this key while we create the session — prevents concurrent
    // getOrCreateSession calls from spawning duplicate CLI processes.
    let releaseLock!: (info: SessionInfo) => void;
    const lockPromise = new Promise<SessionInfo>((resolve) => {
      releaseLock = resolve;
    });
    this.sessionLocks.set(key, lockPromise);

    // Create new session
    session = {
      id: randomUUID(),
      userId,
      workingDirectory,
      roleFile,
      sessionId: null,
      query: null,
      queue: new AsyncQueue<SDKUserMessage>(),
      consumers: new Map([[consumer.id, consumer]]),
      slashCommands: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      running: true,
      warmClose: null,
      buffer: { frames: [], bufferedBytes: 0 },
      nextCursor: 1, // 1-based; clients use lastCursor=0 to mean "send everything"
      pendingToolRequests: new Map(),
      emitter: new FrameEmitter(),
    };

    this.sessions.set(key, session);

    // Start the SDK session in the background
    this.startSession(session, workingDirectory, contextContent);

    const info = this.toSessionInfo(session);

    // Release the lock so waiting callers can proceed
    this.sessionLocks.delete(key);
    releaseLock(info);

    logger.app.info(
      "New session {sessionId} for {userId}/{workingDirectory}/{roleFile}",
      {
      sessionId: session.id,
      userId,
      workingDirectory,
      roleFile,
      },
    );

    return info;
  }

  /**
   * Initialize a warm session via startup(), then consume SDK messages.
   */
  private async startSession(
    session: Session,
    workingDirectory: string,
    contextContent?: string,
  ): Promise<void> {
    try {
      logger.app.info("Starting warm session for {sessionId}...", {
        sessionId: session.id,
      });

      // Parse agent frontmatter if contextContent was provided.
      // The frontmatter may declare plugins, mcpServers, tools, model, etc.
      const parsed = contextContent
        ? parseAgentFile(contextContent)
        : { frontmatter: {}, body: contextContent || "" };
      const fm = parsed.frontmatter;
      const promptBody = parsed.body;

      const spawnEnv = getClaudeSpawnEnv() || {};

      // Phase 6.4: build the per-session interactive-tools broker.
      const broker = this.makeBroker(session);
      const interactiveServer = createInteractiveToolsServer(broker);

      // Merge MCP servers from frontmatter with the interactive tools server
      const mcpServers = {
        spaiglass: interactiveServer,
        ...(fm.mcpServers || {}),
      } as Record<string, import("@anthropic-ai/claude-agent-sdk").McpServerConfig>;

      // Use startup() for reliable initialization.
      //
      // pathToClaudeCodeExecutable MUST be passed explicitly. Without it the
      // SDK tries to resolve a bundled native claude binary via
      // `import.meta.url` relative paths — which are meaningless inside a
      // bun-compiled single-file host (everything is embedded in the
      // executable). That fallback throws "Native CLI binary for
      // linux-x64 not found" on every outside-user install.
      //
      // Since Anthropic's current installer (`curl https://claude.ai/install.sh | bash`)
      // drops a standalone ELF/Mach-O/PE binary at `this.cliPath`, the SDK's
      // isExecutable check (`!path.endsWith(".js"|".mjs"|...)`) returns true
      // and the SDK spawns the binary directly — no node/bun runtime needed
      // on the host. See backend/cli/validation.ts for how this.cliPath is
      // discovered. If a future Anthropic installer regresses to a JS-based
      // wrapper we'll need to fall back to spawnClaudeCodeProcess.
      const warmSession = await startup({
        options: {
          cwd: workingDirectory,
          pathToClaudeCodeExecutable: this.cliPath,
          permissionMode: (fm.permissionMode as "bypassPermissions" | undefined) || "bypassPermissions" as const,
          allowDangerouslySkipPermissions: true,
          mcpServers,
          ...(fm.tools ? { allowedTools: fm.tools } : {}),
          ...(fm.disallowedTools ? { disallowedTools: fm.disallowedTools } : {}),
          ...(fm.model ? { model: fm.model } : {}),
          ...(fm.maxTurns ? { maxTurns: fm.maxTurns } : {}),
          systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: [promptBody, INTERACTIVE_TOOLS_SYSTEM_PROMPT]
              .filter(Boolean)
              .join("\n\n"),
          },
          ...(Object.keys(spawnEnv).length > 0 ? { env: spawnEnv } : {}),
          stderr: (data: string) => {
            logger.app.error("CLI stderr: {data}", { data: data.trim() });
          },
        },
      });

      session.warmClose = warmSession.close;

      logger.app.info("Warm session ready, starting multi-turn query...");

      // Pass the AsyncQueue for multi-turn messaging
      const q = warmSession.query(session.queue);
      session.query = q;

      // Load plugins declared in role frontmatter via CLI commands.
      // These are queued before any user message, so Claude processes
      // them as soon as the session is ready.
      if (fm.plugins) {
        for (const [pluginId, enabled] of Object.entries(fm.plugins)) {
          const cmd = enabled
            ? `/plugin ${pluginId} enable`
            : `/plugin ${pluginId} disable`;
          session.queue.push({
            type: "user",
            message: { role: "user" as const, content: cmd },
            parent_tool_use_id: null,
            uuid: randomUUID(),
            session_id: session.sessionId || session.id,
          } as SDKUserMessage);
          logger.app.info("Queued plugin command: {cmd}", { cmd });
        }
      }

      // Consume SDK messages, translate to terminal frames via FrameEmitter,
      // and broadcast.
      for await (const sdkMessage of q) {
        if (!session.running) break;

        session.lastActivity = Date.now();

        // Capture session ID from init and emit a SessionInitFrame. We
        // build this directly via emitSessionInitFromManager rather than
        // emitFromSdkMessage so we can fill in fields the SDK message
        // does not carry (roleFile, workingDirectory).
        if (
          sdkMessage.type === "system" &&
          "subtype" in sdkMessage &&
          sdkMessage.subtype === "init"
        ) {
          session.sessionId = sdkMessage.session_id;
          if ("slash_commands" in sdkMessage) {
            session.slashCommands =
              (sdkMessage as { slash_commands: string[] }).slash_commands || [];
          }
          const initCtx = this.emitContext(session);
          const initFrame = session.emitter.emitSessionInitFromManager(
            {
              sessionId: session.sessionId ?? session.id,
              model:
                "model" in sdkMessage && typeof sdkMessage.model === "string"
                  ? sdkMessage.model
                  : "",
              permissionMode:
                "permission_mode" in sdkMessage &&
                typeof sdkMessage.permission_mode === "string"
                  ? (sdkMessage.permission_mode as
                      | "default"
                      | "acceptEdits"
                      | "bypassPermissions"
                      | "plan")
                  : "default",
              roleFile: session.roleFile,
              workingDirectory: session.workingDirectory,
              slashCommands: session.slashCommands,
            },
            initCtx,
          );
          this.broadcastFrame(session, initFrame);
          // Don't fall through to emitFromSdkMessage for init — we
          // already produced the init frame above, and emitFromSdkMessage
          // would produce a duplicate.
          continue;
        }

        // All other SDK messages go through emitFromSdkMessage.
        const ctx = this.emitContext(session);
        const frames = session.emitter.emitFromSdkMessage(
          sdkMessage as unknown as Parameters<
            FrameEmitter["emitFromSdkMessage"]
          >[0],
          ctx,
        );
        for (const frame of frames) {
          this.broadcastFrame(session, frame);
        }

        // File delivery detection — a side-channel frame used by the
        // file panel and the relay's delivery queue. This is in addition
        // to the frame stream above (the tool_call_start inside the
        // assistant message carries the same data, but the file panel
        // listens for this dedicated frame type).
        if (sdkMessage.type === "assistant" && sdkMessage.message?.content) {
          const content = sdkMessage.message.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (
                item.type === "tool_use" &&
                (item.name === "Write" || item.name === "Edit")
              ) {
                const input = item.input as Record<string, unknown>;
                const filePath = (input.file_path as string) || "";
                if (filePath) {
                  const fdCtx = this.emitContext(session);
                  const fdFrame = session.emitter.emitFileDelivery(
                    {
                      path: filePath,
                      filename: basename(filePath),
                      action: item.name === "Write" ? "write" : "edit",
                      oldString:
                        item.name === "Edit" &&
                        typeof input.old_string === "string"
                          ? input.old_string
                          : undefined,
                      newString:
                        item.name === "Edit" &&
                        typeof input.new_string === "string"
                          ? input.new_string
                          : undefined,
                      toolCallId: (item as { id?: string }).id,
                    },
                    fdCtx,
                  );
                  this.broadcastFrame(session, fdFrame);
                }
              }
            }
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.app.error("Session {sessionId} error: {msg}", {
        sessionId: session.id,
        msg,
      });

      const errCtx = this.emitContext(session);
      const errFrame = session.emitter.emitError(
        "session_error",
        msg,
        undefined,
        errCtx,
      );
      this.broadcastFrame(session, errFrame);
    } finally {
      session.running = false;
      const endCtx = this.emitContext(session);
      const endFrame = session.emitter.emitSessionEnd(
        "error",
        "cli_exited",
        endCtx,
      );
      this.broadcastFrame(session, endFrame);

      logger.app.info("Session {sessionId} ended", { sessionId: session.id });
    }
  }

  /**
   * Build an EmitContext bound to this session. The context's nextSeq
   * reads and increments the session cursor; every frame produced gets
   * stamped with the next cursor value. ts is snapshotted at call time.
   */
  private emitContext(session: Session): EmitContext {
    const ts = Date.now();
    return {
      nextSeq: () => session.nextCursor++,
      ts,
    };
  }

  /**
   * Send a user message to a session.
   */
  async sendMessage(
    userId: string,
    workingDirectory: string,
    roleFile: string,
    content: string,
    attachments?: string[],
  ): Promise<void> {
    const key = this.sessionKey(userId, workingDirectory, roleFile);
    const session = this.sessions.get(key);
    if (!session || !session.running) {
      throw new Error("No active session");
    }

    session.lastActivity = Date.now();

    // Build content blocks
    const contentBlocks: unknown[] = [];
    const textParts: string[] = [];

    if (attachments && attachments.length > 0) {
      for (const filePath of attachments) {
        const ext = extname(filePath).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          try {
            const data = await fs.readFile(filePath);
            contentBlocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: mediaTypeForExt(ext),
                data: data.toString("base64"),
              },
            });
          } catch {
            textParts.push(`[Could not read image: ${basename(filePath)}]`);
          }
        } else {
          try {
            const text = await fs.readFile(filePath, "utf8");
            textParts.push(
              `[Attached file: ${basename(filePath)}]\n\`\`\`\n${text}\n\`\`\``,
            );
          } catch {
            textParts.push(`[Could not read file: ${basename(filePath)}]`);
          }
        }
      }
    }

    // Build the message
    let messageContent: string | unknown[];

    if (contentBlocks.length > 0) {
      // Has images — use content block array
      for (const part of textParts) {
        contentBlocks.push({ type: "text", text: part });
      }
      const userText =
        content.trim() || (textParts.length > 0 ? "" : "See attached.");
      if (userText) {
        contentBlocks.push({ type: "text", text: userText });
      }
      messageContent = contentBlocks;
    } else if (textParts.length > 0) {
      // Text files only — inline into string
      messageContent = [...textParts, content].filter(Boolean).join("\n\n");
    } else {
      messageContent = content;
    }

    const userMessage: SDKUserMessage = {
      type: "user",
      message: {
        role: "user" as const,
        content: messageContent,
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: session.sessionId || session.id,
    } as SDKUserMessage;

    session.queue.push(userMessage);
  }

  /**
   * Interrupt the current response.
   */
  async interrupt(
    userId: string,
    workingDirectory: string,
    roleFile: string,
  ): Promise<void> {
    const key = this.sessionKey(userId, workingDirectory, roleFile);
    const session = this.sessions.get(key);
    if (!session?.query || !session.running) return;

    try {
      await session.query.interrupt();
      logger.app.info("Session {sessionId} interrupted", {
        sessionId: session.id,
      });
    } catch (err) {
      logger.app.error("Interrupt failed: {err}", { err });
    }
  }

  /**
   * Resume a session from a client-supplied cursor.
   *
   * Phase 1 reconnect protocol. The client passes the highest cursor it has
   * already rendered. Behavior:
   * - No matching session → throw (caller should fall back to session_start).
   * - Cursor older than the buffer's oldest frame → send `resume_lost`,
   *   do NOT attach. The client should clear local state and start fresh.
   * - Cursor equal to or newer than the buffer's range → replay all frames
   *   with cursor > lastCursor, then attach the consumer for live streaming.
   *
   * `lastCursor === 0` means "I have nothing — replay everything you have".
   */
  resumeFromCursor(
    userId: string,
    workingDirectory: string,
    roleFile: string,
    consumer: SessionConsumer,
    lastCursor: number,
  ): { resumed: true; replayedFrames: number } | { resumed: false } {
    const key = this.sessionKey(userId, workingDirectory, roleFile);
    const session = this.sessions.get(key);

    if (!session) {
      // No live session — caller should send session_start to create a new one
      return { resumed: false };
    }

    if (isCursorLost(session.buffer, lastCursor)) {
      const oldest = session.buffer.frames[0];
      try {
        consumer.send(
          JSON.stringify({
            type: "resume_lost",
            reason: "buffer_aged_out",
            oldestCursor: oldest?.cursor ?? session.nextCursor,
            requestedCursor: lastCursor,
          }),
        );
      } catch {
        // Consumer dead before we could even tell them
      }
      return { resumed: false };
    }

    // Replay missed frames
    const toReplay = framesAfter(session.buffer, lastCursor);
    let replayed = 0;
    for (const frame of toReplay) {
      try {
        consumer.send(frame.data);
        replayed++;
      } catch {
        // Consumer dead mid-replay — bail
        return { resumed: false };
      }
    }

    // Attach for live streaming
    session.consumers.set(consumer.id, consumer);
    session.lastActivity = Date.now();

    logger.app.info(
      "Consumer {consumerId} resumed session {sessionId} from cursor {lastCursor} ({replayed} frames replayed)",
      {
        consumerId: consumer.id,
        sessionId: session.id,
        lastCursor,
        replayed,
      },
    );

    return { resumed: true, replayedFrames: replayed };
  }

  /**
   * Remove a consumer from a session.
   */
  removeConsumer(
    userId: string,
    workingDirectory: string,
    roleFile: string,
    consumerId: string,
  ): void {
    const key = this.sessionKey(userId, workingDirectory, roleFile);
    const session = this.sessions.get(key);
    if (!session) return;

    session.consumers.delete(consumerId);

    // Don't destroy session when last consumer leaves — Telegram model.
    // Session stays alive for reconnect. Cleanup via timeout.
    logger.app.info(
      "Consumer {consumerId} removed from session {sessionId} ({remaining} remaining)",
      {
        consumerId,
        sessionId: session.id,
        remaining: session.consumers.size,
      },
    );
  }

  /**
   * Explicitly restart a session (user requested fresh start).
   */
  async restartSession(
    userId: string,
    workingDirectory: string,
    roleFile: string,
    consumer: SessionConsumer,
    contextContent?: string,
  ): Promise<SessionInfo> {
    const key = this.sessionKey(userId, workingDirectory, roleFile);
    this.destroySession(key);
    return this.getOrCreateSession(
      userId,
      workingDirectory,
      roleFile,
      consumer,
      contextContent,
    );
  }

  /**
   * Destroy a session and clean up resources.
   */
  private destroySession(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;

    session.running = false;
    session.queue.end();
    if (session.warmClose) {
      session.warmClose();
    }

    // Phase 6.4: fail any in-flight interactive tool calls so the MCP tool
    // handlers do not hang after the SDK is gone. The tool handler will
    // return a "session closed" error result to Claude (which is moot at
    // this point but keeps the Promise from leaking).
    for (const [, entry] of session.pendingToolRequests) {
      clearTimeout(entry.timer);
      try {
        entry.resolve({ status: "closed" });
      } catch {
        // Already settled — ignore
      }
    }
    session.pendingToolRequests.clear();

    // Clear the emitter's tool_use_id cache so stale ids cannot leak into
    // a replacement session. (Not strictly necessary since we discard the
    // whole Session object, but matches the explicit lifecycle in tests.)
    session.emitter.reset();

    this.sessions.delete(key);

    logger.app.info("Session {sessionId} destroyed", { sessionId: session.id });
  }

  /**
   * Phase 6.4: build a per-session broker that the in-process MCP server
   * uses to ask the browser questions and wait for an answer. The broker:
   *
   *   - Stores `{resolve, timer}` in `session.pendingToolRequests` keyed by
   *     the request_id the tool handler generated.
   *   - Broadcasts the prompt frame to every consumer of the session (so
   *     every browser tab attached to this session sees the widget).
   *   - Resolves the Promise with `{status: "timeout"}` after `timeoutMs`
   *     so a stalled or closed browser tab cannot pin Claude forever.
   *   - The matching `tool_result` frame from the browser is routed by
   *     `handleToolResult` below, which looks the entry up by request_id
   *     and resolves the Promise with the user's reply.
   */
  private makeBroker(session: Session): PendingToolBroker {
    return {
      request: (rawFrame, requestId, timeoutMs) => {
        return new Promise<ToolReply>((resolve) => {
          // If the session has already gone away by the time the SDK
          // dispatches the call, fail fast instead of installing an entry
          // that will never be cleaned up.
          if (!session.running) {
            resolve({ status: "closed" });
            return;
          }

          const timer = setTimeout(() => {
            const entry = session.pendingToolRequests.get(requestId);
            if (!entry) return;
            session.pendingToolRequests.delete(requestId);
            resolve({ status: "timeout" });
          }, timeoutMs);

          session.pendingToolRequests.set(requestId, { resolve, timer });

          // Phase B: translate the MCP tool's raw frame shape into an
          // InteractivePromptFrame. The MCP handlers emit objects shaped
          // like { type: "prompt_secret"|"tool_permission"|"request_choice",
          // request_id, ... }; here we map them onto the unified
          // InteractivePromptFrame with a `kind` discriminator.
          const kind = this.normalizeInteractiveKind(rawFrame);
          if (!kind) {
            // Unknown interactive shape — fail the request rather than
            // broadcasting a malformed frame.
            session.pendingToolRequests.delete(requestId);
            clearTimeout(timer);
            resolve({ status: "rejected", reason: "unknown_interactive_kind" });
            return;
          }
          const ctx = this.emitContext(session);
          const promptFrame = session.emitter.emitInteractivePrompt(
            {
              requestId,
              kind,
              prompt:
                typeof rawFrame.prompt === "string"
                  ? rawFrame.prompt
                  : undefined,
              secret:
                typeof rawFrame.secret === "boolean"
                  ? rawFrame.secret
                  : undefined,
              placeholder:
                typeof rawFrame.placeholder === "string"
                  ? rawFrame.placeholder
                  : null,
              action:
                typeof rawFrame.action === "string"
                  ? rawFrame.action
                  : undefined,
              details:
                typeof rawFrame.details === "string"
                  ? rawFrame.details
                  : null,
              choices: Array.isArray(rawFrame.choices)
                ? (rawFrame.choices as string[])
                : undefined,
            },
            ctx,
          );
          this.broadcastFrame(session, promptFrame);
        });
      },
    };
  }

  /**
   * Map the MCP tool's raw frame type to the InteractivePromptFrame kind.
   * Returns null for unrecognized shapes so the caller can reject the
   * request rather than sending garbage to the frontend.
   */
  private normalizeInteractiveKind(
    rawFrame: Record<string, unknown>,
  ): InteractivePromptFrame["kind"] | null {
    switch (rawFrame.type) {
      case "prompt_secret":
        return "prompt_secret";
      case "tool_permission":
        return "tool_permission";
      case "request_choice":
        return "request_choice";
      default:
        return null;
    }
  }

  /**
   * Phase 6.4: route a `tool_result` frame from a browser back to the
   * matching pending MCP tool handler.
   *
   * Frame shape (validated by the WS handler before this is called):
   *   { type: "tool_result", original_request_id: string,
   *     status: "accepted" | "approved" | "rejected",
   *     data?: unknown, reason?: string }
   *
   * Multi-tab handling: the FIRST reply to land wins. Any subsequent reply
   * for the same request_id is silently dropped (the entry is already gone
   * from the map). Order: whichever browser tab clicks first.
   */
  handleToolResult(
    userId: string,
    workingDirectory: string,
    roleFile: string,
    frame: Record<string, unknown>,
  ): void {
    const key = this.sessionKey(userId, workingDirectory, roleFile);
    const session = this.sessions.get(key);
    if (!session) return;

    const requestId = frame.original_request_id;
    if (typeof requestId !== "string") return;

    const entry = session.pendingToolRequests.get(requestId);
    if (!entry) return;

    session.pendingToolRequests.delete(requestId);
    clearTimeout(entry.timer);

    const status = frame.status;
    if (
      status !== "accepted" &&
      status !== "approved" &&
      status !== "rejected"
    ) {
      // Malformed status — treat as a rejection so the model gets a
      // sensible result rather than the call hanging.
      entry.resolve({ status: "rejected", reason: "malformed_tool_result" });
      // Emit a resolution frame so the frontend can mark the widget
      // answered (matches Phase A's `answered` bit).
      const ctx = this.emitContext(session);
      this.broadcastFrame(
        session,
        session.emitter.emitInteractiveResolved(requestId, "rejected", ctx),
      );
      return;
    }

    entry.resolve({
      status,
      data: frame.data,
      reason: typeof frame.reason === "string" ? frame.reason : undefined,
    });

    // Emit the resolution frame so every attached consumer updates its
    // widget state (and replay after reconnect sees the resolved state).
    const ctx = this.emitContext(session);
    this.broadcastFrame(
      session,
      session.emitter.emitInteractiveResolved(requestId, status, ctx),
    );
  }

  /**
   * Get info for all active sessions.
   */
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => this.toSessionInfo(s));
  }

  /**
   * Clean up inactive sessions.
   *
   * Default 30 min idle (Phase 1 v1 — see ROADMAP). A session is "idle" if
   * no broadcast frame has been emitted for `maxInactiveMs`. Sessions with
   * an actively producing Claude process keep their `lastActivity` updated
   * on every frame, so they survive indefinitely until output stops.
   */
  cleanup(maxInactiveMs = 30 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivity > maxInactiveMs) {
        this.destroySession(key);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * Broadcast a terminal protocol frame to all live consumers AND record
   * it in the session's ring buffer for replay on reconnect.
   *
   * The frame already has its `seq` stamped by the FrameEmitter's
   * EmitContext; we use that value as the ring buffer cursor so the
   * resume/replay protocol is unchanged. The wire format sends the frame
   * as-is with its `seq` field — clients track the highest seq seen and
   * pass it back on resume as `lastCursor`.
   */
  private broadcastFrame(session: Session, frame: Frame): void {
    const data = JSON.stringify(frame);
    const bytes = Buffer.byteLength(data, "utf8");

    pushFrame(session.buffer, { cursor: frame.seq, data, bytes });

    // Send to live consumers
    for (const consumer of session.consumers.values()) {
      try {
        consumer.send(data);
      } catch {
        // Consumer disconnected — will be cleaned up separately
      }
    }
  }

  private toSessionInfo(session: Session): SessionInfo {
    return {
      id: session.id,
      userId: session.userId,
      workingDirectory: session.workingDirectory,
      roleFile: session.roleFile,
      slashCommands: session.slashCommands,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      consumerCount: session.consumers.size,
    };
  }
}
