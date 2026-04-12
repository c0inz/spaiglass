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
  userLogin?: string | null;
  onOpenFile?: (path: string, filename: string) => void;
  onToolResult?: (
    requestId: string,
    status: InteractiveToolResultStatus,
    data?: unknown,
    reason?: string,
  ) => void;
  /**
   * Invoked when a markdown-embedded widget (secret-input / choice /
   * confirm fenced block in an assistant message) wants to send a
   * chat message. Wired to sendMessage in ChatPage.
   */
  onSubmitText?: (text: string) => void;
}

export function ChatMessages({
  messages,
  isLoading,
  userLogin,
  onOpenFile,
  onToolResult,
  onSubmitText,
}: ChatMessagesProps) {
  return (
    <TerminalChat
      messages={messages}
      isLoading={isLoading}
      userLogin={userLogin}
      onOpenFile={onOpenFile}
      onToolResult={onToolResult}
      onSubmitText={onSubmitText}
    />
  );
}
