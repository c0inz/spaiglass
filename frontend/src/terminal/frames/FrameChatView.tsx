/**
 * Phase B — frame-native scrollback view.
 *
 * Drop-in replacement for TerminalChat that renders `Row[]` from the frame
 * state reducer instead of `AllMessage[]`. The rendering contract is
 * identical (scroll-pinning, fresh-user-send jump-to-bottom, status line,
 * empty state) so the visual experience stays the same — the wins are in
 * how the data gets here, not how it looks.
 *
 * The big correctness properties we inherit from state.ts:
 *
 *   - row.key is a stable id from the anchor frame, so React.memo won't
 *     remount rows when tool output streams in (the old path re-keyed on
 *     array index)
 *   - row.content preserves block order so text-between-tools stays put
 *   - toolCalls is a Map<toolCallId, ToolCallState> passed as a prop; the
 *     renderer pulls live tool state by id at render time
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { DisplayStatus } from "../../utils/statusClassifier";
import { StatusLine } from "../StatusLine";
import {
  renderFrameRow,
  type FrameRenderOptions,
  type InteractiveToolResultStatus,
} from "./FrameInterpreter";
import type { AssistantRow, Row, ToolCallState } from "./state";

/**
 * An assistant row is "tool-only" if it has no text or thinking content —
 * just tool_use blocks. These are transient: once all their tools complete
 * and a newer tool-only row exists, the older one is hidden so the chat
 * shows only the most recent tool card rather than a long stack.
 */
function isToolOnlyAssistantRow(row: AssistantRow): boolean {
  return row.content.every((b) => b.type === "tool_use");
}

/** Same pinned-scroll threshold as TerminalChat. */
const NEAR_BOTTOM_PX = 64;
/** How long after user interaction to suppress auto-scroll. When the user
 *  is reading near the bottom, every new row/status change was stealing
 *  focus by scrolling to the end before they could finish reading. */
const SCROLL_COOLDOWN_MS = 4000;

interface FrameChatViewProps {
  rows: Row[];
  toolCalls: Map<string, ToolCallState>;
  isLoading: boolean;
  /** Transient status from tool activity classifier. */
  currentStatus?: DisplayStatus | null;
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

export function FrameChatView({
  rows,
  toolCalls,
  isLoading,
  currentStatus,
  userLogin,
  onOpenFile,
  onToolResult,
  onSubmitText,
}: FrameChatViewProps) {
  // Compute which assistant rows are "stale tool-only" and should be hidden.
  // A tool-only row (no text, just tool_use blocks) is hidden when ALL its
  // tools have completed ok AND a later tool-only assistant row exists.
  // This gives the "replaced by next tool header" transient behavior.
  const hiddenRowKeys = useMemo(() => {
    const hidden = new Set<string>();
    // Walk backwards to find the last tool-only assistant row index
    let lastToolOnlyIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.kind === "assistant" && isToolOnlyAssistantRow(r)) {
        lastToolOnlyIdx = i;
        break;
      }
    }
    if (lastToolOnlyIdx < 0) return hidden;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.kind !== "assistant" || !isToolOnlyAssistantRow(r)) continue;
      if (i === lastToolOnlyIdx) continue; // keep the most recent one
      // Check if ALL tool calls in this row are completed ok
      const allDone = r.content.every((b) => {
        if (b.type !== "tool_use") return true;
        const call = toolCalls.get(b.toolCallId);
        return call != null && call.status !== "running";
      });
      if (allDone) hidden.add(r.key);
    }
    return hidden;
  }, [rows, toolCalls]);

  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<boolean>(true);
  // Timestamp of last *user-initiated* scroll interaction. While within the
  // cooldown window, auto-scroll is suppressed so the user can finish
  // reading text that just appeared near the bottom.
  const lastUserScrollRef = useRef<number>(0);
  // Flag to distinguish programmatic scrollIntoView from real user scrolls.
  // Without this, every programmatic scroll resets the cooldown timer and
  // suppresses the *next* auto-scroll — causing content to fall off-screen.
  const programmaticScrollRef = useRef<boolean>(false);
  // Track the previous tail row so we can detect a fresh user send and
  // force-scroll on it (same behavior as TerminalChat).
  const prevTailKeyRef = useRef<string | null>(null);
  const prevTailKindRef = useRef<Row["kind"] | null>(null);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distance <= NEAR_BOTTOM_PX;
    // Only record user-initiated scrolls for cooldown purposes.
    // Programmatic scrolls (scrollIntoView) must not reset the timer.
    if (!programmaticScrollRef.current) {
      lastUserScrollRef.current = Date.now();
    }
  }, []);

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    programmaticScrollRef.current = true;
    endRef.current?.scrollIntoView({ behavior });
    // Clear the flag after the browser processes the scroll event(s).
    // requestAnimationFrame fires after layout/paint, catching both
    // instant ("auto") and the start of smooth scrolls.
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  useEffect(() => {
    const tail = rows.length > 0 ? rows[rows.length - 1] : null;
    const prevKey = prevTailKeyRef.current;
    const prevKind = prevTailKindRef.current;
    prevTailKeyRef.current = tail?.key ?? null;
    prevTailKindRef.current = tail?.kind ?? null;

    // Fresh user send → jump to bottom and re-pin. Hitting Send is an
    // implicit request to return to the live tail.
    const isNewUserSend =
      tail !== null &&
      tail.kind === "user" &&
      (tail.key !== prevKey || prevKind !== "user");

    if (isNewUserSend) {
      pinnedRef.current = true;
      lastUserScrollRef.current = 0;
      scrollToEnd("auto");
      return;
    }

    if (!pinnedRef.current) return;
    // Suppress auto-scroll during the cooldown period after the user last
    // interacted with scroll. This prevents the "text appears then vanishes"
    // effect where a tool card or status update auto-scrolls past the text
    // the user is actively reading.
    if (Date.now() - lastUserScrollRef.current < SCROLL_COOLDOWN_MS) return;
    scrollToEnd("smooth");
  }, [rows, currentStatus, scrollToEnd]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="sg-scroll flex-1 overflow-y-auto overflow-x-hidden min-w-0 bg-slate-950 text-slate-100 border border-slate-700 p-3 sm:p-5 mb-3 sm:mb-6 rounded-2xl shadow-sm flex flex-col touch-pan-y"
    >
      {rows.length === 0 ? (
        <FrameEmptyState />
      ) : (
        <>
          <div className="flex-1" aria-hidden="true" />
          {rows.map((row) =>
            hiddenRowKeys.has(row.key) ? null : (
              <MemoRow
                key={row.key}
                row={row}
                toolCalls={toolCalls}
                userLogin={userLogin}
                onOpenFile={onOpenFile}
                onToolResult={onToolResult}
                onSubmitText={onSubmitText}
              />
            ),
          )}
          {isLoading && (
            <StatusLine
              status={
                currentStatus ?? {
                  label: "Thinking…",
                  kind: "thinking",
                  priority: 10,
                  stickyMs: 500,
                  dedupeKey: "default",
                }
              }
            />
          )}
          <div ref={endRef} />
        </>
      )}
    </div>
  );
}

