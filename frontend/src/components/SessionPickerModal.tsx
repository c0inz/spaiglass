import { useState, useEffect, useRef } from "react";
import {
  PlusIcon,
  CommandLineIcon,
  FolderIcon,
  ArrowDownTrayIcon,
} from "@heroicons/react/24/outline";
import type { ClaudeSessionRow } from "../../../shared/types";
import { getClaudeSessionsUrl } from "../config/api";

interface SessionPickerModalProps {
  open: boolean;
  onClose: () => void;
  onNewSession: () => void;
  /**
   * Resume the picked session. The picker always builds a target URL
   * carrying both `sessionId` and `cwd` — ChatPage uses `cwd` from the URL
   * as the authoritative working directory regardless of the URL segment,
   * so resume always lands in the session's recorded directory.
   */
  onResumeWithCwd: (targetUrl: string) => void;
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
  onResumeWithCwd,
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

  const sg = (
    window as Window & {
      __SG?: { slug?: string; segment?: string; project?: string };
    }
  ).__SG;
  const connectorSlug = sg?.slug;
  const currentSegment = sg?.segment;

  function handlePick(row: ClaudeSessionRow) {
    // Always carry cwd in the URL — ChatPage uses it as the authoritative
    // working directory, so the resume lands in whatever directory the
    // session was recorded in (regardless of which segment we route under).
    //
    // Segment selection: SpaiGlass-tracked sessions navigate to the project
    // segment derived from their cwd (URL matches reality). Claude CLI
    // sessions stay on the current segment — we don't guess at a project
    // entry that may not exist. Either way, ChatPage's cwd-from-URL logic
    // makes workingDirectory authoritative.
    const sessionCwd = row.spaiglassWorkingDirectory || row.projectPath;
    const targetSegment =
      row.source === "spaiglass" && sessionCwd
        ? basename(sessionCwd)
        : currentSegment || basename(sessionCwd) || "";
    const slug = connectorSlug || "";
    const params = new URLSearchParams({
      sessionId: row.sessionId,
      cwd: sessionCwd,
    });
    if (row.source === "spaiglass" && row.spaiglassRoleFile) {
      params.set("role", row.spaiglassRoleFile);
    }
    const url = slug
      ? `/vm/${slug}/${encodeURIComponent(targetSegment)}/?${params.toString()}`
      : `?${params.toString()}`;
    onResumeWithCwd(url);
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
                s.lastUserMessage ||
                s.firstUserMessage ||
                s.lastMessagePreview ||
                "(no preview)";
              const projectLabel = basename(s.projectPath) || s.projectPath;
              const isSpaiglass = s.source === "spaiglass";
              const model = shortModel(s.model);
              const turns =
                typeof s.userTurnCount === "number"
                  ? `${s.userTurnCount}↔${s.assistantTurnCount ?? 0}`
                  : `${s.messageCount}msg`;
              return (
                <div
                  key={s.sessionId}
                  role="button"
                  tabIndex={0}
                  onClick={() => handlePick(s)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handlePick(s);
                    }
                  }}
                  className={`group relative w-full text-left px-4 py-3 border-b border-slate-100 dark:border-slate-800 transition-colors cursor-pointer ${
                    isCurrent
                      ? "bg-amber-50 dark:bg-amber-900/20"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  }`}
                >
                  {/* Row 1: source badge + project + timestamp + download icon.
                      Download is a real <button> nested inside a div-with-role
                      (the row); clicking it stops propagation so the session
                      isn't resumed. We also keep the icon hidden until row
                      hover/focus so it doesn't clutter at-rest visuals. */}
                  <div className="flex items-center gap-2 mb-1">
                    {isSpaiglass ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-emerald-500 text-white shadow-sm dark:bg-emerald-600">
                        <FolderIcon className="w-3 h-3 stroke-[2.5]" />
                        SpAIglass
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-slate-700 text-slate-100 shadow-sm dark:bg-slate-600">
                        <CommandLineIcon className="w-3 h-3 stroke-[2.5]" />
                        Terminal
                      </span>
                    )}
                    {isSpaiglass && (
                      <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 truncate">
                        {projectLabel}
                      </span>
                    )}
                    <span className="text-[11px] text-slate-400 dark:text-slate-500 ml-auto whitespace-nowrap">
                      {formatTimestamp(s.lastTime)}
                    </span>
                    <button
                      type="button"
                      title="Download session log (Markdown)"
                      aria-label="Download session log"
                      onClick={(e) => {
                        e.stopPropagation();
                        const params = new URLSearchParams({ format: "md" });
                        if (!isSpaiglass && s.encodedProject) {
                          params.set("project", s.encodedProject);
                        }
                        const slug = connectorSlug || "";
                        const url = slug
                          ? `/vm/${slug}/api/sessions/${encodeURIComponent(
                              s.sessionId,
                            )}/download?${params.toString()}`
                          : `/api/sessions/${encodeURIComponent(
                              s.sessionId,
                            )}/download?${params.toString()}`;
                        // Browser handles the download response. Anchor +
                        // click avoids navigation away from the modal.
                        const a = document.createElement("a");
                        a.href = url;
                        a.rel = "noopener";
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                      }}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
                    >
                      <ArrowDownTrayIcon className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Row 2: last user message preview */}
                  <div className="text-sm text-slate-800 dark:text-slate-100 line-clamp-2">
                    {preview}
                  </div>

                  {/* Row 3: cwd — shown for every row so the user knows where
                       picking will land them. Title attr exposes the full path
                       on hover even when the cell is truncated. */}
                  <div
                    className="mt-1 text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate"
                    title={s.spaiglassWorkingDirectory || s.projectPath}
                  >
                    cwd: {s.spaiglassWorkingDirectory || s.projectPath}
                  </div>

                  {/* Row 4: metadata badges */}
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 flex-wrap">
                    <span className="font-mono">{turns} turns</span>
                    {model && (
                      <>
                        <span className="text-slate-300 dark:text-slate-600">
                          ·
                        </span>
                        <span className="font-mono">{model}</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
