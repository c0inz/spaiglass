import { Context } from "hono";
import {
  query,
  type PermissionMode,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatRequest,
  StreamResponse,
  FileDelivery,
} from "../../shared/types.ts";
import { basename, extname } from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.ts";
import { getClaudeSpawnEnv } from "../utils/anthropic-key.ts";

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

/**
 * Process attachments and return the prompt.
 *
 * Text files: read content and inline into the string prompt (simple, reliable).
 * Images: must use AsyncIterable with base64 content blocks (only way to send images).
 *
 * Returns { prompt, hasImages } so the caller can adjust SDK options.
 */
async function processAttachments(
  message: string,
  attachments: string[],
  sessionId?: string,
): Promise<{
  prompt: string | AsyncIterable<SDKUserMessage>;
  hasImages: boolean;
}> {
  const textParts: string[] = [];
  const imageBlocks: unknown[] = [];

  for (const filePath of attachments) {
    const ext = extname(filePath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const data = await fs.readFile(filePath);
        imageBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaTypeForExt(ext),
            data: data.toString("base64"),
          },
        });
        logger.chat.info("Image attached: {path} ({size} bytes)", {
          path: filePath,
          size: data.length,
        });
      } catch {
        logger.chat.error("Failed to read image: {path}", { path: filePath });
        textParts.push(`[Could not read image: ${basename(filePath)}]`);
      }
    } else {
      // Text/code file — inline into prompt string
      try {
        const text = await fs.readFile(filePath, "utf8");
        const name = basename(filePath);
        textParts.push(`[Attached file: ${name}]\n\`\`\`\n${text}\n\`\`\``);
        logger.chat.info("Text file attached: {path}", { path: filePath });
      } catch {
        textParts.push(`[Could not read file: ${basename(filePath)}]`);
      }
    }
  }

  // If no images, just inline everything into the string prompt
  if (imageBlocks.length === 0) {
    const combined = [...textParts, message].filter(Boolean).join("\n\n");
    return { prompt: combined || "See attached file.", hasImages: false };
  }

  // Images present — must use AsyncIterable with content blocks
  const contentBlocks: unknown[] = [...imageBlocks];

  // Add any inlined text file content
  for (const part of textParts) {
    contentBlocks.push({ type: "text", text: part });
  }

  // Add user's message text
  const userText = message.trim() || "See attached.";
  contentBlocks.push({ type: "text", text: userText });

  async function* gen(): AsyncIterable<SDKUserMessage> {
    yield {
      type: "user",
      message: {
        role: "user" as const,
        content: contentBlocks,
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: sessionId || randomUUID(),
    } as SDKUserMessage;
  }

  return { prompt: gen(), hasImages: true };
}

/**
 * Executes a Claude command and yields streaming responses
 * @param message - User message or command
 * @param requestId - Unique request identifier for abort functionality
 * @param requestAbortControllers - Shared map of abort controllers
 * @param cliPath - Path to actual CLI script (detected by validateClaudeCli)
 * @param sessionId - Optional session ID for conversation continuity
 * @param allowedTools - Optional array of allowed tool names
 * @param workingDirectory - Optional working directory for Claude execution
 * @param permissionMode - Optional permission mode for Claude execution
 * @returns AsyncGenerator yielding StreamResponse objects
 */
