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
import { promises as fs, statSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  basename,
  extname,
  isAbsolute,
  resolve as resolvePath,
} from "node:path";
import { AsyncQueue } from "./queue.ts";
import {
  pushFrame,
  isCursorLost,
  framesAfter,
  type BufferState,
} from "./buffer.ts";
import {
  openSessionPersistence,
  sessionDirFor,
  readMaxSeq,
  readFramesAfter,
  readSessionMeta,
  touchContextFile,
  isInsideWorkingDirectory,
  type SessionPersistence,
} from "./persistence.ts";
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

/**
 * Resolve the SDK `thinking` config from the user's ~/.claude/settings.json.
 * Used when the SpaiGlass UI thinkingLevel is "auto" — defers to whatever
 * the fleet-wide settings baseline declares.
 *
 * Resolution order (mirrors what the Claude Code CLI itself does when no
 * explicit `thinking` option is passed):
 *   1. settings.json env.MAX_THINKING_TOKENS > 0 → enabled with that budget
 *   2. settings.json alwaysThinkingEnabled === true → adaptive
 *   3. neither → disabled
 */
function resolveThinkingFromSettings(): {
  type: "adaptive" | "enabled" | "disabled";
  budgetTokens?: number;
} {
  try {
    const raw = readFileSync(`${homedir()}/.claude/settings.json`, "utf8");
    const cfg = JSON.parse(raw) as {
      alwaysThinkingEnabled?: boolean;
      env?: { MAX_THINKING_TOKENS?: string | number };
    };
    const envBudget = cfg.env?.MAX_THINKING_TOKENS;
    const budget =
      typeof envBudget === "string"
        ? parseInt(envBudget, 10)
        : typeof envBudget === "number"
          ? envBudget
          : NaN;
    if (Number.isFinite(budget) && budget > 0) {
      return { type: "enabled", budgetTokens: budget };
    }
    if (cfg.alwaysThinkingEnabled === true) {
      return { type: "adaptive" };
    }
  } catch {
    // settings.json missing or unparsable — fall through to disabled.
  }
  return { type: "disabled" };
}

/**
 * Best-effort current git branch for `cwd`. Returns undefined if cwd isn't
 * a git working tree or git is unavailable. Surfaced on session_init so the
 * SpaiGlass header status badge can mirror the CLI status-line readout.
 */
function computeGitBranch(cwd: string): string | undefined {
  try {
    // `symbolic-ref --short HEAD` returns the branch name on a normal
    // checkout, fails on detached-HEAD; fall back to a short SHA in that
    // case so the badge still shows something useful.
    return (
      execFileSync("git", ["-C", cwd, "symbolic-ref", "--short", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
      }).trim() || undefined
    );
  } catch {
    try {
      return (
        execFileSync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1500,
        }).trim() || undefined
      );
    } catch {
      return undefined;
    }
  }
}

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

/**
 * Per-session UI preferences forwarded from the frontend on session_start
 * and session_restart. Used to configure the SDK at startup time. Mid-
 * session reconfiguration isn't supported by the SDK — a /reset / explicit
 * restart applies new values; the frontend emits a notice on toggle.
 */
