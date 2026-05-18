import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  PlusIcon,
  TrashIcon,
  ArrowRightIcon,
  XMarkIcon,
  MagnifyingGlassIcon,
  ChevronDoubleRightIcon,
} from "@heroicons/react/24/outline";

export interface QueueItem {
  id: string;
  text: string;
  createdAt: number;
}

export interface UserPromptEntry {
  /** Stable row.key from the frame reducer — used to scroll the chat to
   *  this exact message when the user clicks. */
  rowKey: string;
  text: string;
  ts: number;
}

interface QueueTabProps {
  workingDirectory: string;
  roleFile: string;
  /** Pushes the item text into the chat composer. */
  onInjectText: (text: string) => void;
  /** Last 10 user prompts in this session, newest-first. */
  recentUserPrompts: UserPromptEntry[];
  /** Every user prompt in this session, newest-first. Used by Search. */
  allUserPrompts: UserPromptEntry[];
  /** Scroll the chat to the row with this stable key, centered. */
  onJumpToMessage: (rowKey: string) => void;
}

function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return "now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ts).toLocaleDateString();
}

function queueUrl(wd: string, role: string, suffix = ""): string {
  return (
    `/api/session/queue${suffix}?workingDirectory=${encodeURIComponent(wd)}` +
    `&roleFile=${encodeURIComponent(role)}`
  );
}

function firstWords(text: string, n: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= n) return words.join(" ");
  return words.slice(0, n).join(" ") + "…";
}

