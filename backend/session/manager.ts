/**
 * SessionManager — Manages persistent Claude CLI sessions.
 *
 * Each session is keyed by (userId, roleFile) and holds:
 * - A warm SDK session (via startup()) with an AsyncQueue feeding messages
 * - A set of WebSocket consumers (multiple devices, Telegram model)
 * - Session metadata
 *
 * Uses startup() for reliable initialization, then .query(asyncQueue) for
 * multi-turn messaging. Push user messages into the queue; the SDK yields
 * response messages which we broadcast to all consumers.
 */

import { type SDKUserMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Query, Options } from "@anthropic-ai/claude-agent-sdk";

// startup() is exported at runtime but missing from sdk.d.ts in 0.2.97
const { startup } = await import("@anthropic-ai/claude-agent-sdk") as unknown as {
  startup: (params: { options?: Options }) => Promise<{
    query: (prompt: string | AsyncIterable<SDKUserMessage>) => Query;
    close: () => void;
  }>;
};
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";
import { AsyncQueue } from "./queue.ts";
import { logger } from "../utils/logger.ts";

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
  roleFile: string;
  slashCommands: string[];
  createdAt: number;
  lastActivity: number;
  consumerCount: number;
}

interface Session {
  id: string;
  userId: string;
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
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private cliPath: string;
  private maxSessions: number;

  constructor(cliPath: string, maxSessions = 10) {
    this.cliPath = cliPath;
    this.maxSessions = maxSessions;
  }

  private sessionKey(userId: string, roleFile: string): string {
    return `${userId}:${roleFile}`;
  }

  /**
   * Get or create a session for a (userId, roleFile) pair.
   * If a session exists and is alive, returns it (Telegram model).
   * Attaches the consumer to receive messages.
   */
  async getOrCreateSession(
    userId: string,
    roleFile: string,
    workingDirectory: string,
    consumer: SessionConsumer,
    contextContent?: string,
  ): Promise<SessionInfo> {
    const key = this.sessionKey(userId, roleFile);
    let session = this.sessions.get(key);

    if (session && session.running) {
      // Existing session — attach consumer
      session.consumers.set(consumer.id, consumer);
      session.lastActivity = Date.now();

      logger.app.info("Consumer {consumerId} attached to existing session {sessionId}", {
        consumerId: consumer.id,
        sessionId: session.id,
      });

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

    // Create new session
    session = {
      id: randomUUID(),
      userId,
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
    };

    this.sessions.set(key, session);

    // Start the SDK session in the background
    this.startSession(session, workingDirectory, contextContent);

    logger.app.info("New session {sessionId} for {userId}/{roleFile}", {
      sessionId: session.id,
      userId,
      roleFile,
    });

    return this.toSessionInfo(session);
  }

  /**
   * Initialize a warm session via startup(), then consume SDK messages.
   */
  private async startSession(
    session: Session,
    workingDirectory: string,
    _contextContent?: string,
  ): Promise<void> {
    try {
      logger.app.info("Starting warm session for {sessionId}...", { sessionId: session.id });

      // Use startup() for reliable initialization — let SDK use its own bundled CLI
      const warmSession = await startup({
        options: {
          cwd: workingDirectory,
          permissionMode: "bypassPermissions" as const,
          allowDangerouslySkipPermissions: true,
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

      // Consume SDK messages and broadcast
      for await (const sdkMessage of q) {
        if (!session.running) break;

        session.lastActivity = Date.now();

        // Capture session ID from init
        if (sdkMessage.type === "system" && "subtype" in sdkMessage && sdkMessage.subtype === "init") {
          session.sessionId = sdkMessage.session_id;
          if ("slash_commands" in sdkMessage) {
            session.slashCommands = (sdkMessage as { slash_commands: string[] }).slash_commands || [];
          }

          // Send session info to all consumers
          this.broadcast(session, JSON.stringify({
            type: "session_info",
            sessionId: session.id,
            claudeSessionId: session.sessionId,
            slashCommands: session.slashCommands,
          }));
        }

        // Broadcast SDK message
        this.broadcast(session, JSON.stringify({
          type: "sdk_message",
          data: sdkMessage,
        }));

        // File delivery detection
        if (sdkMessage.type === "assistant" && sdkMessage.message?.content) {
          const content = sdkMessage.message.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === "tool_use" && (item.name === "Write" || item.name === "Edit")) {
                const input = item.input as Record<string, unknown>;
                const filePath = (input.file_path as string) || "";
                if (filePath) {
                  this.broadcast(session, JSON.stringify({
                    type: "file_delivery",
                    data: {
                      path: filePath,
                      filename: basename(filePath),
                      action: item.name === "Write" ? "write" : "edit",
                    },
                  }));
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

      this.broadcast(session, JSON.stringify({
        type: "error",
        message: msg,
      }));
    } finally {
      session.running = false;
      this.broadcast(session, JSON.stringify({
        type: "session_ended",
        reason: "cli_exited",
      }));

      logger.app.info("Session {sessionId} ended", { sessionId: session.id });
    }
  }

  /**
   * Send a user message to a session.
   */
  async sendMessage(
    userId: string,
    roleFile: string,
    content: string,
    attachments?: string[],
  ): Promise<void> {
    const key = this.sessionKey(userId, roleFile);
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
            textParts.push(`[Attached file: ${basename(filePath)}]\n\`\`\`\n${text}\n\`\`\``);
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
      const userText = content.trim() || (textParts.length > 0 ? "" : "See attached.");
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
  async interrupt(userId: string, roleFile: string): Promise<void> {
    const key = this.sessionKey(userId, roleFile);
    const session = this.sessions.get(key);
    if (!session?.query || !session.running) return;

    try {
      await session.query.interrupt();
      logger.app.info("Session {sessionId} interrupted", { sessionId: session.id });
    } catch (err) {
      logger.app.error("Interrupt failed: {err}", { err });
    }
  }

  /**
   * Remove a consumer from a session.
   */
  removeConsumer(userId: string, roleFile: string, consumerId: string): void {
    const key = this.sessionKey(userId, roleFile);
    const session = this.sessions.get(key);
    if (!session) return;

    session.consumers.delete(consumerId);

    // Don't destroy session when last consumer leaves — Telegram model.
    // Session stays alive for reconnect. Cleanup via timeout.
    logger.app.info("Consumer {consumerId} removed from session {sessionId} ({remaining} remaining)", {
      consumerId,
      sessionId: session.id,
      remaining: session.consumers.size,
    });
  }

  /**
   * Explicitly restart a session (user requested fresh start).
   */
  async restartSession(
    userId: string,
    roleFile: string,
    workingDirectory: string,
    consumer: SessionConsumer,
    contextContent?: string,
  ): Promise<SessionInfo> {
    const key = this.sessionKey(userId, roleFile);
    this.destroySession(key);
    return this.getOrCreateSession(userId, roleFile, workingDirectory, consumer, contextContent);
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
    this.sessions.delete(key);

    logger.app.info("Session {sessionId} destroyed", { sessionId: session.id });
  }

  /**
   * Get info for all active sessions.
   */
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => this.toSessionInfo(s));
  }

  /**
   * Clean up inactive sessions.
   */
  cleanup(maxInactiveMs = 24 * 60 * 60 * 1000): number {
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

  private broadcast(session: Session, data: string): void {
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
      roleFile: session.roleFile,
      slashCommands: session.slashCommands,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      consumerCount: session.consumers.size,
    };
  }
}
