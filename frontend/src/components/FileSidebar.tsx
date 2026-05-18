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
import { QueueTab, type UserPromptEntry } from "./QueueTab";
// SecretsPanel hidden for now — see research/secrets_roadmap.md
// import { SecretsPanel } from "./SecretsPanel";

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
  activeRole?: string;
  /** Path of file currently open in the editor; highlighted in the tree
   *  until another file is chosen or the editor closes. */
  selectedPath?: string | null;
  /** Queue tab config. When provided, the "Q" tab is rendered between
   *  Context and Help. */
  queueWorkingDirectory?: string;
  queueRoleFile?: string;
  onInjectQueueText?: (text: string) => void;
  /** History data for the Queue tab. */
  recentUserPrompts?: UserPromptEntry[];
  allUserPrompts?: UserPromptEntry[];
  onJumpToMessage?: (rowKey: string) => void;
}

function TreeNode({
  entry,
  depth,
  onFileSelect,
  contextFiles,
  selectedPath,
}: {
  entry: TreeEntry;
  depth: number;
  onFileSelect: (path: string, name: string) => void;
  contextFiles?: Set<string>;
  selectedPath?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const isEditable = /\.(md|json|txt)$/i.test(entry.name);
  const isContext = contextFiles?.has(entry.path);
  const isSelected = !entry.isDir && selectedPath === entry.path;

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
        className={`w-full flex items-center gap-1.5 py-1 px-2 text-left text-sm rounded transition-colors ${
          isSelected
            ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
            : isContext
              ? "text-blue-500 dark:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-700/50"
              : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/50"
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
              selectedPath={selectedPath}
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
  activeRole,
  selectedPath,
  queueWorkingDirectory,
  queueRoleFile,
  onInjectQueueText,
  recentUserPrompts = [],
  allUserPrompts = [],
  onJumpToMessage,
}: FileSidebarProps) {
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const queueEnabled = Boolean(
    queueWorkingDirectory && queueRoleFile && onInjectQueueText,
  );
  const [activeTab, setActiveTab] = useState<
    "tree" | "context" | "queue" | "help"
  >("tree");

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
      {/* Tabs.
          `onMouseDown={preventDefault}` keeps focus in the chat textarea when
          a tab is clicked — otherwise the button steals focus and the
          blinking cursor jumps out of the input (feedback 2026-04-24).
          onClick still fires because preventDefault on mousedown only
          suppresses the focus side-effect, not the click. */}
      <div className="flex border-b border-slate-200 dark:border-slate-700">
        <button
          onMouseDown={(e) => e.preventDefault()}
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
          onMouseDown={(e) => e.preventDefault()}
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
        {queueEnabled && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setActiveTab("queue")}
            title="Cue"
            className={`flex-1 text-xs font-medium py-2 transition-colors ${
              activeTab === "queue"
                ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
                : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
            }`}
          >
            Cue
          </button>
        )}
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setActiveTab("help")}
          className={`flex-1 text-xs font-medium py-2 transition-colors ${
            activeTab === "help"
              ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
              : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
          }`}
        >
          Help
        </button>
        {/* Keys tab hidden — see research/secrets_roadmap.md */}
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={loadTree}
          className="px-2 py-2 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          title="Refresh"
        >
          <ArrowPathIcon className="w-3 h-3 text-slate-400" />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto py-1">
        {activeTab === "help" && (
          <HelpPanel
            stats={
              sessionStats || {
                model: "",
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                totalCost: 0,
                turns: 0,
                durationMs: 0,
                sessionId: "",
              }
            }
            slashCommands={slashCommands || []}
            projectPath={projectPath}
            activeRole={activeRole}
          />
        )}
        {activeTab === "tree" &&
          (loading && tree.length === 0 ? (
            <div className="text-xs text-slate-400 px-3 py-2">Loading...</div>
          ) : (
            tree.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                onFileSelect={onFileSelect}
                contextFiles={contextFiles}
                selectedPath={selectedPath}
              />
            ))
          ))}
        {activeTab === "context" &&
          (sortedContextFiles.length === 0 ? (
            <div className="text-xs text-slate-400 px-3 py-4 text-center">
              No files in context
            </div>
          ) : (
            sortedContextFiles.map((cf) => {
              const isSelected = selectedPath === cf.path;
              return (
                <button
                  key={cf.path}
                  onClick={() => onFileSelect(cf.path, cf.name)}
                  className={`w-full flex items-center gap-2 py-1.5 px-3 text-left text-sm rounded transition-colors ${
                    isSelected
                      ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                      : "text-blue-500 dark:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-700/50"
                  }`}
                >
                  <DocumentIcon className="w-4 h-4 flex-shrink-0" />
                  <span className="truncate">{cf.name}</span>
                </button>
              );
            })
          ))}
        {activeTab === "queue" &&
          queueEnabled &&
          queueWorkingDirectory &&
          queueRoleFile &&
          onInjectQueueText && (
            <QueueTab
              workingDirectory={queueWorkingDirectory}
              roleFile={queueRoleFile}
              onInjectText={onInjectQueueText}
              recentUserPrompts={recentUserPrompts}
              allUserPrompts={allUserPrompts}
              onJumpToMessage={onJumpToMessage ?? (() => {})}
            />
          )}
      </div>
    </div>
  );
}
