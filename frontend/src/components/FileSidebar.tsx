import { useState, useEffect, useCallback } from "react";
import {
  FolderIcon,
  FolderOpenIcon,
  DocumentIcon,
  ChevronRightIcon,
  ArrowPathIcon,
} from "@heroicons/react/24/outline";
import type { SessionStats } from "../types";
import { HelpPanel } from "./HelpPanel";

interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeEntry[];
}

interface ContextFileEntry {
  path: string;
  name: string;
  touchedAt: number;
}

interface FileSidebarProps {
  projectPath: string;
  onFileSelect: (path: string, name: string) => void;
  contextFiles?: Set<string>;
  contextFilesList?: ContextFileEntry[];
  sessionStats?: SessionStats;
  slashCommands?: string[];
}

function TreeNode({
  entry,
  depth,
  onFileSelect,
  contextFiles,
}: {
  entry: TreeEntry;
  depth: number;
  onFileSelect: (path: string, name: string) => void;
  contextFiles?: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const isEditable = /\.(md|json|txt)$/i.test(entry.name);
  const isContext = contextFiles?.has(entry.path);

  const loadChildren = async () => {
    if (children.length > 0) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/files/tree?path=${encodeURIComponent(entry.path)}`,
      );
      if (res.ok) {
        const data = await res.json();
        setChildren(data.entries);
      }
    } catch {
      // Failed to load
    }
    setLoading(false);
  };

  const handleClick = () => {
    if (entry.isDir) {
      setExpanded(!expanded);
      if (!expanded) loadChildren();
    } else {
      onFileSelect(entry.path, entry.name);
    }
  };

  return (
    <div>
      <button
        onClick={handleClick}
        className={`w-full flex items-center gap-1.5 py-1 px-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-700/50 rounded transition-colors ${
          isContext
            ? "text-blue-500 dark:text-blue-400"
            : "text-slate-700 dark:text-slate-300"
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {entry.isDir ? (
          <>
            <ChevronRightIcon
              className={`w-3 h-3 flex-shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
            {expanded ? (
              <FolderOpenIcon className="w-4 h-4 flex-shrink-0 text-blue-500 dark:text-blue-400" />
            ) : (
              <FolderIcon className="w-4 h-4 flex-shrink-0 text-slate-400" />
            )}
          </>
        ) : (
          <>
            <span className="w-3" />
            <DocumentIcon
              className={`w-4 h-4 flex-shrink-0 ${
                isEditable
                  ? "text-green-500 dark:text-green-400"
                  : "text-slate-400"
              }`}
            />
          </>
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {expanded && !loading && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              onFileSelect={onFileSelect}
              contextFiles={contextFiles}
            />
          ))}
        </div>
      )}
      {loading && (
        <div
          className="text-xs text-slate-400 py-1"
          style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
        >
          Loading...
        </div>
      )}
    </div>
  );
}

export function FileSidebar({
  projectPath,
  onFileSelect,
  contextFiles,
  contextFilesList,
  sessionStats,
  slashCommands,
}: FileSidebarProps) {
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"tree" | "context" | "help">("tree");

  const loadTree = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/files/tree?path=${encodeURIComponent(projectPath)}`,
      );
      if (res.ok) {
        const data = await res.json();
        setTree(data.entries);
      }
    } catch {
      // Failed to load
    }
    setLoading(false);
  }, [projectPath]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const sortedContextFiles = [...(contextFilesList || [])].sort(
    (a, b) => b.touchedAt - a.touchedAt,
  );

  return (
    <div className="h-full flex flex-col bg-white dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700">
      {/* Tabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-700">
        <button
          onClick={() => setActiveTab("tree")}
          className={`flex-1 text-xs font-medium py-2 transition-colors ${
            activeTab === "tree"
              ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
              : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
          }`}
        >
          Tree
        </button>
        <button
          onClick={() => setActiveTab("context")}
          className={`flex-1 text-xs font-medium py-2 transition-colors ${
            activeTab === "context"
              ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
              : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
          }`}
        >
          Context
          {sortedContextFiles.length > 0 && (
            <span className="ml-1 text-[10px] bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded-full">
              {sortedContextFiles.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("help")}
          className={`flex-1 text-xs font-medium py-2 transition-colors ${
            activeTab === "help"
              ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
              : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
          }`}
        >
          Help
        </button>
        <button
          onClick={loadTree}
          className="px-2 py-2 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          title="Refresh"
        >
          <ArrowPathIcon className="w-3 h-3 text-slate-400" />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto py-1">
        {activeTab === "help" ? (
          <HelpPanel
            stats={sessionStats || { model: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalCost: 0, turns: 0, durationMs: 0, sessionId: "" }}
            slashCommands={slashCommands || []}
          />
        ) : activeTab === "tree" ? (
          loading && tree.length === 0 ? (
            <div className="text-xs text-slate-400 px-3 py-2">Loading...</div>
          ) : (
            tree.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                onFileSelect={onFileSelect}
                contextFiles={contextFiles}
              />
            ))
          )
        ) : sortedContextFiles.length === 0 ? (
          <div className="text-xs text-slate-400 px-3 py-4 text-center">
            No files in context
          </div>
        ) : (
          sortedContextFiles.map((cf) => (
            <button
              key={cf.path}
              onClick={() => onFileSelect(cf.path, cf.name)}
              className="w-full flex items-center gap-2 py-1.5 px-3 text-left text-sm text-blue-500 dark:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-700/50 rounded transition-colors"
            >
              <DocumentIcon className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{cf.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
