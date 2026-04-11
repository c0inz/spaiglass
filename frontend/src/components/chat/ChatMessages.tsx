/**
 * Phase 6.3: Cutover — the terminal renderer is now the only renderer.
 * ChatMessages is a thin pass-through to TerminalChat so existing callers
 * (ChatPage, DemoPage) keep working without changes.
 */
import type { AllMessage } from "../../types";
import { TerminalChat } from "../../terminal/TerminalChat";
import type { InteractiveToolResultStatus } from "../../terminal/interpreter";

interface ChatMessagesProps {
  messages: AllMessage[];
  isLoading: boolean;
  onOpenFile?: (path: string, filename: string) => void;
  onToolResult?: (
    requestId: string,
    status: InteractiveToolResultStatus,
    data?: unknown,
    reason?: string,
  ) => void;
}

export function ChatMessages({
  messages,
  isLoading,
  onOpenFile,
  onToolResult,
}: ChatMessagesProps) {
  return (
    <TerminalChat
      messages={messages}
      isLoading={isLoading}
      onOpenFile={onOpenFile}
      onToolResult={onToolResult}
    />
  );
}