interface RowProps {
  row: Row;
  toolCalls: Map<string, ToolCallState>;
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

function RowView({
  row,
  toolCalls,
  userLogin,
  onOpenFile,
  onToolResult,
  onSubmitText,
}: RowProps): ReactNode {
  const opts: FrameRenderOptions = {
    userLogin,
    onOpenFile,
    onToolResult,
    onSubmitText,
    toolCalls,
  };
  const node = renderFrameRow(row, opts);
  if (node == null) return null;
  return <div className="min-w-0 max-w-full">{node}</div>;
}

/**
 * Re-render only when the row or its relevant tool-call state changes.
 *
 * `row` is an immutable snapshot — the reducer replaces the row object
 * whenever anything inside it changes, so `prev.row !== next.row` is a
 * precise "needs re-render" signal for row-intrinsic changes.
 *
 * Assistant rows with inline tool cards also need to re-render when the
 * tool call state in the Map changes (status going running → ok, output
 * streaming). The reducer replaces the whole `toolCalls` Map on every
 * tool_call_* frame, so a Map identity check is enough to catch those —
 * but we only care when the row actually references tools, so we narrow
 * to assistant rows to avoid thrashing user/plan/todo/error rows on
 * unrelated tool streams.
 */
const MemoRow = memo(RowView, (prev, next) => {
  if (prev.row !== next.row) return false;
  // Assistant rows can depend on tool call state; re-render when the map
  // changes. Other row kinds don't read from toolCalls.
  if (next.row.kind === "assistant" && prev.toolCalls !== next.toolCalls) {
    return false;
  }
  if (prev.onOpenFile !== next.onOpenFile) return false;
  if (prev.onToolResult !== next.onToolResult) return false;
  if (prev.onSubmitText !== next.onSubmitText) return false;
  return true;
});

function FrameEmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center text-center text-slate-500 dark:text-slate-400 font-mono">
      <div>
        <pre className="text-xs leading-tight opacity-80 mb-4">
          {`  ╔═══════════════════╗
  ║   spaiglass term  ║
  ╚═══════════════════╝`}
        </pre>
        <p className="text-sm">ready when you are</p>
        <p className="text-xs mt-1 opacity-70">
          send a message below, or hit{" "}
          <span className="font-semibold">New Session</span> in the header
        </p>
      </div>
    </div>
  );
}
