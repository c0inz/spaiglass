/**
 * Tests for the Phase B frame-state reducer.
 *
 * Covers the invariants that matter for correctness:
 *
 *   - content block order preserved (text → tool → text)
 *   - tool calls embed via toolCallId, never become standalone rows
 *   - stable row keys (React reconciliation won't unmount on patch)
 *   - deltas patch assistant rows in place
 *   - tool_call_start / update / end collapse into one ToolCallState
 *   - TodoWrite replaces its own row, doesn't stack
 *   - buildFrameState(frames) === frames.reduce(applyFrame, initial)
 *
 * These tests are pure reducer — no React, no renderer. They exist so
 * breaking the wire contract or the row assembly rules fails loudly.
 */

import { describe, expect, it } from "vitest";
import {
  applyFrame,
  buildFrameState,
  initialFrameState,
  shouldRenderInlineToolCard,
  type AssistantRow,
  type ToolCallState,
} from "./state";
import type { Frame } from "../../../../shared/frames";

// --- helpers ----------------------------------------------------------------

let seqCounter = 0;
function nextSeq(): number {
  seqCounter++;
  return seqCounter;
}

function resetSeq() {
  seqCounter = 0;
}

function sessionInit(): Frame {
  return {
    id: "sess-init-1",
    seq: nextSeq(),
    ts: 1000,
    type: "session_init",
    sessionId: "sdk-abc",
    model: "claude-opus-4-6",
    permissionMode: "bypassPermissions",
    roleFile: "role.md",
    workingDirectory: "/home/work",
    slashCommands: ["/reset", "/stop"],
  };
}

function userMessage(id: string, text: string, seq = nextSeq()): Frame {
  return {
    id,
    seq,
    ts: 2000,
    type: "user_message",
    content: [{ type: "text", text }],
  };
}

function assistantMessage(
  id: string,
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | { type: "tool_use"; toolCallId: string; tool: string; input: unknown }
  >,
  seq = nextSeq(),
): Frame {
  return {
    id,
    seq,
    ts: 3000,
    type: "assistant_message",
    messageId: id,
    // Cast through the exported union — the caller supplies only the
    // variants we actually use in tests.
    content: content as AssistantRow["content"],
    complete: true,
  };
}

function toolCallStart(
  toolCallId: string,
  tool: string,
  input: unknown,
  assistantMessageId: string,
  seq = nextSeq(),
): Frame {
  return {
    id: `tc-start-${toolCallId}`,
    seq,
    ts: 4000,
    type: "tool_call_start",
    toolCallId,
    tool,
    input: input as never,
    assistantMessageId,
  };
}

function toolCallEnd(
  toolCallId: string,
  output: string,
  status: "ok" | "error" = "ok",
  seq = nextSeq(),
): Frame {
  return {
    id: `tc-end-${toolCallId}`,
    seq,
    ts: 5000,
    type: "tool_call_end",
    toolCallId,
    status,
    output,
  };
}

// --- tests ------------------------------------------------------------------