async function* executeClaudeCommand(
  message: string,
  requestId: string,
  requestAbortControllers: Map<string, AbortController>,
  cliPath: string,
  sessionId?: string,
  allowedTools?: string[],
  workingDirectory?: string,
  permissionMode?: PermissionMode,
  attachments?: string[],
  maxThinkingTokens?: number,
): AsyncGenerator<StreamResponse> {
  let abortController: AbortController;

  try {
    // Pass message through as-is — slash commands like /help, /compact etc.
    // are handled by the Claude Code CLI directly
    let processedMessage = message;

    // Create and store AbortController for this request
    abortController = new AbortController();
    requestAbortControllers.set(requestId, abortController);

    // Build prompt — inline text files, use content blocks for images
    let prompt: string | AsyncIterable<SDKUserMessage> = processedMessage;
    let hasImages = false;

    if (attachments && attachments.length > 0) {
      const result = await processAttachments(
        processedMessage,
        attachments,
        sessionId,
      );
      prompt = result.prompt;
      hasImages = result.hasImages;
    }

    // Phase 4: BYO Anthropic key — inject ANTHROPIC_API_KEY into the spawn
    // env when the user has supplied one via .env or the settings UI.
    // Returns undefined when no key is set so default subscription auth
    // remains the path of least surprise.
    const spawnEnv = getClaudeSpawnEnv();

    // When using AsyncIterable (images), the session_id is embedded in the message,
    // so we skip the `resume` option to avoid conflicts with stream-json mode.
    for await (const sdkMessage of query({
      prompt,
      options: {
        abortController,
        executable: "node" as const,
        executableArgs: [],
        pathToClaudeCodeExecutable: cliPath,
        ...(!hasImages && sessionId ? { resume: sessionId } : {}),
        ...(allowedTools ? { allowedTools } : {}),
        ...(workingDirectory ? { cwd: workingDirectory } : {}),
        ...(maxThinkingTokens ? { maxThinkingTokens } : {}),
        ...(spawnEnv ? { env: spawnEnv } : {}),
        permissionMode: "bypassPermissions" as const,
        allowDangerouslySkipPermissions: true,
      },
    })) {
      // Debug logging of raw SDK messages with detailed content
      logger.chat.debug("Claude SDK Message: {sdkMessage}", { sdkMessage });

      yield {
        type: "claude_json",
        data: sdkMessage,
      };

      // Detect file write/edit events and inject file_delivery messages
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
                const delivery: FileDelivery = {
                  path: filePath,
                  filename: basename(filePath),
                  action: item.name === "Write" ? "write" : "edit",
                };
                if (item.name === "Edit") {
                  if (typeof input.old_string === "string") delivery.oldString = input.old_string;
                  if (typeof input.new_string === "string") delivery.newString = input.new_string;
                }
                yield {
                  type: "file_delivery",
                  data: delivery,
                } as StreamResponse;
              }
            }
          }
        }
      }
    }

    yield { type: "done" };
  } catch (error) {
    // Check if error is due to abort
    // TODO: Re-enable when AbortError is properly exported from Claude SDK
    // if (error instanceof AbortError) {
    //   yield { type: "aborted" };
    // } else {
    {
      logger.chat.error("Claude Code execution failed: {error}", { error });
      yield {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    // Clean up AbortController from map
    if (requestAbortControllers.has(requestId)) {
      requestAbortControllers.delete(requestId);
    }
  }
}

/**
 * Handles POST /api/chat requests with streaming responses
 * @param c - Hono context object with config variables
 * @param requestAbortControllers - Shared map of abort controllers
 * @returns Response with streaming NDJSON
 */
export async function handleChatRequest(
  c: Context,
  requestAbortControllers: Map<string, AbortController>,
) {
  const chatRequest: ChatRequest = await c.req.json();
  const { cliPath } = c.var.config;

  logger.chat.debug(
    "Received chat request {*}",
    chatRequest as unknown as Record<string, unknown>,
  );

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of executeClaudeCommand(
          chatRequest.message,
          chatRequest.requestId,
          requestAbortControllers,
          cliPath, // Use detected CLI path from validateClaudeCli
          chatRequest.sessionId,
          chatRequest.allowedTools,
          chatRequest.workingDirectory,
          chatRequest.permissionMode,
          chatRequest.attachments,
          chatRequest.maxThinkingTokens,
        )) {
          const data = JSON.stringify(chunk) + "\n";
          controller.enqueue(new TextEncoder().encode(data));
        }
        controller.close();
      } catch (error) {
        const errorResponse: StreamResponse = {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        };
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(errorResponse) + "\n"),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      // no-transform prevents proxies from mangling chunks; X-Accel-Buffering
      // tells nginx to flush every write immediately. Without these, messages
      // queue up in intermediate buffers and the client spinner hangs until
      // the whole response is drained at stream close.
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
