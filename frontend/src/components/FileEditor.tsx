import { useState, useEffect, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";

interface FileEditorProps {
  filePath: string;
  fileName: string;
  onClose: () => void;
}

function getLanguage(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md":
      return "markdown";
    case "json":
      return "json";
    case "txt":
      return "plaintext";
    default:
      return "plaintext";
  }
}

export function FileEditor({ filePath, fileName, onClose }: FileEditorProps) {
  const [content, setContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<unknown>(null);

  const language = getLanguage(fileName);
  const isEditable = /\.(md|json|txt)$/i.test(fileName);

  const loadFile = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/files/read?path=${encodeURIComponent(filePath)}`,
      );
      if (res.ok) {
        const data = await res.json();
        setContent(data.content);
        setOriginalContent(data.content);
        setIsDirty(false);
        setError(null);
      } else {
        setError("Failed to load file");
      }
    } catch {
      setError("Failed to load file");
    }
  }, [filePath]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, content }),
      });
      if (res.ok) {
        setOriginalContent(content);
        setIsDirty(false);
      } else {
        setError("Failed to save file");
      }
    } catch {
      setError("Failed to save file");
    }
    setSaving(false);
  }, [filePath, content]);

  // Ctrl+S / Cmd+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty) handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isDirty, handleSave]);

  const handleEditorChange = (value: string | undefined) => {
    const newContent = value || "";
    setContent(newContent);
    setIsDirty(newContent !== originalContent);
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-slate-900">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {fileName}
          </span>
          {isDirty && (
            <span
              className="w-2 h-2 rounded-full bg-orange-400"
              title="Unsaved changes"
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isEditable && (
            <span className="text-xs text-slate-400">Read-only</span>
          )}
          {isEditable && (
            <button
              onClick={handleSave}
              disabled={!isDirty || saving}
              className="text-xs px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="Close file"
            className="text-xs px-2 py-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
          >
            Close
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs">
          {error}
        </div>
      )}

      {/* Full-width editor */}
      <div className="flex-1">
        <Editor
          height="100%"
          language={language}
          value={content}
          onChange={handleEditorChange}
          onMount={(editor) => {
            editorRef.current = editor;
          }}
          theme="vs-dark"
          options={{
            readOnly: !isEditable,
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: "on",
            wordWrap: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
          }}
        />
      </div>
    </div>
  );
}