describe("frame state reducer", () => {
  it("starts empty", () => {
    const state = initialFrameState();
    expect(state.rows).toEqual([]);
    expect(state.toolCalls.size).toBe(0);
    expect(state.session.attached).toBe(false);
  });

  it("session_init populates session snapshot without creating a row", () => {
    resetSeq();
    const state = applyFrame(initialFrameState(), sessionInit());
    expect(state.rows).toEqual([]);
    expect(state.session.attached).toBe(true);
    expect(state.session.sessionId).toBe("sdk-abc");
    expect(state.session.permissionMode).toBe("bypassPermissions");
    expect(state.session.slashCommands).toEqual(["/reset", "/stop"]);
  });

  it("session_end flips attached flag without removing rows", () => {
    resetSeq();
    let state = applyFrame(initialFrameState(), sessionInit());
    state = applyFrame(state, userMessage("u1", "hi"));
    state = applyFrame(state, {
      id: "end-1",
      seq: nextSeq(),
      ts: 6000,
      type: "session_end",
      reason: "user",
    });
    expect(state.rows).toHaveLength(1);
    expect(state.session.attached).toBe(false);
    expect(state.session.endReason).toBe("user");
  });

  it("user_message creates a UserRow keyed by frame id", () => {
    resetSeq();
    const state = applyFrame(initialFrameState(), userMessage("u1", "hello"));
    expect(state.rows).toHaveLength(1);
    const row = state.rows[0];
    expect(row.kind).toBe("user");
    expect(row.key).toBe("u1");
  });

  it("preserves content block order inside an assistant row", () => {
    resetSeq();
    let state = initialFrameState();
    state = applyFrame(
      state,
      assistantMessage("a1", [
        { type: "text", text: "Let me check the config. " },
        { type: "tool_use", toolCallId: "tc1", tool: "Read", input: { path: "/etc/foo" } },
        { type: "text", text: "Now I'll update it." },
        { type: "tool_use", toolCallId: "tc2", tool: "Edit", input: { path: "/etc/foo" } },
        { type: "text", text: "Done." },
      ]),
    );
    const row = state.rows[0] as AssistantRow;
    expect(row.kind).toBe("assistant");
    expect(row.content).toHaveLength(5);
    expect(row.content[0].type).toBe("text");
    expect(row.content[1].type).toBe("tool_use");
    expect(row.content[2].type).toBe("text");
    expect(row.content[3].type).toBe("tool_use");
    expect(row.content[4].type).toBe("text");
    // the critical invariant: text-between-tools stays in position
    expect((row.content[2] as { text: string }).text).toBe("Now I'll update it.");
  });

  it("tool_call_start creates ToolCallState in the map, not a row", () => {
    resetSeq();
    let state = initialFrameState();
    state = applyFrame(
      state,
      assistantMessage("a1", [
        { type: "tool_use", toolCallId: "tc1", tool: "Bash", input: { command: "ls" } },
      ]),
    );
    state = applyFrame(state, toolCallStart("tc1", "Bash", { command: "ls" }, "a1"));
    expect(state.rows).toHaveLength(1); // only the assistant row
    expect(state.toolCalls.get("tc1")).toBeDefined();
    const call = state.toolCalls.get("tc1") as ToolCallState;
    expect(call.status).toBe("running");
    expect(call.tool).toBe("Bash");
  });

  it("tool_call_update appends incremental output", () => {
    resetSeq();
    let state = initialFrameState();
    state = applyFrame(state, toolCallStart("tc1", "Bash", {}, "a1"));
    state = applyFrame(state, {
      id: "u1",
      seq: nextSeq(),
      ts: 4500,
      type: "tool_call_update",
      toolCallId: "tc1",
      outputAppend: "line 1\n",
    });
    state = applyFrame(state, {
      id: "u2",
      seq: nextSeq(),
      ts: 4600,
      type: "tool_call_update",
      toolCallId: "tc1",
      outputAppend: "line 2\n",
    });
    const call = state.toolCalls.get("tc1") as ToolCallState;
    expect(call.output).toBe("line 1\nline 2\n");
    expect(call.status).toBe("running");
  });

  it("tool_call_end finalizes status and output", () => {
    resetSeq();
    let state = initialFrameState();
    state = applyFrame(state, toolCallStart("tc1", "Bash", {}, "a1"));
    state = applyFrame(state, toolCallEnd("tc1", "hello\n", "ok"));
    const call = state.toolCalls.get("tc1") as ToolCallState;
    expect(call.status).toBe("ok");
    expect(call.output).toBe("hello\n");
  });

  it("assistant_message_delta appends text in place without unmounting the row", () => {
    resetSeq();
    let state = initialFrameState();
    state = applyFrame(
      state,
      assistantMessage("a1", [{ type: "text", text: "Hello " }]),
    );
    const rowKeyBefore = state.rows[0].key;
    state = applyFrame(state, {
      id: "d1",
      seq: nextSeq(),
      ts: 3100,
      type: "assistant_message_delta",
      targetId: "a1",
      blockIndex: 0,
      textAppend: "world",
    });
    const row = state.rows[0] as AssistantRow;
    expect(row.key).toBe(rowKeyBefore); // stable key — React won't remount
    expect((row.content[0] as { text: string }).text).toBe("Hello world");
  });

  it("assistant_message replacing an existing messageId replaces the row in place", () => {
    resetSeq();
    let state = initialFrameState();
    state = applyFrame(state, assistantMessage("a1", [{ type: "text", text: "v1" }]));
    state = applyFrame(state, assistantMessage("a1", [{ type: "text", text: "v2" }]));
    expect(state.rows).toHaveLength(1);
    const row = state.rows[0] as AssistantRow;
    expect((row.content[0] as { text: string }).text).toBe("v2");
  });

  it("TodoWrite replaces its own card instead of stacking", () => {
    resetSeq();
    let state = initialFrameState();
    const t1: Frame = {
      id: "todo-1",
      seq: nextSeq(),
      ts: 3500,
      type: "todo",
      toolCallId: "tw1",
      todos: [
        { content: "a", activeForm: "A", status: "pending" },
      ],
    };
    const t2: Frame = {
      id: "todo-2",
      seq: nextSeq(),
      ts: 3600,
      type: "todo",
      toolCallId: "tw1",
      todos: [
        { content: "a", activeForm: "A", status: "completed" },
      ],
    };
    state = applyFrame(state, t1);
    state = applyFrame(state, t2);
    // One row, showing the latest state.
    const todoRows = state.rows.filter((r) => r.kind === "todo");
    expect(todoRows).toHaveLength(1);
    expect(todoRows[0].frame.todos[0].status).toBe("completed");
  });

  it("interactive_resolved patches the matching prompt row", () => {
    resetSeq();
    let state = initialFrameState();
    state = applyFrame(state, {
      id: "i1",
      seq: nextSeq(),
      ts: 4000,
      type: "interactive_prompt",
      requestId: "req-1",
      kind: "tool_permission",
      action: "rm -rf /",
    });
    state = applyFrame(state, {
      id: "i1r",
      seq: nextSeq(),
      ts: 4100,
      type: "interactive_resolved",
      requestId: "req-1",
      resolution: "approved",
    });
    const row = state.rows[0];
    expect(row.kind).toBe("interactive");
    if (row.kind === "interactive") {
      expect(row.resolved?.resolution).toBe("approved");
    }
  });

  it("buildFrameState matches sequential applyFrame", () => {
    resetSeq();
    const frames: Frame[] = [
      sessionInit(),
      userMessage("u1", "hi"),
      assistantMessage("a1", [
        { type: "text", text: "hello" },
        { type: "tool_use", toolCallId: "tc1", tool: "Bash", input: {} },
      ]),
      toolCallStart("tc1", "Bash", {}, "a1"),
      toolCallEnd("tc1", "ok", "ok"),
    ];
    const byReduce = buildFrameState(frames);
    let byApply = initialFrameState();
    for (const f of frames) byApply = applyFrame(byApply, f);
    expect(byReduce.rows).toEqual(byApply.rows);
    expect(Array.from(byReduce.toolCalls.entries())).toEqual(
      Array.from(byApply.toolCalls.entries()),
    );
  });

  it("shouldRenderInlineToolCard suppresses TodoWrite and ExitPlanMode", () => {
    expect(
      shouldRenderInlineToolCard({
        type: "tool_use",
        toolCallId: "tc1",
        tool: "TodoWrite",
        input: {},
      }),
    ).toBe(false);
    expect(
      shouldRenderInlineToolCard({
        type: "tool_use",
        toolCallId: "tc2",
        tool: "ExitPlanMode",
        input: {},
      }),
    ).toBe(false);
    expect(
      shouldRenderInlineToolCard({
        type: "tool_use",
        toolCallId: "tc3",
        tool: "Bash",
        input: {},
      }),
    ).toBe(true);
    expect(shouldRenderInlineToolCard({ type: "text", text: "x" })).toBe(false);
  });
});
