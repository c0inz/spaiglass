import { useState, useEffect, useCallback, useRef } from "react";
import {
  PlusIcon,
  TrashIcon,
  ArrowRightIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";

export interface QueueItem {
  id: string;
  text: string;
  createdAt: number;
}

interface QueueTabProps {
  workingDirectory: string;
  roleFile: string;
  /** Pushes the item text into the chat composer. */
  onInjectText: (text: string) => void;
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
}: QueueTabProps) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef<HTMLTextAreaElement>(null);

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
        {loading && items.length === 0 ? (
          <div className="text-xs text-slate-400 px-3 py-2">Loading…</div>
        ) : items.length === 0 ? (
          <div className="text-xs text-slate-400 px-3 py-4 text-center">
            Have no cue
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
      </div>
    </div>
  );
}
