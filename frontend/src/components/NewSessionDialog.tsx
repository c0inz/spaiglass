import { useState, useEffect, useRef } from "react";

interface ContextFile {
  name: string;
  filename: string;
  path: string;
  preview: string;
}

interface NewSessionDialogProps {
  projectPath: string;
  onSelect: (contextFile: ContextFile | null) => void;
  onCancel: () => void;
}

export function NewSessionDialog({
  projectPath,
  onSelect,
  onCancel,
}: NewSessionDialogProps) {
  const [contexts, setContexts] = useState<ContextFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ContextFile | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(
          `/api/projects/contexts?path=${encodeURIComponent(projectPath)}`,
        );
        if (res.ok) {
          const data = await res.json();
          const ctxs = data.contexts as ContextFile[];
          setContexts(ctxs);
          // Auto-select if only one
          if (ctxs.length === 1) {
            setSelected(ctxs[0]);
          }
        }
      } catch {
        // Failed to load contexts
      }
      setLoading(false);
    }
    load();
  }, [projectPath]);

  // No contexts found — skip dialog (run once when loading completes)
  const skippedRef = useRef(false);
  useEffect(() => {
    if (!loading && contexts.length === 0 && !skippedRef.current) {
      skippedRef.current = true;
      onSelect(null);
    }
  }, [loading, contexts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-slate-800 rounded-xl p-6 w-96">
          <p className="text-slate-500 dark:text-slate-400 text-sm">
            Loading contexts...
          </p>
        </div>
      </div>
    );
  }

  if (contexts.length === 0) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-[480px] max-h-[70vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">
            Select Session Context
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Choose an agent context for this session
          </p>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-2">
          {contexts.map((ctx) => (
            <button
              key={ctx.filename}
              onClick={() => setSelected(ctx)}
              className={`w-full text-left p-3 rounded-lg border transition-all ${
                selected?.filename === ctx.filename
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                  : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600"
              }`}
            >
              <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
                {ctx.name}
              </div>
              <div className="text-xs text-slate-400 font-mono mt-0.5">
                {ctx.filename}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-2 line-clamp-3">
                {ctx.preview}
              </div>
            </button>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 flex justify-between">
          <button
            onClick={onCancel}
            className="text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
          >
            Cancel
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => onSelect(null)}
              className="text-sm px-3 py-1.5 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
            >
              Skip
            </button>
            <button
              onClick={() => onSelect(selected)}
              disabled={!selected}
              className="text-sm px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Start Session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
