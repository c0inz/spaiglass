/**
 * Phase 6.2: TerminalChat — drop-in replacement for ChatMessages that uses
 * the terminal interpreter under the ?renderer=terminal feature flag.
 *
 * This component owns the same scroll/empty-state behavior as the legacy
 * ChatMessages so it can be swapped in by ChatMessages.tsx without any
 * caller changes. The legacy renderer remains the default until P6.3
 * cuts over.
 */

import { useEffect, useRef } from "react";
import type { AllMessage } from "../types";
import { renderTerminalMessage } from "./interpreter";
import { TermSpinner } from "./components";

interface TerminalChatProps {
  messages: AllMessage[];
  isLoading: boolean;
}

export function TerminalChat({ messages, isLoading }: TerminalChatProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto bg-white/70 dark:bg-slate-800/70 border border-slate-200/60 dark:border-slate-700/60 p-3 sm:p-6 mb-3 sm:mb-6 rounded-2xl shadow-sm backdrop-blur-sm flex flex-col"
    >
      {messages.length === 0 ? (
        <TerminalEmptyState />
      ) : (
        <>
          <div className="flex-1" aria-hidden="true" />
          {messages.map((msg, idx) => {
            const node = renderTerminalMessage(msg);
            if (node == null) return null;
            return (
              <div key={`${msg.timestamp}-${idx}`} className="contents">
                {node}
              </div>
            );
          })}
          {isLoading && (
            <div className="my-2">
              <TermSpinner label="thinking" />
            </div>
          )}
          <div ref={endRef} />
        </>
      )}
    </div>
  );
}

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