export function QueueTab({
  workingDirectory,
  roleFile,
  onInjectText,
  recentUserPrompts,
  allUserPrompts,
  onJumpToMessage,
}: QueueTabProps) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const draftRef = useRef<HTMLTextAreaElement>(null);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return allUserPrompts
      .filter((p) => p.text.toLowerCase().includes(q))
      .slice(0, 50);
  }, [allUserPrompts, searchQuery]);

  const load = useCallback(async () => {
    if (!workingDirectory || !roleFile) return;
    setLoading(true);
    try {
      const res = await fetch(queueUrl(workingDirectory, roleFile));
      if (res.ok) {
        const data = (await res.json()) as { items?: QueueItem[] };
        setItems(Array.isArray(data.items) ? data.items : []);
      }
    } catch {
      /* ignore — empty state will be shown */
    }
    setLoading(false);
  }, [workingDirectory, roleFile]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (composing) {
      requestAnimationFrame(() => draftRef.current?.focus());
    }
  }, [composing]);

  const handleAdd = async () => {
    const text = draft.trim();
    if (!text) return;
    try {
      const res = await fetch(queueUrl(workingDirectory, roleFile), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { item?: QueueItem };
      if (data.item) setItems((prev) => [...prev, data.item as QueueItem]);
      setDraft("");
      setComposing(false);
    } catch {
      /* swallow; user can retry */
    }
  };

  const handleDelete = async (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    try {
      await fetch(
        queueUrl(workingDirectory, roleFile, `/${encodeURIComponent(id)}`),
        { method: "DELETE" },
      );
    } catch {
      /* optimistic UI already applied */
    }
  };

  const handleInject = (item: QueueItem) => {
    onInjectText(item.text);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Add / compose area */}
      <div className="border-b border-slate-200 dark:border-slate-700 p-2">
        {!composing ? (
          <button
            onClick={() => setComposing(true)}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded transition-colors"
          >
            <PlusIcon className="w-3.5 h-3.5" />
            Cue up
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            <textarea
              ref={draftRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleAdd();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft("");
                  setComposing(false);
                }
              }}
              placeholder="Draft prompt… (⌘/Ctrl+Enter saves)"
              rows={4}
              className="w-full text-xs p-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="flex gap-2">
              <button
                onClick={handleAdd}
                disabled={!draft.trim()}
                className="flex-1 text-xs font-medium py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded transition-colors"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setDraft("");
                  setComposing(false);
                }}
                className="text-xs font-medium px-2 py-1 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
                title="Cancel"
              >
                <XMarkIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto py-1">
        {/* Cue */}
        <div className="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-[0.15em] text-slate-500 dark:text-slate-400">
          Cue
          <span className="ml-1.5 text-slate-400 dark:text-slate-500 normal-case tracking-normal">
            ({items.length})
          </span>
        </div>
        {loading && items.length === 0 ? (
          <div className="text-xs text-slate-400 px-3 py-2">Loading…</div>
        ) : items.length === 0 ? (
          <div className="text-xs text-slate-400 px-3 py-2 italic">
            No queued prompts.
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="group flex items-start gap-1 py-1.5 px-2 hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors"
            >
              <div
                className="flex-1 min-w-0 text-xs text-slate-700 dark:text-slate-300 cursor-default"
                title={item.text}
              >
                {firstWords(item.text, 10)}
              </div>
              <button
                onClick={() => handleInject(item)}
                className="flex-shrink-0 p-1 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded opacity-60 group-hover:opacity-100 transition-opacity"
                title="Send to composer"
              >
                <ArrowRightIcon className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleDelete(item.id)}
                className="flex-shrink-0 p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded opacity-60 group-hover:opacity-100 transition-opacity"
                title="Delete"
              >
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))
        )}

        {/* History — last 10 user prompts in this session */}
        <div className="mt-3 px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-[0.15em] text-slate-500 dark:text-slate-400 border-t border-slate-200 dark:border-slate-700">
          History
          <span className="ml-1.5 text-slate-400 dark:text-slate-500 normal-case tracking-normal">
            (last {recentUserPrompts.length})
          </span>
        </div>
        {recentUserPrompts.length === 0 ? (
          <div className="text-xs text-slate-400 px-3 py-2 italic">
            No prompts sent yet.
          </div>
        ) : (
          recentUserPrompts.map((p) => (
            <PromptRow
              key={p.rowKey}
              prompt={p}
              onClick={() => onJumpToMessage(p.rowKey)}
            />
          ))
        )}

        {/* Search — across every user prompt in this session */}
        <div className="mt-3 px-2 pt-1 pb-1 text-[10px] uppercase tracking-[0.15em] text-slate-500 dark:text-slate-400 border-t border-slate-200 dark:border-slate-700">
          Search
          <span className="ml-1.5 text-slate-400 dark:text-slate-500 normal-case tracking-normal">
            ({allUserPrompts.length} total)
          </span>
        </div>
        <div className="px-2 pb-1">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Find a prior message…"
              className="w-full pl-7 pr-7 py-1 text-xs bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded focus:outline-none focus:ring-1 focus:ring-amber-500 text-slate-900 dark:text-slate-100 placeholder-slate-400"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded"
                title="Clear"
              >
                <XMarkIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        {searchQuery.trim() &&
          (searchResults.length === 0 ? (
            <div className="text-xs text-slate-400 px-3 py-2 italic">
              No messages match “{searchQuery.trim()}”.
            </div>
          ) : (
            <>
              {searchResults.map((p) => (
                <PromptRow
                  key={p.rowKey}
                  prompt={p}
                  onClick={() => onJumpToMessage(p.rowKey)}
                  highlight={searchQuery.trim()}
                />
              ))}
              {allUserPrompts.filter((p) =>
                p.text.toLowerCase().includes(searchQuery.trim().toLowerCase()),
              ).length > 50 && (
                <div className="text-[10px] text-slate-400 px-3 py-1 italic">
                  showing first 50 matches — refine to narrow
                </div>
              )}
            </>
          ))}
      </div>
    </div>
  );
}

function PromptRow({
  prompt,
  onClick,
  highlight,
}: {
  prompt: UserPromptEntry;
  onClick: () => void;
  highlight?: string;
}) {
  const snippet = prompt.text.length > 120
    ? prompt.text.slice(0, 117).trimEnd() + "…"
    : prompt.text;
  return (
    <button
      onClick={onClick}
      title={prompt.text}
      className="group w-full flex items-start gap-2 py-1.5 px-2 text-left hover:bg-amber-50 dark:hover:bg-amber-400/10 transition-colors"
    >
      <ChevronDoubleRightIcon className="flex-shrink-0 w-3 h-3 mt-0.5 text-amber-500 dark:text-amber-400 opacity-70 group-hover:opacity-100" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-700 dark:text-slate-200 truncate">
          {highlight ? renderHighlighted(snippet, highlight) : snippet}
        </div>
      </div>
      <span className="flex-shrink-0 text-[10px] tabular-nums text-slate-400 dark:text-slate-500 mt-0.5">
        {formatRelativeTime(prompt.ts)}
      </span>
    </button>
  );
}

function renderHighlighted(text: string, query: string) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-amber-200 dark:bg-amber-400/40 text-slate-900 dark:text-amber-100 rounded-sm px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}
