/**
 * Phase 6.2: smoke tests for the terminal interpreter.
 *
 * These cover the main message-type branches: chat, tool_result (Bash and
 * Edit), plan, todo, file_delivery, system/result/error. The point is to
 * catch obvious regressions when adapter logic moves under us.
 */

import { describe, expect, it } from "vitest";
import { render, fireEvent } from "@testing-library/react";
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
    expect(container.textContent).toContain("user@spaiglass");
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
    expect(container.textContent).toContain("claude@spaiglass");
  });

  it("renders a Bash tool_result with stdout (collapsed card expands on click)", () => {
    const msg: ToolResultMessage = {
      type: "tool_result",
      toolName: "Bash",
      content: "ls output",
      summary: "ls -la",
      timestamp: 1,
      input: { command: "ls -la" },
      toolUseResult: {
        stdout: "file1\nfile2",
        stderr: "",
        interrupted: false,
        isImage: false,
      },
    };
    const { container, getByRole } = rendered(renderTerminalMessage(msg));
    // Collapsed state: the header shows tool name + args summary but not body.
    expect(container.textContent).toContain("Bash");
    expect(container.textContent).toContain("ls -la");
    expect(container.textContent).not.toContain("file1");
    // Click the header to expand.
    fireEvent.click(getByRole("button", { expanded: false }));
    expect(container.textContent).toContain("file1");
    expect(container.textContent).toContain("file2");
  });

  it("renders an Edit tool_result with a structured patch (expands to show diff)", () => {
    const msg: ToolResultMessage = {
      type: "tool_result",
      toolName: "Edit",
      content: "edited",
      summary: "src/foo.ts",
      timestamp: 1,
      input: { file_path: "src/foo.ts" },
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
    const { container, getByRole } = rendered(renderTerminalMessage(msg));
    expect(container.textContent).toContain("Edit");
    fireEvent.click(getByRole("button", { expanded: false }));
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
