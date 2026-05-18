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
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDoubleDownIcon } from "@heroicons/react/24/solid";
import type { DisplayStatus } from "../../utils/statusClassifier";
import { StatusLine } from "../StatusLine";
import {
  renderFrameRow,
  type FrameRenderOptions,
  type InteractiveToolResultStatus,
} from "./FrameInterpreter";
import type { AssistantRow, Row, ToolCallState } from "./state";

export interface FrameChatViewHandle {
  /** Smooth-scroll to the row with the given stable key, centered in the
   *  viewport, with a 1.5s amber highlight. No-op if the key isn't in the
   *  current DOM. */
  scrollToRow(key: string): void;
  /** Smooth-scroll to the live tail and re-pin auto-scroll. */
  scrollToBottom(): void;
  /** True iff the view is currently pinned to the bottom. */
  isPinned(): boolean;
}

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

export const FrameChatView = forwardRef<FrameChatViewHandle, FrameChatViewProps>(
  function FrameChatView(
    {
      rows,
      toolCalls,
      isLoading,
      currentStatus,
      userLogin,
      onOpenFile,
      onToolResult,
      onSubmitText,
    },
    ref,
  ) {
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
  // State mirror of pinnedRef so the jump-to-bottom button can react to
  // pin/unpin transitions. The ref stays for synchronous reads inside
  // useEffect/useImperativeHandle bodies (where reading state would
  // race with the latest scroll event).
  const [isPinned, setIsPinned] = useState(true);
  // Rows added since the user last scrolled away from the bottom.
  // Reset to 0 whenever the view is pinned. Capped at 9+ in display.
  const [unreadCount, setUnreadCount] = useState(0);
  const lastSeenLenRef = useRef<number>(0);
  const rowsLenRef = useRef<number>(0);
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
    const pinned = distance <= NEAR_BOTTOM_PX;
    pinnedRef.current = pinned;
    setIsPinned((prev) => (prev === pinned ? prev : pinned));
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

  // Track unread (rows added while scrolled up). When pinned, the count
  // is always 0 and lastSeen tracks rows.length. When unpinned, lastSeen
  // freezes and the displayed count is the delta.
  useEffect(() => {
    rowsLenRef.current = rows.length;
    if (pinnedRef.current) {
      lastSeenLenRef.current = rows.length;
      if (unreadCount !== 0) setUnreadCount(0);
      return;
    }
    const next = Math.max(0, rows.length - lastSeenLenRef.current);
    if (next !== unreadCount) setUnreadCount(next);
  }, [rows, unreadCount]);

  // When the view re-pins (user scrolled to bottom or hit End), zero the
  // counter and snapshot the current length as the new baseline.
  useEffect(() => {
    if (isPinned) {
      lastSeenLenRef.current = rowsLenRef.current;
      if (unreadCount !== 0) setUnreadCount(0);
    }
  }, [isPinned, unreadCount]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToRow(key: string) {
        const container = containerRef.current;
        if (!container) return;
        const el = container.querySelector<HTMLElement>(
          `[data-row-key="${CSS.escape(key)}"]`,
        );
        if (!el) return;
        // Jumping is an explicit "I want to read this, leave me here"
        // intent. Drop pin so live frames don't yank us back, and stamp
        // the user-scroll timestamp so the cooldown suppresses any
        // pending auto-scrolls from in-flight tool streams.
        pinnedRef.current = false;
        setIsPinned(false);
        lastUserScrollRef.current = Date.now();
        programmaticScrollRef.current = true;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
        });
        // Transient highlight so the eye lands on the message after the
        // smooth-scroll settles.
        const HIGHLIGHT = [
          "ring-2",
          "ring-amber-300",
          "ring-offset-2",
          "ring-offset-slate-950",
          "rounded-lg",
        ];
        el.classList.add(...HIGHLIGHT);
        window.setTimeout(() => {
          el.classList.remove(...HIGHLIGHT);
        }, 1500);
      },
      scrollToBottom() {
        pinnedRef.current = true;
        setIsPinned(true);
        lastSeenLenRef.current = rowsLenRef.current;
        setUnreadCount(0);
        lastUserScrollRef.current = 0;
        scrollToEnd("smooth");
      },
      isPinned: () => pinnedRef.current,
    }),
    [scrollToEnd],
  );

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

  // Desktop keyboard scrolling: PageUp/PageDown/Home/End should page through
  // the chat transcript even when the cursor is parked in the input. The
  // textarea is single-row most of the time; users expect the same keys that
  // work in a terminal to work here. Ctrl+Home/Ctrl+End jump to the edges.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey) return;
      const el = containerRef.current;
      if (!el) return;
      const page = Math.max(el.clientHeight - 48, 40);
      let delta: number | null = null;
      let jumpTo: number | null = null;
      switch (e.key) {
        case "PageUp":
          delta = -page;
          break;
        case "PageDown":
          delta = page;
          break;
        case "Home":
          if (e.ctrlKey) jumpTo = 0;
          break;
        case "End":
          if (e.ctrlKey) jumpTo = el.scrollHeight;
          break;
      }
      if (delta === null && jumpTo === null) return;
      e.preventDefault();
      lastUserScrollRef.current = Date.now();
      if (jumpTo !== null) {
        el.scrollTo({ top: jumpTo, behavior: "smooth" });
      } else {
        el.scrollBy({ top: delta ?? 0, behavior: "smooth" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="sg-scroll relative flex-1 overflow-y-auto overflow-x-hidden min-w-0 bg-slate-950 text-slate-100 border border-slate-700 p-3 sm:p-5 mb-3 sm:mb-6 rounded-2xl shadow-sm flex flex-col touch-pan-y"
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
      <JumpToBottomButton
        visible={!isPinned}
        unreadCount={unreadCount}
        onClick={() => {
          pinnedRef.current = true;
          setIsPinned(true);
          lastSeenLenRef.current = rowsLenRef.current;
          setUnreadCount(0);
          lastUserScrollRef.current = 0;
          scrollToEnd("smooth");
        }}
      />
    </div>
  );
});

function JumpToBottomButton({
  visible,
  unreadCount,
  onClick,
}: {
  visible: boolean;
  unreadCount: number;
  onClick: () => void;
}) {
  // Cap displayed count at 9+ so the badge stays compact.
  const display = unreadCount > 9 ? "9+" : String(unreadCount);
  // Sticky inside the scroll container, pinned to the bottom-right of the
  // visible viewport. Self-aligns to the end of the flex column so it
  // doesn't take its own row in the chat layout. Negative top margin pulls
  // it back over the preceding flex-grow spacer / rows; a zero-height
  // wrapper keeps it from displacing any rows.
  return (
    <div
      className="sticky bottom-3 self-end mr-1 -mt-12 h-0 z-10"
      aria-hidden={!visible}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label="Jump to latest"
        title="Jump to latest (End)"
        className={`relative flex items-center justify-center w-10 h-10 rounded-full bg-amber-400 text-slate-900 shadow-lg ring-1 ring-amber-300/50 hover:bg-amber-300 transition-opacity duration-150 ${
          visible
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none"
        }`}
        tabIndex={visible ? 0 : -1}
      >
        <ChevronDoubleDownIcon className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-slate-900 text-amber-300 text-[10px] font-bold leading-none flex items-center justify-center ring-1 ring-amber-300/40">
            {display}
          </span>
        )}
      </button>
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
  return (
    <div className="min-w-0 max-w-full" data-row-key={row.key}>
      {node}
    </div>
  );
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