export interface SessionPrefs {
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  /**
   * - off       → SDK thinking disabled
   * - brief     → SDK thinking enabled, 5k token budget
   * - extended  → SDK thinking enabled, 32k token budget
   * - auto      → derived from ~/.claude/settings.json: env.MAX_THINKING_TOKENS
   *               (if >0) becomes a fixed budget, else alwaysThinkingEnabled
   *               flips on adaptive, else disabled. This is the default UI
   *               value so the fleet-wide settings.json baseline reaches
   *               SpaiGlass users by default.
   */
  thinkingLevel?: "off" | "brief" | "extended" | "auto";
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
  // --- On-disk transcript (frames.jsonl + meta.json). May be null only
  //     while async open is still in flight; broadcastFrame tolerates that.
  persist: SessionPersistence | null;
  /**
   * Pending client-message-ids keyed by SDKUserMessage.uuid. Populated
   * when a UI sends a message; consumed on the SDK echo so the resulting
   * UserMessageFrame can carry the client id back. Multi-device session
   * mirroring uses the id to dedupe each client's local optimistic add
   * against its own echo while still rendering echoes from other clients.
   */
  pendingClientMessageIds: Map<string, string>;
  /** SDK thinking config the manager resolved at startup. Surfaced on
   *  the session_init frame so the SpaiGlass header can show the actual
   *  budget the SDK is running with (matters when thinkingLevel="auto"
   *  and we derived the value from ~/.claude/settings.json). */
  resolvedThinking?: {
    type: "adaptive" | "enabled" | "disabled";
    budgetTokens?: number;
  };
  /** Current git branch of workingDirectory (computed once at startSession). */
  gitBranch?: string;
  /** Output style override from role frontmatter (computed at startSession). */
  outputStyle?: string;
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
    resumeSessionId?: string,
    prefs?: SessionPrefs,
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
        resumeSessionId,
        prefs,
      );
    }

    let session = this.sessions.get(key);

    // If the caller wants to resume a specific Claude session ID and the
    // existing warm session is for a different one, tear it down and spawn
    // a new Claude process with `resume: <id>`. Matches `claude --resume`:
    // picking a different session = new CLI process with that session's
    // history loaded as context.
    if (
      session &&
      session.running &&
      resumeSessionId &&
      session.sessionId &&
      session.sessionId !== resumeSessionId
    ) {
      logger.app.info(
        "Resume mismatch — tearing down {oldId} to resume {newId}",
        { oldId: session.sessionId, newId: resumeSessionId },
      );
      this.destroySession(key);
      session = undefined;
    }

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

    // Continuity across restarts: if we've persisted frames for this tuple
    // before, pick up nextCursor just above the highest persisted seq so the
    // new session's cursors stay monotonic across the disk transcript.
    const diskDir = sessionDirFor(userId, workingDirectory, roleFile);
    const priorMaxSeq = await readMaxSeq(diskDir);

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
      nextCursor: priorMaxSeq + 1,
      pendingToolRequests: new Map(),
      emitter: new FrameEmitter(),
      persist: null,
      pendingClientMessageIds: new Map(),
    };

    this.sessions.set(key, session);

    // Open on-disk transcript. Non-blocking from the caller's perspective:
    // frames emitted before this resolves are buffered in memory and the
    // first append will flush cleanly because the Promise chain is
    // established inside openSessionPersistence.
    openSessionPersistence({
      id: session.id,
      userId,
      workingDirectory,
      roleFile,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
    })
      .then((p) => {
        session!.persist = p;
      })
      .catch((err) => {
        logger.app.error(
          "Failed to open persistence for session {sessionId}: {msg}",
          { sessionId: session!.id, msg: String(err) },
        );
      });

    // Start the SDK session in the background
    this.startSession(
      session,
      workingDirectory,
      contextContent,
      resumeSessionId,
      prefs,
    );

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
    resumeSessionId?: string,
    prefs?: SessionPrefs,
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
      } as Record<
        string,
        import("@anthropic-ai/claude-agent-sdk").McpServerConfig
      >;

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
      // `resume: <claudeSessionId>` makes the CLI load that session's full
      // JSONL transcript as conversation history — matches `claude --resume`
      // behaviour. If the transcript ends on an unanswered user turn, Claude
      // will answer it on attach; that's the same as the terminal and the
      // user explicitly signed off on this (2026-04-24).
      // Resolve the effective permission mode. Precedence: explicit user
      // pref from this WS session > role-file frontmatter > "bypassPermissions"
      // (legacy default — fleet was provisioned this way).
      const effectivePermissionMode: SessionPrefs["permissionMode"] =
        prefs?.permissionMode ??
        (fm.permissionMode as SessionPrefs["permissionMode"] | undefined) ??
        "bypassPermissions";

      // `allowDangerouslySkipPermissions` is required by the SDK only when
      // we actually want bypassPermissions — passing it with mode="default"
      // (or "plan"/"acceptEdits") was the bug that made the UI display
      // "Normal mode" while behavior was still bypass. Gate it on mode.
      const allowDangerouslySkipPermissions =
        effectivePermissionMode === "bypassPermissions";

      // Map the UI thinking level enum to the SDK's `thinking` option.
      // - off       → disabled
      // - brief     → enabled, 5k budget
      // - extended  → enabled, 32k budget
      // - auto      → derived from ~/.claude/settings.json
      //                 (alwaysThinkingEnabled / env.MAX_THINKING_TOKENS)
      // The default UI value is "auto", which makes the fleet-wide
      // settings.json baseline reach SpaiGlass users without forcing them
      // to discover the toggle. Per-session UI choice still overrides.
      const thinkingLevel = prefs?.thinkingLevel ?? "auto";
      const thinking =
        thinkingLevel === "extended"
          ? { type: "enabled" as const, budgetTokens: 32000 }
          : thinkingLevel === "brief"
            ? { type: "enabled" as const, budgetTokens: 5000 }
            : thinkingLevel === "off"
              ? { type: "disabled" as const }
              : resolveThinkingFromSettings();
      // Cache for the init-frame side-channel: the header status badge
      // shows the actual budget, not just the UI label.
      session.resolvedThinking = thinking;
      // Compute git branch + output-style for the header status badge.
      // Both are best-effort; absence is fine.
      session.gitBranch = computeGitBranch(workingDirectory);
      session.outputStyle =
        typeof fm.outputStyle === "string" ? fm.outputStyle : undefined;

      const warmSession = await startup({
        options: {
          cwd: workingDirectory,
          pathToClaudeCodeExecutable: this.cliPath,
          permissionMode: effectivePermissionMode,
          ...(allowDangerouslySkipPermissions
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          thinking,
          mcpServers,
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          ...(fm.tools ? { allowedTools: fm.tools } : {}),
          ...(fm.disallowedTools
            ? { disallowedTools: fm.disallowedTools }
            : {}),
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
          session.persist?.updateMeta({
            claudeSessionId: session.sessionId ?? undefined,
          });
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
              gitBranch: session.gitBranch,
              outputStyle: session.outputStyle,
              resolvedThinking: session.resolvedThinking,
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
        // Mark this as the live SDK path so the emitter skips its own
        // user_message emission for user-input echoes — sendMessage above
        // already authored the canonical UserMessageFrame at queue time.
        // Replay (parseConversationFile) and unit tests leave liveSdkPath
        // unset so they still get user_message frames from the SDK shape.
        const ctx = this.emitContext(session);
        ctx.liveSdkPath = true;
        // If this is a "user" echo of a UI-originated input, attach the
        // pending clientMessageId so the resulting frame carries the
        // round-trip id back. Look up by SDK uuid (set when we queued).
        if (sdkMessage.type === "user") {
          const sdkUuid = (sdkMessage as { uuid?: string }).uuid;
          if (sdkUuid) {
            const clientId = session.pendingClientMessageIds.get(sdkUuid);
            if (clientId) {
              ctx.userClientMessageId = clientId;
              session.pendingClientMessageIds.delete(sdkUuid);
            }
          }
        }
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
              if (item.type !== "tool_use") continue;
              const input = item.input as Record<string, unknown>;
              const rawPath =
                (typeof input.file_path === "string" && input.file_path) ||
                (typeof input.notebook_path === "string" &&
                  input.notebook_path) ||
                "";
              if (!rawPath) continue;
              const filePath = isAbsolute(rawPath)
                ? rawPath
                : resolvePath(session.workingDirectory, rawPath);

              const isWrite =
                item.name === "Write" ||
                item.name === "Edit" ||
                item.name === "MultiEdit" ||
                item.name === "NotebookEdit";
              if (isWrite) {
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
                this.touchContextIfInsideProject(session, filePath, "write");
              } else if (item.name === "Read") {
                this.touchContextIfInsideProject(session, filePath, "read");
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
    clientMessageId?: string,
    hideUserMessage?: boolean,
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
            // Tell Claude where the image actually landed on disk. Without
            // this, the agent only sees inline base64 and truthfully has
            // no way to answer "where is the file?" — it can't infer the
            // staging path from the bytes alone.
            contentBlocks.push({
              type: "text",
              text: `[Attached image saved at: ${filePath}]`,
            });
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
          // Non-image attachments: always surface the on-disk path so the
          // agent can open the file with Read instead of saying "no such
          // file". For small text files inline the content as a convenience;
          // for anything larger skip the inline and let the agent chunk via
          // Read — avoids blowing up the prompt with multi-MB HAR/log dumps.
          const INLINE_LIMIT_BYTES = 256 * 1024;
          try {
            const stat = await fs.stat(filePath);
            if (stat.size <= INLINE_LIMIT_BYTES) {
              const text = await fs.readFile(filePath, "utf8");
              textParts.push(
                `[Attached file saved at: ${filePath}]\n\`\`\`\n${text}\n\`\`\``,
              );
            } else {
              textParts.push(
                `[Attached file saved at: ${filePath} (${stat.size} bytes) — use Read to open it]`,
              );
            }
          } catch {
            textParts.push(
              `[Attached file saved at: ${filePath} — could not stat; try Read]`,
            );
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

    if (clientMessageId && userMessage.uuid) {
      session.pendingClientMessageIds.set(userMessage.uuid, clientMessageId);
    }

    // Authoritative UserMessageFrame: emit + broadcast + persist immediately
    // when the prompt is queued. Without this, typed prompts existed only
    // as client-side optimistic frames in the originating browser, never
    // reached frames.jsonl, and disappeared on reload. Sibling clients
    // (mobile/desktop mirroring) also depend on this — their reducers see
    // the message via the broadcast, since the SDK doesn't echo string
    // inputs back reliably.
    //
    // Skipped when hideUserMessage is set (permission "continue" / plan
    // "accept" — sent silently to the SDK without rendering as a user turn).
    if (!hideUserMessage) {
      const attachmentEntries = (attachments ?? []).map((path) => {
        let sizeBytes: number | undefined;
        try {
          sizeBytes = statSync(path).size;
        } catch {
          sizeBytes = undefined;
        }
        return {
          path,
          filename: basename(path),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        };
      });
      const ctx = this.emitContext(session);
      const uiUserFrame = session.emitter.emitUiUserMessage(
        content,
        attachmentEntries,
        ctx,
        clientMessageId,
      );
      this.broadcastFrame(session, uiUserFrame);
    }

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
  async resumeFromCursor(
    userId: string,
    workingDirectory: string,
    roleFile: string,
    consumer: SessionConsumer,
    lastCursor: number,
  ): Promise<{ resumed: true; replayedFrames: number } | { resumed: false }> {
    const key = this.sessionKey(userId, workingDirectory, roleFile);
    const session = this.sessions.get(key);

    if (!session) {
      return { resumed: false };
    }

    // Use the on-disk transcript as source of truth. The in-memory ring
    // buffer is capped (4 MiB / 20K frames) and loses history in long
    // sessions; disk has everything we've ever emitted for this tuple.
    // Flush pending async writes so the tail is visible to the read.
    if (session.persist) {
      await session.persist.flush();
      const lines = await readFramesAfter(session.persist.dir, lastCursor);
      let replayed = 0;
      for (const line of lines) {
        try {
          consumer.send(line);
          replayed++;
        } catch {
          return { resumed: false };
        }
      }
      session.consumers.set(consumer.id, consumer);
      session.lastActivity = Date.now();
      logger.app.info(
        "Consumer {consumerId} resumed session {sessionId} from cursor {lastCursor} ({replayed} frames from disk)",
        {
          consumerId: consumer.id,
          sessionId: session.id,
          lastCursor,
          replayed,
        },
      );
      return { resumed: true, replayedFrames: replayed };
    }

    // No persistence yet (writer still opening) — fall back to memory buffer.
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

    const toReplay = framesAfter(session.buffer, lastCursor);
    let replayed = 0;
    for (const frame of toReplay) {
      try {
        consumer.send(frame.data);
        replayed++;
      } catch {
        return { resumed: false };
      }
    }
    session.consumers.set(consumer.id, consumer);
    session.lastActivity = Date.now();
    return { resumed: true, replayedFrames: replayed };
  }

  /**
   * Cold rehydrate: no live in-memory session exists for this tuple, but a
   * persisted transcript may. Stream history (seq > lastCursor) to the
   * consumer without attaching them anywhere — the caller should tell the
   * client this is historical (they need to send `session_start` to chat).
   *
   * Returns `{ rehydrated: true, replayedFrames }` if any frames were
   * streamed, otherwise `{ rehydrated: false }`.
   */
  async rehydrateFromDisk(
    userId: string,
    workingDirectory: string,
    roleFile: string,
    consumer: SessionConsumer,
    lastCursor: number,
  ): Promise<
    { rehydrated: true; replayedFrames: number } | { rehydrated: false }
  > {
    const dir = sessionDirFor(userId, workingDirectory, roleFile);
    const meta = await readSessionMeta(dir);
    if (!meta) return { rehydrated: false };

    const lines = await readFramesAfter(dir, lastCursor);
    if (lines.length === 0) return { rehydrated: false };

    let replayed = 0;
    for (const line of lines) {
      try {
        consumer.send(line);
        replayed++;
      } catch {
        return { rehydrated: false };
      }
    }

    logger.app.info(
      "Consumer {consumerId} cold-rehydrated from disk ({replayed} frames, cursor > {lastCursor})",
      { consumerId: consumer.id, replayed, lastCursor },
    );
    return { rehydrated: true, replayedFrames: replayed };
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
    prefs?: SessionPrefs,
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
      undefined,
      prefs,
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

    // Flush pending transcript writes. Fire-and-forget: destroySession is
    // sync and callers don't await it; the queued chain inside persist will
    // resolve on its own.
    if (session.persist) {
      session.persist.close().catch(() => {});
    }

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
                typeof rawFrame.details === "string" ? rawFrame.details : null,
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
  /**
   * Record a file read/write in the persistent context-file index and emit a
   * live `context_file` frame so every attached client updates its Context
   * tab in real time. Paths outside the session's workingDirectory are
   * ignored (e.g. Claude reading its own ~/.claude/ files).
   */
  private touchContextIfInsideProject(
    session: Session,
    filePath: string,
    action: "read" | "write",
  ): void {
    if (!isInsideWorkingDirectory(filePath, session.workingDirectory)) return;

    const filename = basename(filePath);
    const dir = sessionDirFor(
      session.userId,
      session.workingDirectory,
      session.roleFile,
    );

    touchContextFile(dir, filePath, action, filename)
      .then((entry) => {
        const ctx = this.emitContext(session);
        const frame = session.emitter.emitContextFile(
          { ...entry, action },
          ctx,
        );
        this.broadcastFrame(session, frame);
      })
      .catch((err) => {
        logger.app.error("Context file update failed: {msg}", {
          msg: String(err),
        });
      });
  }

  private broadcastFrame(session: Session, frame: Frame): void {
    const data = JSON.stringify(frame);
    const bytes = Buffer.byteLength(data, "utf8");

    pushFrame(session.buffer, { cursor: frame.seq, data, bytes });

    // Persist to on-disk transcript (if the writer has opened; early frames
    // that race the open are rare — init waits on the SDK spawn).
    session.persist?.append(data);

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
