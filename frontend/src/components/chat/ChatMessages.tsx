/**
 * Phase 6.3: Cutover — the terminal renderer is now the only renderer.
 * ChatMessages is a thin pass-through to TerminalChat so existing callers
 * (ChatPage, DemoPage) keep working without changes.
 */
import type { AllMessage } from "../../types";
import { TerminalChat } from "../../terminal/TerminalChat";

interface ChatMessagesProps {
  messages: AllMessage[];
  isLoading: boolean;
  onOpenFile?: (path: string, filename: string) => void;
}

export function ChatMessages({
  messages,
  isLoading,
  onOpenFile,
}: ChatMessagesProps) {
  return (
    <TerminalChat
      messages={messages}
      isLoading={isLoading}
      onOpenFile={onOpenFile}
    />
  );
}
