import { useState, useEffect, useRef, useCallback } from "react";

interface FileMentionProps {
  projectPath: string;
  contextFiles?: Set<string>;
  query: string;
  position: { top: number; left: number };
  onSelect: (filePath: string) => void;
  onClose: () => void;
}

export function FileMention({
  projectPath,
  contextFiles,
  query,
  position,
  onSelect,
  onClose,
}: FileMentionProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function loadFiles() {
      try {
        const res = await fetch(
          `/api/files/list?path=${encodeURIComponent(projectPath)}&recursive=true`,
        );
        if (res.ok) {
          const data = await res.json();
          setFiles(data.files);
        }
      } catch {
        // Failed to load
      }
    }
    loadFiles();
  }, [projectPath]);

  const filtered = files.filter((f) =>
    f.toLowerCase().includes(query.toLowerCase()),
  );

  // Sort: context files first, then alphabetical
  const sorted = [...filtered].sort((a, b) => {
    const aCtx = contextFiles?.has(a) ? 0 : 1;
    const bCtx = contextFiles?.has(b) ? 0 : 1;
    if (aCtx !== bCtx) return aCtx - bCtx;
    return a.localeCompare(b);
  });

  const displayed = sorted.slice(0, 15);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, displayed.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (displayed[selectedIndex]) {
          onSelect(displayed[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [displayed, selectedIndex, onSelect, onClose],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (displayed.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="fixed z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl max-h-64 overflow-auto w-80"
      style={{ bottom: position.top, left: position.left }}
    >
      {displayed.map((file, i) => {
        const isCtx = contextFiles?.has(file);
        return (
          <button
            key={file}
            onClick={() => onSelect(file)}
            className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
              i === selectedIndex
                ? "bg-blue-50 dark:bg-blue-900/30"
                : "hover:bg-slate-50 dark:hover:bg-slate-700/50"
            }`}
          >
            <span
              className={`truncate font-mono text-xs ${
                isCtx
                  ? "text-blue-500 dark:text-blue-400 font-medium"
                  : "text-slate-600 dark:text-slate-300"
              }`}
            >
              {file}
            </span>
            {isCtx && (
              <span className="text-[10px] text-blue-400 bg-blue-100 dark:bg-blue-900/30 px-1.5 py-0.5 rounded flex-shrink-0">
                ctx
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
