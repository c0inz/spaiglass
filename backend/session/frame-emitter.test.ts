/**
 * FrameEmitter unit tests (Phase B Step 2).
 *
 * These exercise the translation layer from SDK messages to terminal
 * frames. Each test uses a deterministic `nextSeq` counter and fixed
 * timestamp so output is fully reproducible, and asserts on the frame
 * shapes (not wire bytes) so they stay readable.
 *
 * Scope:
 * - SDK → frame translation for system/assistant/user/result messages
 * - Tool call lifecycle correlation (start → end via tool_use_id cache)
 * - Specialized Plan / Todo frame emission alongside lifecycle frames
 * - Content block ordering preservation within an assistant turn
 * - Direct emit helpers (session_init, session_end, error, file_delivery,
 *   interactive_prompt, interactive_resolved)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FrameEmitter, type EmitContext } from "./frame-emitter.ts";
import type {
  AssistantMessageFrame,
  ToolCallStartFrame,
  ToolCallEndFrame,
  UserMessageFrame,
  PlanFrame,
  TodoFrame,
  SessionInitFrame,
  SessionMetaFrame,
} from "../../shared/frames.ts";

function makeCtx(startSeq: number, ts: number): EmitContext {
  let seq = startSeq;
  return {
    nextSeq: () => seq++,
    ts,
  };
}

describe("FrameEmitter", () => {
  let emitter: FrameEmitter;
  beforeEach(() => {
    emitter = new FrameEmitter();
  });

  // -------------------------------------------------------------------------
  // System → session_init
  // -------------------------------------------------------------------------

  describe("system init", () => {
    it("translates init message to session_init frame", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "system",
          subtype: "init",
          session_id: "sid-123",
          model: "claude-opus-4",
          permission_mode: "acceptEdits",
          slash_commands: ["/help", "/clear"],
        },
        makeCtx(1, 1000),
      );
      expect(frames).toHaveLength(1);
      const f = frames[0] as SessionInitFrame;
      expect(f.type).toBe("session_init");
      expect(f.sessionId).toBe("sid-123");
      expect(f.model).toBe("claude-opus-4");
      expect(f.permissionMode).toBe("acceptEdits");
      expect(f.slashCommands).toEqual(["/help", "/clear"]);
      expect(f.seq).toBe(1);
      expect(f.ts).toBe(1000);
    });

    it("drops non-init system messages", () => {
      const frames = emitter.emitFromSdkMessage(
        { type: "system", subtype: "abort" },
        makeCtx(1, 1000),
      );
      expect(frames).toEqual([]);
    });

    it("normalizes unknown permission modes to 'default'", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "system",
          subtype: "init",
          session_id: "sid",
          permission_mode: "garbage-value",
        },
        makeCtx(1, 1000),
      );
      const f = frames[0] as SessionInitFrame;
      expect(f.permissionMode).toBe("default");
    });
  });

  // -------------------------------------------------------------------------
  // Assistant messages with content block ordering
  // -------------------------------------------------------------------------

  describe("assistant messages", () => {
    it("preserves content block order within an assistant turn", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "assistant",
          message: {
            id: "msg-1",
            content: [
              { type: "text", text: "First I'll explain." },
              {
                type: "tool_use",
                id: "tu-1",
                name: "Read",
                input: { file_path: "/foo.ts" },
              },
              { type: "text", text: "Then I'll edit." },
              {
                type: "tool_use",
                id: "tu-2",
                name: "Edit",
                input: { file_path: "/foo.ts", old_string: "a", new_string: "b" },
              },
              { type: "text", text: "Done." },
            ],
          },
        },
        makeCtx(10, 2000),
      );

      // Expected: 1 AssistantMessageFrame + 2 ToolCallStartFrames = 3 frames
      expect(frames).toHaveLength(3);

      const assistant = frames[0] as AssistantMessageFrame;
      expect(assistant.type).toBe("assistant_message");
      expect(assistant.messageId).toBe("msg-1");
      expect(assistant.id).toBe("msg-1"); // SDK id reused as frame id
      expect(assistant.complete).toBe(true);
      // Critical: content blocks must be in the exact order Claude emitted.
      expect(assistant.content.map((b) => b.type)).toEqual([
        "text",
        "tool_use",
        "text",
        "tool_use",
        "text",
      ]);
      expect(
        (assistant.content[0] as { type: "text"; text: string }).text,
      ).toBe("First I'll explain.");
      expect(
        (assistant.content[2] as { type: "text"; text: string }).text,
      ).toBe("Then I'll edit.");
      expect(
        (assistant.content[4] as { type: "text"; text: string }).text,
      ).toBe("Done.");

      // Tool call start frames carry their own ids, tool name, input,
      // and the parent assistant message id for anchoring.
      const toolStart1 = frames[1] as ToolCallStartFrame;
      expect(toolStart1.type).toBe("tool_call_start");
      expect(toolStart1.toolCallId).toBe("tu-1");
      expect(toolStart1.tool).toBe("Read");
      expect(toolStart1.assistantMessageId).toBe("msg-1");

      const toolStart2 = frames[2] as ToolCallStartFrame;
      expect(toolStart2.toolCallId).toBe("tu-2");
      expect(toolStart2.tool).toBe("Edit");
    });

    it("handles thinking blocks", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "assistant",
          message: {
            id: "msg-t",
            content: [
              { type: "thinking", thinking: "Let me consider..." },
              { type: "text", text: "Answer." },
            ],
          },
        },
        makeCtx(1, 1000),
      );
      const assistant = frames[0] as AssistantMessageFrame;
      expect(assistant.content[0].type).toBe("thinking");
      expect(
        (assistant.content[0] as { type: "thinking"; text: string }).text,
      ).toBe("Let me consider...");
    });

    it("drops unknown content block types silently", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "assistant",
          message: {
            id: "msg-u",
            content: [
              { type: "text", text: "hi" },
              { type: "unknown_new_thing", data: { foo: 1 } },
              { type: "text", text: "bye" },
            ],
          },
        },
        makeCtx(1, 1000),
      );
      const assistant = frames[0] as AssistantMessageFrame;
      // Only the two known text blocks survive.
      expect(assistant.content).toHaveLength(2);
      expect(assistant.content.map((b) => b.type)).toEqual(["text", "text"]);
    });

    it("synthesizes a messageId when SDK does not provide one", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "hi" }] },
        },
        makeCtx(1, 1000),
      );
      const assistant = frames[0] as AssistantMessageFrame;
      expect(assistant.messageId).toMatch(/^[0-9a-f]+$/);
      expect(assistant.id).toBe(assistant.messageId);
    });
  });

  // -------------------------------------------------------------------------
  // Tool call lifecycle correlation
  // -------------------------------------------------------------------------

  describe("tool call lifecycle", () => {
    it("emits tool_call_end correlated to an earlier tool_call_start", () => {
      // Step 1: assistant calls a tool
      const startFrames = emitter.emitFromSdkMessage(
        {
          type: "assistant",
          message: {
            id: "msg-call",
            content: [
              {
                type: "tool_use",
                id: "tu-42",
                name: "Bash",
                input: { command: "ls -la" },
              },
            ],
          },
        },
        makeCtx(1, 1000),
      );
      expect(startFrames).toHaveLength(2); // assistant_message + tool_call_start

      // Step 2: user message carries the tool_result
      const endFrames = emitter.emitFromSdkMessage(
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu-42",
                content: "file1\nfile2",
                is_error: false,
              },
            ],
          },
          tool_use_result: {
            stdout: "file1\nfile2",
            stderr: "",
            interrupted: false,
            isImage: false,
          },
        },
        makeCtx(10, 2500),
      );
      expect(endFrames).toHaveLength(1);
      const end = endFrames[0] as ToolCallEndFrame;
      expect(end.type).toBe("tool_call_end");
      expect(end.toolCallId).toBe("tu-42");
      expect(end.status).toBe("ok");
      expect(end.output).toBe("file1\nfile2");
      // Duration computed from cached startedAt to current ts
      expect(end.durationMs).toBe(1500);
      // Structured payload passed through
      expect(end.structured).toEqual({
        stdout: "file1\nfile2",
        stderr: "",
        interrupted: false,
        isImage: false,
      });
    });

    it("marks tool_call_end as error when is_error is true", () => {
      emitter.emitFromSdkMessage(
        {
          type: "assistant",
          message: {
            id: "m",
            content: [
              { type: "tool_use", id: "tu-err", name: "Bash", input: {} },
            ],
          },
        },
        makeCtx(1, 1000),
      );
      const endFrames = emitter.emitFromSdkMessage(
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu-err",
                content: "permission denied",
                is_error: true,
              },
            ],
          },
        },
        makeCtx(10, 1100),
      );
      const end = endFrames[0] as ToolCallEndFrame;
      expect(end.status).toBe("error");
      expect(end.errorOutput).toBe("permission denied");
    });

    it("skips tool_result with missing tool_use_id", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", content: "orphan" }],
          },
        },
        makeCtx(1, 1000),
      );
      expect(frames).toEqual([]);
    });

    it("handles tool_result with no cache entry gracefully", () => {
      // No prior tool_use_start cached for tu-ghost.
      const frames = emitter.emitFromSdkMessage(
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu-ghost",
                content: "result",
              },
            ],
          },
        },
        makeCtx(1, 1000),
      );
      expect(frames).toHaveLength(1);
      const end = frames[0] as ToolCallEndFrame;
      expect(end.toolCallId).toBe("tu-ghost");
      expect(end.durationMs).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Specialized Plan / Todo frames
  // -------------------------------------------------------------------------

  describe("specialized frames", () => {
    it("emits a PlanFrame alongside ToolCallStart for ExitPlanMode", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "assistant",
          message: {
            id: "msg-plan",
            content: [
              {
                type: "tool_use",
                id: "tu-plan",
                name: "ExitPlanMode",
                input: { plan: "1. Step one\n2. Step two" },
              },
            ],
          },
        },
        makeCtx(1, 1000),
      );
      // assistant_message + tool_call_start + plan = 3
      expect(frames).toHaveLength(3);
      const plan = frames[2] as PlanFrame;
      expect(plan.type).toBe("plan");
      expect(plan.toolCallId).toBe("tu-plan");
      expect(plan.plan).toBe("1. Step one\n2. Step two");
    });

    it("emits a TodoFrame alongside ToolCallStart for TodoWrite", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "assistant",
          message: {
            id: "msg-todo",
            content: [
              {
                type: "tool_use",
                id: "tu-todo",
                name: "TodoWrite",
                input: {
                  todos: [
                    { content: "A", activeForm: "Doing A", status: "pending" },
                    {
                      content: "B",
                      activeForm: "Doing B",
                      status: "in_progress",
                    },
                    {
                      content: "C",
                      activeForm: "Doing C",
                      status: "completed",
                    },
                  ],
                },
              },
            ],
          },
        },
        makeCtx(1, 1000),
      );
      expect(frames).toHaveLength(3);
      const todo = frames[2] as TodoFrame;
      expect(todo.type).toBe("todo");
      expect(todo.toolCallId).toBe("tu-todo");
      expect(todo.todos).toHaveLength(3);
      expect(todo.todos[1]).toEqual({
        content: "B",
        activeForm: "Doing B",
        status: "in_progress",
      });
    });

    it("skips TodoFrame when input shape is invalid", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "assistant",
          message: {
            id: "msg-bad-todo",
            content: [
              {
                type: "tool_use",
                id: "tu-bad",
                name: "TodoWrite",
                input: { todos: [{ content: "A" }] }, // missing activeForm/status
              },
            ],
          },
        },
        makeCtx(1, 1000),
      );
      // assistant_message + tool_call_start only — no todo frame
      expect(frames).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // User messages
  // -------------------------------------------------------------------------

  describe("user messages", () => {
    it("emits a user_message frame for string content", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "user",
          message: { content: "hello there" },
        },
        makeCtx(1, 1000),
      );
      expect(frames).toHaveLength(1);
      const f = frames[0] as UserMessageFrame;
      expect(f.type).toBe("user_message");
      expect(f.content).toEqual([{ type: "text", text: "hello there" }]);
    });

    it("emits a user_message frame for array text content", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "user",
          message: {
            content: [
              { type: "text", text: "part one" },
              { type: "text", text: "part two" },
            ],
          },
        },
        makeCtx(1, 1000),
      );
      const f = frames[0] as UserMessageFrame;
      expect(f.content).toHaveLength(2);
      expect(f.content[0]).toEqual({ type: "text", text: "part one" });
    });

    it("silently drops image content blocks but preserves siblings", () => {
      // History replay contract: an SDK user message carrying an image
      // block alongside a text block must never crash the emitter. We
      // drop the image (no frame-level image support for input yet) and
      // still emit a clean text-only user_message frame. This keeps the
      // image turn visible in replay rather than disappearing entirely.
      const frames = emitter.emitFromSdkMessage(
        {
          type: "user",
          message: {
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAlPW0iAAAABlBMVEUAAAD///+l2Z/dAAAACklEQVR4nGNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==",
                },
              },
              { type: "text", text: "what is in this screenshot?" },
            ],
          },
        },
        makeCtx(1, 1000),
      );
      expect(frames).toHaveLength(1);
      const f = frames[0] as UserMessageFrame;
      expect(f.type).toBe("user_message");
      // Exactly one block — the text survived, the image was dropped.
      expect(f.content).toEqual([
        { type: "text", text: "what is in this screenshot?" },
      ]);
      // The emitted content must match the Phase B UserContentBlock union
      // exactly. No stray Anthropic-shape fields leak through.
      for (const block of f.content) {
        expect(["text", "image", "file"]).toContain(block.type);
        if (block.type === "text") {
          expect(typeof block.text).toBe("string");
        }
      }
    });

    it("produces no user_message frame when only image blocks are present", () => {
      // Degenerate case: no text block at all. Rather than emitting an
      // empty-content frame (which the renderer would flag as malformed),
      // emitUser skips the message entirely. Safe fallback — in practice
      // the chat handler always appends a text block, so this path is
      // only hit if someone bypasses the handler.
      const frames = emitter.emitFromSdkMessage(
        {
          type: "user",
          message: {
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBORw0KGgo=",
                },
              },
            ],
          },
        },
        makeCtx(1, 1000),
      );
      expect(frames).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Result → SessionMeta
  // -------------------------------------------------------------------------

  describe("result messages", () => {
    it("translates result to session_meta with token counts", () => {
      const frames = emitter.emitFromSdkMessage(
        {
          type: "result",
          num_turns: 3,
          total_cost_usd: 0.12,
          duration_ms: 5000,
          usage: {
            input_tokens: 1000,
            output_tokens: 250,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 10,
          },
        },
        makeCtx(1, 1000),
      );
      expect(frames).toHaveLength(1);
      const f = frames[0] as SessionMetaFrame;
      expect(f.type).toBe("session_meta");
      expect(f.turns).toBe(3);
      expect(f.costUsd).toBe(0.12);
      expect(f.durationMs).toBe(5000);
      expect(f.inputTokens).toBe(1000);
      expect(f.outputTokens).toBe(250);
      expect(f.cacheReadTokens).toBe(50);
      expect(f.cacheCreationTokens).toBe(10);
    });

    it("omits missing fields on session_meta", () => {
      const frames = emitter.emitFromSdkMessage(
        { type: "result" },
        makeCtx(1, 1000),
      );
      const f = frames[0] as SessionMetaFrame;
      expect(f.turns).toBeUndefined();
      expect(f.costUsd).toBeUndefined();
      expect(f.inputTokens).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Direct emit helpers
  // -------------------------------------------------------------------------

  describe("direct emit helpers", () => {
    it("emitSessionInitFromManager returns a full SessionInit frame", () => {
      const f = emitter.emitSessionInitFromManager(
        {
          sessionId: "s-1",
          model: "claude-opus-4",
          permissionMode: "default",
          roleFile: "dev.md",
          workingDirectory: "/proj",
          slashCommands: ["/help"],
        },
        makeCtx(1, 1000),
      );
      expect(f.type).toBe("session_init");
      expect(f.roleFile).toBe("dev.md");
      expect(f.workingDirectory).toBe("/proj");
      expect(f.slashCommands).toEqual(["/help"]);
    });

    it("emitSessionEnd", () => {
      const f = emitter.emitSessionEnd("user", "bye", makeCtx(1, 1000));
      expect(f.type).toBe("session_end");
      expect(f.reason).toBe("user");
      expect(f.message).toBe("bye");
    });

    it("emitError", () => {
      const f = emitter.emitError(
        "stream_error",
        "connection lost",
        undefined,
        makeCtx(1, 1000),
      );
      expect(f.type).toBe("error");
      expect(f.category).toBe("stream_error");
      expect(f.message).toBe("connection lost");
      expect(f.scopeId).toBeUndefined();
    });

    it("emitFileDelivery", () => {
      const f = emitter.emitFileDelivery(
        {
          path: "/proj/foo.ts",
          filename: "foo.ts",
          action: "edit",
          oldString: "a",
          newString: "b",
          toolCallId: "tu-edit",
        },
        makeCtx(1, 1000),
      );
      expect(f.type).toBe("file_delivery");
      expect(f.action).toBe("edit");
      expect(f.toolCallId).toBe("tu-edit");
    });

    it("emitInteractivePrompt and emitInteractiveResolved", () => {
      const prompt = emitter.emitInteractivePrompt(
        {
          requestId: "req-1",
          kind: "tool_permission",
          action: "Bash ls -la",
          details: "will list files",
        },
        makeCtx(1, 1000),
      );
      expect(prompt.type).toBe("interactive_prompt");
      expect(prompt.kind).toBe("tool_permission");

      const resolved = emitter.emitInteractiveResolved(
        "req-1",
        "approved",
        makeCtx(2, 1100),
      );
      expect(resolved.type).toBe("interactive_resolved");
      expect(resolved.requestId).toBe("req-1");
      expect(resolved.resolution).toBe("approved");
    });
  });

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  describe("reset", () => {
    it("clears tool cache so stale ids do not correlate across sessions", () => {
      emitter.emitFromSdkMessage(
        {
          type: "assistant",
          message: {
            id: "m",
            content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }],
          },
        },
        makeCtx(1, 1000),
      );
      emitter.reset();
      const endFrames = emitter.emitFromSdkMessage(
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu-1", content: "x" },
            ],
          },
        },
        makeCtx(10, 1500),
      );
      // Tool_result still emits a frame but with no duration (cache was cleared)
      const end = endFrames[0] as ToolCallEndFrame;
      expect(end.durationMs).toBeUndefined();
    });
  });
});
