/**
 * StatusLine — Single transient status indicator for Claude's activity.
 *
 * Replaces the generic "thinking" spinner with classified status labels
 * like "Reading source files…", "Executing tests…", "Searching codebase…".
 *
 * The status line overwrites itself as new activity arrives — tool output
 * never accumulates in the chat. Only substantive Claude text becomes
 * permanent messages.
 */

import { useState, useEffect, useRef, memo } from "react";
import type { DisplayStatus } from "../utils/statusClassifier";

// Braille dots — the classic cli-spinners "dots" preset. All ten frames
// are single-cell-width in any monospace font, so the adjacent label does
// not jitter horizontally as the spinner advances. (The previous frames
// "·+✦✿" mixed narrow ASCII with double-width symbols and made the action
// word wiggle on every tick.)
const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/**
 * Map DisplayStatus.kind to a Tailwind color class for the spinner + label.
 */
function kindColor(kind: DisplayStatus["kind"]): string {
  switch (kind) {
    case "thinking":
    case "analysis":
      return "text-cyan-400";
    case "search":
      return "text-yellow-400";
    case "read":
      return "text-blue-400";
    case "write":
    case "patch":
      return "text-emerald-400";
    case "run":
      return "text-orange-400";
    case "test":
      return "text-purple-400";
    case "build":
      return "text-amber-400";
    case "network":
      return "text-sky-400";
    case "subagent":
      return "text-pink-400";
    case "final":
      return "text-slate-400";
  }
}

interface StatusLineProps {
  /** Current status to display. Null = hidden. */
  status: DisplayStatus | null;
}

export const StatusLine = memo(function StatusLine({ status }: StatusLineProps) {
  const [frame, setFrame] = useState(0);
  const prevLabelRef = useRef<string | null>(null);
  const [fadeClass, setFadeClass] = useState("opacity-100");

  // Spinner animation. 80ms cadence matches the cli-spinners dots preset.
  useEffect(() => {
    if (!status) return;
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      80,
    );
    return () => clearInterval(id);
  }, [status]);

  // Fade transition when label changes
  useEffect(() => {
    if (!status) {
      prevLabelRef.current = null;
      return;
    }
    if (prevLabelRef.current !== status.label) {
      setFadeClass("opacity-0");
      const id = setTimeout(() => {
        setFadeClass("opacity-100");
        prevLabelRef.current = status.label;
      }, 80);
      return () => clearTimeout(id);
    }
  }, [status?.label]);

  if (!status) return null;

  const color = kindColor(status.kind);

  return (
    <div
      className={`my-2 transition-opacity duration-150 ${fadeClass}`}
      role="status"
      aria-live="polite"
    >
      <span className={`font-mono text-sm inline-flex items-center gap-2 ${color}`}>
        {/* Fixed-width slot for the spinner glyph. Even though the braille
            frames are all single-cell-width in monospace, pinning the box
            width prevents subpixel rounding from nudging the label. */}
        <span
          aria-hidden="true"
          className="inline-block text-center"
          style={{ width: "1ch" }}
        >
          {SPINNER_FRAMES[frame]}
        </span>
        <span>{status.label}</span>
      </span>
    </div>
  );
});
