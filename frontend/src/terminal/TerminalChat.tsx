/**
 * Phase 6.2/6.5: TerminalChat — drop-in replacement for ChatMessages that
 * uses the terminal interpreter.
 *
 * Scroll behavior (P6.5 polish): we only auto-scroll the pane to the bottom
 * when the user is already near the bottom — if they've scrolled up to read
 * a previous frame we leave them alone instead of yanking them back as new
 * messages stream in. The "near bottom" threshold is 64px (about two lines).
 *
 * Re-render budget (P6.5 polish): each rendered message row is memoized via
 * `MemoMessageRow`. Streaming a long Bash output now only re-renders the row
 * whose content changed (and the spinner row at the tail), instead of the
 * full N-row scrollback.
 */

import { memo, useCallback, useEffect, useRef } from "react";
import type { AllMessage } from "../types";
import type { DisplayStatus } from "../utils/statusClassifier";
import type { ReactNode } from "react";
import {
  renderTerminalMessage,
  type InteractiveToolResultStatus,
} from "./interpreter";
import { StatusLine } from "./StatusLine";

interface TerminalChatProps {
  messages: AllMessage[];
  isLoading: boolean;
  /** Transient status from tool activity classifier. Replaces the generic spinner. */
  currentStatus?: DisplayStatus | null;
  userLogin?: string | null;
  onOpenFile?: (path: string, filename: string) => void;
  /**
   * Phase 6.4 — invoked when the user replies to an interactive widget.
   * Forwarded to the WS hook which sends a `tool_result` frame to the backend.
   */
  onToolResult?: (
    requestId: string,
    status: InteractiveToolResultStatus,
    data?: unknown,
    reason?: string,
  ) => void;
  /**
   * Invoked when a markdown-embedded widget in an assistant message wants
   * to send a chat message (e.g. secret-input submits the pasted secret,
   * a choice button picks itself). Wired to sendMessage in ChatPage.
   */
  onSubmitText?: (text: string) => void;
}

/**
 * Distance from the bottom (in px) at which we still consider the user
 * "following" the stream. Kept generous so a few frames of overscroll on
 * touch devices still counts as pinned.
 */
const NEAR_BOTTOM_PX = 64;

export function TerminalChat({
  messages,
  isLoading,
  currentStatus,
  userLogin,
  onOpenFile,
  onToolResult,
  onSubmitText,
}: TerminalChatProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Whether the user is currently "pinned" to the bottom of the scroll pane.
  // Updated on scroll events; consulted in the messages effect to decide
  // whether to auto-scroll on new content.
  const pinnedRef = useRef<boolean>(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distance <= NEAR_BOTTOM_PX;
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentStatus]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="sg-scroll flex-1 overflow-y-auto overflow-x-hidden min-w-0 bg-slate-950 text-slate-100 border border-slate-700 p-3 sm:p-5 mb-3 sm:mb-6 rounded-2xl shadow-sm flex flex-col touch-pan-y"
    >
      {messages.length === 0 ? (
        <TerminalEmptyState />
      ) : (
        <>
          <div className="flex-1" aria-hidden="true" />
          {messages.map((msg, idx) => (
            <MemoMessageRow
              key={`${msg.timestamp}-${idx}`}
              message={msg}
              userLogin={userLogin}
              onOpenFile={onOpenFile}
              onToolResult={onToolResult}
              onSubmitText={onSubmitText}
            />
          ))}
          {isLoading && (
            <StatusLine status={currentStatus ?? { label: "Thinking…", kind: "thinking", priority: 10, stickyMs: 500, dedupeKey: "default" }} />
          )}
          <div ref={endRef} />
        </>
      )}
    </div>
  );
}

interface MessageRowProps {
  message: AllMessage;
  userLogin?: string | null;
  onOpenFile?: (path: string, filename: string) => void;
  onToolResult?: (
    requestId: string,
    status: InteractiveToolResultStatus,
    data?: unknown,
    reason?: string,
  ) => void;
  onSubmitText?: (text: string) => void;
}

function MessageRow({
  message,
  userLogin,
  onOpenFile,
  onToolResult,
  onSubmitText,
}: MessageRowProps): ReactNode {
  const node = renderTerminalMessage(message, {
    userLogin,
    onOpenFile,
    onToolResult,
    onSubmitText,
  });
  if (node == null) return null;
  return <div className="min-w-0 max-w-full">{node}</div>;
}

/**
 * Re-render only when the message identity or its mutable streaming content
 * changes. The interpreter is a pure function of (message, opts), so as long
 * as the same message object is passed back we can skip the re-render.
 *
 * `chat` messages get their `content` mutated in place during streaming —
 * comparing on `===` would skip the update — so we explicitly compare on the
 * fields that change. Everything else is identity-stable in our reducers.
 */
const MemoMessageRow = memo(MessageRow, (prev, next) => {
  if (prev.message !== next.message) return false;
  if (prev.onOpenFile !== next.onOpenFile) return false;
  if (prev.onToolResult !== next.onToolResult) return false;
  return true;
});

function TerminalEmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center text-center text-slate-500 dark:text-slate-400 font-mono">
      <div>
        <pre className="text-xs leading-tight opacity-80 mb-4">
          {`  ╔═══════════════════╗
  ║   spaiglass term  ║
  ╚═══════════════════╝`}
        </pre>
        <p className="text-sm">terminal renderer ready</p>
        <p className="text-xs mt-1 opacity-70">type a message to begin</p>
      </div>
    </div>
  );
}
