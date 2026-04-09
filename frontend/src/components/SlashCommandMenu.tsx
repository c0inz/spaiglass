/**
 * SlashCommandMenu — Dropdown shown when user types "/" in chat input.
 * Same UI pattern as FileMention (@-mention dropdown).
 */

import { useState, useEffect, useRef } from "react";

interface SlashCommandMenuProps {
  commands: string[];
  query: string;
  position: { top: number; left: number };
  onSelect: (command: string) => void;
  onClose: () => void;
}

export function SlashCommandMenu({
  commands,
  query,
  position,
  onSelect,
  onClose,
}: SlashCommandMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  // Filter commands by query
  const filtered = commands.filter((cmd) =>
    cmd.toLowerCase().includes(query.toLowerCase()),
  );

  // Reset selection when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (filtered.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        onSelect(filtered[selectedIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [filtered, selectedIndex, onSelect, onClose]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={menuRef}
      className="absolute z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg max-h-48 overflow-y-auto"
      style={{
        bottom: position.top,
        left: position.left,
        minWidth: "200px",
      }}
    >
      {filtered.map((cmd, index) => (
        <button
          key={cmd}
          type="button"
          className={`w-full px-3 py-2 text-left text-sm font-mono flex items-center gap-2 ${
            index === selectedIndex
              ? "bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200"
              : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
          }`}
          onClick={() => onSelect(cmd)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <span className="text-slate-400 dark:text-slate-500">/</span>
          {cmd}
        </button>
      ))}
    </div>
  );
}
