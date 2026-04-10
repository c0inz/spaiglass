/**
 * Phase 6.2: smoke tests for the terminal interpreter.
 *
 * These cover the main message-type branches: chat, tool_result (Bash and
 * Edit), plan, todo, file_delivery, system/result/error. The point is to
 * catch obvious regressions when adapter logic moves under us.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { renderTerminalMessage } from "./interpreter";
import type {
  ChatMessage,
  TodoMessage,
  PlanMessage,
  ToolResultMessage,
  FileDeliveryMessage,
} from "../types";

function rendered(node: React.ReactNode) {
  return render(<div>{node}</div>);
}

describe("renderTerminalMessage", () => {
  it("renders a user chat message", () => {
    const msg: ChatMessage = {
      type: "chat",
      role: "user",
      content: "hello world",
      timestamp: 1,
    };
    const { container } = rendered(renderTerminalMessage(msg));
    expect(container.textContent).toContain("hello world");
    expect(container.textContent).toContain("User");
  });

  it("renders an assistant chat message", () => {
    const msg: ChatMessage = {
      type: "chat",
      role: "assistant",
      content: "hi there",
      timestamp: 1,
    };
    const { container } = rendered(renderTerminalMessage(msg));
    expect(container.textContent).toContain("hi there");
    expect(container.textContent).toContain("Claude");
  });

  it("renders a Bash tool_result with stdout", () => {
    const msg: ToolResultMessage = {
      type: "tool_result",
      toolName: "Bash",
      content: "ls output",
      summary: "ls -la",
      timestamp: 1,
      toolUseResult: {
        stdout: "file1\nfile2",
        stderr: "",
        interrupted: false,
        isImage: false,
      },
    };
    const { container } = rendered(renderTerminalMessage(msg));
    expect(container.textContent).toContain("Bash");
    expect(container.textContent).toContain("file1");
  });

  it("renders an Edit tool_result with a structured patch", () => {
    const msg: ToolResultMessage = {
      type: "tool_result",
      toolName: "Edit",
      content: "edited",
      summary: "src/foo.ts",
      timestamp: 1,
      toolUseResult: {
        filePath: "src/foo.ts",
        oldString: "old",
        newString: "new",
        originalFile: "old\n",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old", "+new"],
          },
        ],
        userModified: false,
        replaceAll: false,
      },
    };
    const { container } = rendered(renderTerminalMessage(msg));
    expect(container.textContent).toContain("Edit");
    expect(container.textContent).toContain("+new");
    expect(container.textContent).toContain("-old");
  });

  it("renders a TodoMessage as a checklist", () => {
    const msg: TodoMessage = {
      type: "todo",
      timestamp: 1,
      todos: [
        { content: "Task one", status: "completed", activeForm: "Doing one" },
        {
          content: "Task two",
          status: "in_progress",
          activeForm: "Doing two",
        },
        { content: "Task three", status: "pending", activeForm: "Doing three" },
      ],
    };
    const { container } = rendered(renderTerminalMessage(msg));
    expect(container.textContent).toContain("Task one");
    expect(container.textContent).toContain("Doing two"); // in_progress shows activeForm
    expect(container.textContent).toContain("Task three");
    expect(container.textContent).toContain("1/3"); // completed count in title
  });

  it("renders a PlanMessage", () => {
    const msg: PlanMessage = {
      type: "plan",
      plan: "1. do thing\n2. do other thing",
      toolUseId: "abc",
      timestamp: 1,
    };
    const { container } = rendered(renderTerminalMessage(msg));
    expect(container.textContent).toContain("Plan");
    expect(container.textContent).toContain("do thing");
  });

  it("renders a FileDeliveryMessage", () => {
    const msg: FileDeliveryMessage = {
      type: "file_delivery",
      path: "/proj/foo.ts",
      filename: "foo.ts",
      action: "write",
      timestamp: 1,
    };
    const { container } = rendered(renderTerminalMessage(msg));
    expect(container.textContent).toContain("File Created");
    expect(container.textContent).toContain("/proj/foo.ts");
  });
});
