/**
 * SecretsPanel — alphabetized list of named secrets stored on the VM.
 *
 * Each row shows: name, masked value, eyeball (reveal last 5), edit, delete.
 * "Add secret" form at the top. All state lives on the backend via
 * /api/secrets CRUD. Values are never fetched in full — the backend only
 * returns masked representations.
 */

import { useCallback, useEffect, useState } from "react";
import {
  EyeIcon,
  EyeSlashIcon,
  TrashIcon,
  PencilIcon,
  PlusIcon,
  CheckIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";

interface SecretEntry {
  name: string;
  masked: string;
  length: number;
}

export function SecretsPanel() {
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Which secret name is currently "revealed" (showing last 5 via masked field)
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  // Inline edit state
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Add-new state
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");

  const fetchSecrets = useCallback(async () => {
    try {
      const res = await fetch("/api/secrets");
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setSecrets(data.secrets ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load secrets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSecrets();
  }, [fetchSecrets]);

  const handleAdd = async () => {
    const name = newName.trim();
    const value = newValue;
    if (!name || !value) return;
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `${res.status}`);
      }
      setNewName("");
      setNewValue("");
      setAdding(false);
      await fetchSecrets();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add secret");
    }
  };

  const handleUpdate = async (name: string) => {
    const value = editValue;
    if (!value) return;
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setEditing(null);
      setEditValue("");
      await fetchSecrets();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update secret");
    }
  };

  const handleDelete = async (name: string) => {
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setRevealed((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
      await fetchSecrets();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete secret");
    }
  };

  const toggleReveal = (name: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-700">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Secrets
        </h2>
        <button
          type="button"
          onClick={() => {
            setAdding(!adding);
            setNewName("");
            setNewValue("");
          }}
          className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
          title={adding ? "Cancel" : "Add secret"}
        >
          {adding ? (
            <XMarkIcon className="w-4 h-4" />
          ) : (
            <PlusIcon className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Add form */}
      {adding && (
        <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 space-y-1.5">
          <input
            type="text"
            placeholder="Secret name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            autoFocus
          />
          <input
            type="password"
            placeholder="Secret value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            className="w-full text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={!newName.trim() || !newValue}
            className="w-full text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Save
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="px-3 py-1.5 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 underline"
          >
            dismiss
          </button>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-xs text-slate-400">
            Loading...
          </div>
        ) : secrets.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-xs text-slate-400">
            No secrets stored
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {secrets.map((s) => {
              const isRevealed = revealed.has(s.name);
              const isEditing = editing === s.name;
              return (
                <li
                  key={s.name}
                  className="px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate flex-1">
                      {s.name}
                    </span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => toggleReveal(s.name)}
                        className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400"
                        title={isRevealed ? "Hide" : "Show last 5 chars"}
                      >
                        {isRevealed ? (
                          <EyeSlashIcon className="w-3.5 h-3.5" />
                        ) : (
                          <EyeIcon className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (isEditing) {
                            setEditing(null);
                            setEditValue("");
                          } else {
                            setEditing(s.name);
                            setEditValue("");
                          }
                        }}
                        className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400"
                        title="Edit"
                      >
                        <PencilIcon className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(s.name)}
                        className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500"
                        title="Delete"
                      >
                        <TrashIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-400 dark:text-slate-500 truncate">
                    {isRevealed ? s.masked : "*".repeat(Math.min(s.length, 20))}
                  </div>
                  {isEditing && (
                    <div className="mt-1.5 flex gap-1">
                      <input
                        type="password"
                        placeholder="New value"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="flex-1 text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleUpdate(s.name);
                          if (e.key === "Escape") {
                            setEditing(null);
                            setEditValue("");
                          }
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => handleUpdate(s.name)}
                        disabled={!editValue}
                        className="p-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
                        title="Save"
                      >
                        <CheckIcon className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(null);
                          setEditValue("");
                        }}
                        className="p-1 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
                        title="Cancel"
                      >
                        <XMarkIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
