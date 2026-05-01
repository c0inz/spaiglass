import { useState, useEffect, useRef } from "react";
import { PlusIcon, CommandLineIcon, FolderIcon } from "@heroicons/react/24/outline";
import type { ClaudeSessionRow } from "../../../shared/types";
import { getClaudeSessionsUrl } from "../config/api";

interface SessionPickerModalProps {
  open: boolean;
  onClose: () => void;
  onNewSession: () => void;
  /**
   * Resume a session in the *current* project context. ChatPage handles the
   * URL search-param + reload — used when the picked session lives in the
   * same project the user is already on, or when no project mapping exists.
   */
  onSelectSession: (sessionId: string) => void;
  /**
   * Resume a session in a *different* project. The picker computes the
   * target URL (path-level navigate) so the cwd / role context follows.
   */
  onSelectSessionInProject?: (sessionId: string, targetUrl: string) => void;
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

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

function shortModel(model?: string): string | null {
  if (!model) return null;
  const m = model.match(/claude-([a-z0-9-]+?)(?:-\d{8})?$/i);
  if (m) return m[1];
  return model.length > 16 ? model.slice(0, 16) : model;
}

export function SessionPickerModal({
  open,
  onClose,
  onNewSession,
  onSelectSession,
  onSelectSessionInProject,
  currentSessionId,
}: SessionPickerModalProps) {
  const [sessions, setSessions] = useState<ClaudeSessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(getClaudeSessionsUrl())
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setSessions(data?.sessions || []))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  // The current connector slug + project segment come from the relay-injected
  // __SG context. We use them to construct cross-project navigation URLs so
  // picking a session in a different project teleports the user to that
  // project's context (matching the cwd / role file the SDK will resume into).
  const sg = (window as Window & {
    __SG?: { slug?: string; segment?: string; project?: string };
  }).__SG;
  const connectorSlug = sg?.slug;
  const currentSegment = sg?.segment;

  function handlePick(row: ClaudeSessionRow) {
    // Project segment used by the relay's URL router is the directory's
    // basename. e.g. /home/foo/projects/OCMarketplace → "OCMarketplace".
    const targetSegment = basename(row.projectPath);
    const sameProject =
      !targetSegment || !currentSegment || targetSegment === currentSegment;

    if (sameProject || !connectorSlug || !onSelectSessionInProject) {
      onSelectSession(row.sessionId);
    } else {
      // Cross-project resume: hard-navigate so ChatPage re-resolves the
      // working directory + role from the new URL segment. We do NOT carry
      // the role across — the destination project owns its role mapping.
      const url = `/vm/${connectorSlug}/${encodeURIComponent(targetSegment)}/?sessionId=${encodeURIComponent(row.sessionId)}`;
      onSelectSessionInProject(row.sessionId, url);
    }
    onClose();
  }

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
              No past sessions on this VM
            </div>
          ) : (
            sessions.map((s) => {
              const isCurrent = currentSessionId === s.sessionId;
              // Match `claude --resume`: lead with the LAST user message —
              // it's the most likely cue for "what was I working on?".
              const preview =
                s.lastUserMessage || s.firstUserMessage || s.lastMessagePreview || "(no preview)";
              const projectLabel = basename(s.projectPath) || s.projectPath;
              const isSpaiglass = s.source === "spaiglass";
              const model = shortModel(s.model);
              const turns =
                typeof s.userTurnCount === "number"
                  ? `${s.userTurnCount}↔${s.assistantTurnCount ?? 0}`
                  : `${s.messageCount}msg`;
              return (
                <button
                  key={s.sessionId}
                  onClick={() => handlePick(s)}
                  className={`w-full text-left px-4 py-3 border-b border-slate-100 dark:border-slate-800 transition-colors ${
                    isCurrent
                      ? "bg-amber-50 dark:bg-amber-900/20"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  }`}
                >
                  {/* Row 1: source badge + project + timestamp */}
                  <div className="flex items-center gap-2 mb-1">
                    {isSpaiglass ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">
                        <FolderIcon className="w-3 h-3" />
                        SpAIglass · {projectLabel}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                        <CommandLineIcon className="w-3 h-3" />
                        Claude CLI
                      </span>
                    )}
                    <span className="text-[11px] text-slate-400 dark:text-slate-500 ml-auto whitespace-nowrap">
                      {formatTimestamp(s.lastTime)}
                    </span>
                  </div>

                  {/* Row 2: last user message preview */}
                  <div className="text-sm text-slate-800 dark:text-slate-100 line-clamp-2">
                    {preview}
                  </div>

                  {/* Row 3: metadata + cwd */}
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 flex-wrap">
                    <span className="font-mono">{turns} turns</span>
                    {model && (
                      <>
                        <span className="text-slate-300 dark:text-slate-600">·</span>
                        <span className="font-mono">{model}</span>
                      </>
                    )}
                    {!isSpaiglass && (
                      <>
                        <span className="text-slate-300 dark:text-slate-600">·</span>
                        <span className="font-mono truncate" title={s.projectPath}>
                          {s.projectPath}
                        </span>
                      </>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

