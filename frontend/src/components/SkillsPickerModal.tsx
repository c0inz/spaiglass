/**
 * SkillsPickerModal — full skill catalog with pin/unpin toggles. Opened
 * from the "+" button at the end of SkillsChipRow. Lists skills grouped
 * by plugin; user stars/unstars to manage which appear in the chip row.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  StarIcon as StarOutlineIcon,
  XMarkIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/24/outline";
import { StarIcon as StarSolidIcon } from "@heroicons/react/24/solid";
import type { SkillInfo } from "../hooks/useSkills";

interface SkillsPickerModalProps {
  open: boolean;
  onClose: () => void;
  skills: SkillInfo[];
  loading: boolean;
  error: string | null;
  isPinned: (id: string) => boolean;
  toggle: (id: string) => void;
}

export function SkillsPickerModal({
  open,
  onClose,
  skills,
  loading,
  error,
  isPinned,
  toggle,
}: SkillsPickerModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Group by plugin AFTER filtering so empty plugins disappear.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.pluginId.toLowerCase().includes(q),
        )
      : skills;
    const map = new Map<string, SkillInfo[]>();
    for (const s of filtered) {
      const arr = map.get(s.pluginId) ?? [];
      arr.push(s);
      map.set(s.pluginId, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [skills, query]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
    >
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Pin skills to the chip row
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            aria-label="Close"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-700">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter skills…"
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded focus:outline-none focus:ring-1 focus:ring-amber-500 text-slate-900 dark:text-slate-100 placeholder-slate-400"
              autoFocus
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-8 text-center text-sm text-slate-400">
              Loading skills…
            </div>
          ) : error ? (
            <div className="px-4 py-8 text-center text-sm text-red-500">
              {error}
            </div>
          ) : groups.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-slate-400">
              {query
                ? `No skills match "${query.trim()}"`
                : "No skills installed"}
            </div>
          ) : (
            groups.map(([pluginId, items]) => (
              <div key={pluginId}>
                <div className="sticky top-0 px-4 py-1 text-[10px] uppercase tracking-[0.15em] text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/80 backdrop-blur-sm border-b border-slate-100 dark:border-slate-800">
                  {pluginId}
                  <span className="ml-2 text-slate-400 dark:text-slate-500 normal-case tracking-normal">
                    ({items.length})
                  </span>
                </div>
                {items.map((s) => {
                  const pinned = isPinned(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggle(s.id)}
                      className="w-full flex items-start gap-3 px-4 py-2 text-left border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                    >
                      {pinned ? (
                        <StarSolidIcon className="flex-shrink-0 w-4 h-4 mt-0.5 text-amber-400" />
                      ) : (
                        <StarOutlineIcon className="flex-shrink-0 w-4 h-4 mt-0.5 text-slate-300 dark:text-slate-600" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                          {s.name}
                        </div>
                        {s.description && (
                          <div className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
                            {s.description}
                          </div>
                        )}
                        <div className="mt-0.5 text-[10px] font-mono text-slate-400 dark:text-slate-500">
                          {s.slashCommand}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-700 text-[11px] text-slate-500 dark:text-slate-400">
          Click a star to pin/unpin. Pinned skills appear as chips above the
          chat input — click a chip to insert its slash command.
        </div>
      </div>
    </div>
  );
}
