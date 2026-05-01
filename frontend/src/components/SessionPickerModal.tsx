import { useState, useEffect, useRef } from "react";
import { PlusIcon } from "@heroicons/react/24/outline";
import type { ConversationSummary } from "../../../shared/types";
import { getHistoriesUrl } from "../config/api";

interface SessionPickerModalProps {
  open: boolean;
  onClose: () => void;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  encodedName: string | null;
  currentSessionId: string | null;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hr = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mo}-${day} ${hr}:${min}`;
}

function truncateId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatDuration(ms?: number): string | null {
  if (!ms || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h${mm}m` : `${h}h`;
}

function shortModel(model?: string): string | null {
  if (!model) return null;
  // "claude-opus-4-6-20241022" → "opus-4-6"
  const m = model.match(/claude-([a-z0-9-]+?)(?:-\d{8})?$/i);
  if (m) return m[1];
  return model.length > 16 ? model.slice(0, 16) : model;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export function SessionPickerModal({
  open,
  onClose,
  onNewSession,
  onSelectSession,
  encodedName,
  currentSessionId,
}: SessionPickerModalProps) {
  const [sessions, setSessions] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !encodedName) return;
    setLoading(true);
    fetch(getHistoriesUrl(encodedName))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setSessions(data?.conversations || []))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [open, encodedName]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
    >
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl overflow-hidden">
        {/* New Session button */}
        <button
          onClick={() => {
            onNewSession();
            onClose();
          }}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-emerald-50 dark:hover:bg-emerald-900/20 border-b border-slate-200 dark:border-slate-700 transition-colors"
        >
          <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center flex-shrink-0">
            <PlusIcon className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
            New Session
          </span>
        </button>

        {/* Session list */}
        <div className="max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="px-4 py-6 text-center text-sm text-slate-400">
              Loading sessions...
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-slate-400">
              No past sessions
            </div>
          ) : (
            sessions.map((s) => {
              const isCurrent = currentSessionId === s.sessionId;
              const intent = s.firstUserMessage || s.lastMessagePreview || "No preview";
              const lastUser = s.lastUserMessage;
              const showLastUser = lastUser && lastUser !== s.firstUserMessage;
              const duration = formatDuration(s.durationMs);
              const model = shortModel(s.model);
              const turns =
                typeof s.userTurnCount === "number"
                  ? `${s.userTurnCount}↔${s.assistantTurnCount ?? 0}`
                  : `${s.messageCount}msg`;
              const files = s.filesTouched || [];
              return (
                <button
                  key={s.sessionId}
                  onClick={() => {
                    onSelectSession(s.sessionId);
                    onClose();
                  }}
                  className={`w-full text-left px-4 py-3 border-b border-slate-100 dark:border-slate-800 transition-colors ${
                    isCurrent
                      ? "bg-amber-50 dark:bg-amber-900/20"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  }`}
                >
                  {/* Row 1: intent (first user message) + last-activity timestamp */}
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500 flex-shrink-0">
                      {truncateId(s.sessionId)}
                    </span>
                    <span className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate flex-1 min-w-0">
                      {intent}
                    </span>
                    <span className="text-[11px] text-slate-400 dark:text-slate-500 flex-shrink-0 whitespace-nowrap">
                      {formatTimestamp(s.lastTime)}
                    </span>
                  </div>

                  {/* Row 2: metadata badges (turns · duration · model · file count) */}
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 flex-wrap">
                    <span className="font-mono">{turns} turns</span>
                    {duration && (
                      <>
                        <span className="text-slate-300 dark:text-slate-600">·</span>
                        <span>{duration}</span>
                      </>
                    )}
                    {model && (
                      <>
                        <span className="text-slate-300 dark:text-slate-600">·</span>
                        <span className="font-mono">{model}</span>
                      </>
                    )}
                    {files.length > 0 && (
                      <>
                        <span className="text-slate-300 dark:text-slate-600">·</span>
                        <span title={files.join("\n")}>
                          {files.length} file{files.length === 1 ? "" : "s"}
                        </span>
                      </>
                    )}
                  </div>

                  {/* Row 3: top file paths (small) */}
                  {files.length > 0 && (
                    <div className="mt-1 text-[11px] font-mono text-slate-400 dark:text-slate-500 truncate">
                      {files.slice(0, 3).map(basename).join(" · ")}
                      {files.length > 3 && ` +${files.length - 3}`}
                    </div>
                  )}

                  {/* Row 4: last user message (if different from first) */}
                  {showLastUser && (
                    <div className="mt-1 text-[12px] text-slate-500 dark:text-slate-400 truncate italic">
                      last: {lastUser}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
