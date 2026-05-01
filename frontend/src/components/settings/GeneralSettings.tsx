import { useEffect, useState } from "react";
import {
  CommandLineIcon,
  KeyIcon,
  BookmarkIcon,
  TagIcon,
  WindowIcon,
} from "@heroicons/react/24/outline";
import { useSettings } from "../../hooks/useSettings";
import { getProjectDisplayName as getLocalDisplayName } from "../../utils/projectDisplayName";

type KeyStatus =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "set"; masked: string };

// Shape of GET /vm/:slug/api/__relay/self. Only populated when the frontend
// runs inside the relay-served SPA (window.__SG present); the fetch is
// intercepted there by the relay and doesn't reach the VM backend.
interface SelfConnector {
  id: string;
  name: string;
  displayName: string;
  customDisplayName: string | null;
  role: "owner" | "editor" | "viewer";
  ownerLogin: string;
}

export function GeneralSettings({ projectPath }: { projectPath?: string }) {
  const { enterBehavior, toggleEnterBehavior } = useSettings();

  const projectBasename = projectPath
    ? projectPath.replace(/\/+$/, "").split(/[\\/]/).filter(Boolean).pop() || null
    : null;

  // ── Project Directory Display Name ────────────────────────────────────
  const [projDisplayInput, setProjDisplayInput] = useState("");
  const [projDisplaySaved, setProjDisplaySaved] = useState<string | null>(null);
  const [projDisplayMessage, setProjDisplayMessage] = useState<string | null>(null);
  const [projDisplayBusy, setProjDisplayBusy] = useState(false);

  useEffect(() => {
    if (!projectBasename) return;
    let cancelled = false;
    fetch("/api/settings/project-display-names")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const apiName = data?.displayNames?.[projectBasename] || null;
        const localName = getLocalDisplayName(projectBasename);
        const resolved = apiName || localName || projectBasename;
        setProjDisplayInput(resolved);
        setProjDisplaySaved(apiName || localName || null);
      })
      .catch(() => {
        if (!cancelled) setProjDisplayInput(projectBasename);
      });
    return () => { cancelled = true; };
  }, [projectBasename]);

  // ── Project Directory Tab Name ─────────────────────────────────────────
  const [tabNameInput, setTabNameInput] = useState("");
  const [tabNameSaved, setTabNameSaved] = useState<string | null>(null);
  const [tabNameMessage, setTabNameMessage] = useState<string | null>(null);
  const [tabNameBusy, setTabNameBusy] = useState(false);

  useEffect(() => {
    if (!projectBasename) return;
    let cancelled = false;
    fetch("/api/settings/project-directory-tab-names")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const apiName = data?.tabNames?.[projectBasename] || null;
        setTabNameInput(apiName || "");
        setTabNameSaved(apiName);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectBasename]);

  const [keyStatus, setKeyStatus] = useState<KeyStatus>({ state: "loading" });
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyMessage, setKeyMessage] = useState<string | null>(null);

  // ── Server Display Name ────────────────────────────────────────────────
  const isRelay =
    typeof window !== "undefined" &&
    !!(window as Window & { __SG?: unknown }).__SG;
  const [self, setSelf] = useState<SelfConnector | null>(null);
  const [serverNameInput, setServerNameInput] = useState("");
  const [serverNameBusy, setServerNameBusy] = useState(false);
  const [serverNameError, setServerNameError] = useState<string | null>(null);
  const [serverNameMessage, setServerNameMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isRelay) return;
    let cancelled = false;
    fetch("/api/__relay/self")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SelfConnector | null) => {
        if (cancelled || !data) return;
        setSelf(data);
        setServerNameInput(data.customDisplayName ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isRelay]);

  async function saveServerName() {
    setServerNameBusy(true);
    setServerNameError(null);
    setServerNameMessage(null);
    try {
      const next = serverNameInput.trim();
      const res = await fetch("/api/__relay/self/display-name", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: next || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setServerNameError(data?.error ?? `Failed (${res.status})`);
        return;
      }
      setSelf((prev) =>
        prev
          ? {
              ...prev,
              customDisplayName: next || null,
              displayName: next || prev.name,
            }
          : prev,
      );
      setServerNameMessage(
        next
          ? "Server Display Name saved."
          : "Server Display Name cleared — using slug.",
      );
    } catch (err) {
      setServerNameError(err instanceof Error ? err.message : String(err));
    } finally {
      setServerNameBusy(false);
    }
  }

  async function saveTabName() {
    if (!projectBasename) return;
    setTabNameBusy(true);
    setTabNameMessage(null);
    try {
      const next = tabNameInput.trim();
      const tabName = next || null;
      const res = await fetch("/api/settings/project-directory-tab-name", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: projectBasename, tabName }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setTabNameMessage(data?.error ?? `Failed (${res.status})`);
        return;
      }
      setTabNameSaved(tabName);
      // Live-update the browser tab so the user sees the change immediately.
      const effective =
        tabName ||
        projDisplaySaved ||
        projectBasename;
      document.title = effective;
      setTabNameMessage(
        tabName
          ? "Tab Name saved."
          : "Tab Name cleared — using Project Directory Display Name.",
      );
    } catch (err) {
      setTabNameMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setTabNameBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/anthropic-key")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (!data) {
          setKeyStatus({ state: "missing" });
          return;
        }
        if (data.hasKey) {
          setKeyStatus({
            state: "set",
            masked: data.masked ?? "sk-ant-\u2026",
          });
        } else {
          setKeyStatus({ state: "missing" });
        }
      })
      .catch(() => {
        if (!cancelled) setKeyStatus({ state: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveKey() {
    setBusy(true);
    setKeyError(null);
    setKeyMessage(null);
    try {
      const res = await fetch("/api/settings/anthropic-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: keyInput.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setKeyError(data?.error ?? `Failed (${res.status})`);
        return;
      }
      if (data.hasKey) {
        setKeyStatus({ state: "set", masked: data.masked ?? "sk-ant-\u2026" });
        setKeyMessage("Key validated and saved.");
      } else {
        setKeyStatus({ state: "missing" });
      }
      setKeyInput("");
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearKey() {
    setBusy(true);
    setKeyError(null);
    setKeyMessage(null);
    try {
      const res = await fetch("/api/settings/anthropic-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setKeyError(data?.error ?? `Failed (${res.status})`);
        return;
      }
      setKeyStatus({ state: "missing" });
      setKeyMessage("Key cleared. Falling back to default Claude auth.");
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Server Display Name — relay-only. Cosmetic label shown for this
          connector in the page header, Server dropdown, last-used buttons,
          and mobile picker. */}
      {isRelay && self && self.role === "owner" && (
        <div>
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block">
            Server Display Name
          </label>
          <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 rounded-lg">
            <BookmarkIcon className="w-5 h-5 text-slate-600 dark:text-slate-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                URL slug:{" "}
                <span className="font-mono text-slate-700 dark:text-slate-300">{self.name}</span>
                {" · "}
                Shown as:{" "}
                <span className="font-mono text-slate-700 dark:text-slate-300">
                  {self.customDisplayName || self.name}
                </span>
              </div>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              type="text"
              value={serverNameInput}
              onChange={(e) => setServerNameInput(e.target.value)}
              placeholder={self.name}
              disabled={serverNameBusy}
              maxLength={100}
              className="flex-1 px-3 py-2 text-sm bg-white/80 dark:bg-slate-800/80 border border-slate-300 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent backdrop-blur-sm shadow-sm disabled:opacity-50 transition-all duration-200"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={saveServerName}
              disabled={
                serverNameBusy ||
                serverNameInput.trim() === (self.customDisplayName ?? "")
              }
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {serverNameBusy ? "Saving\u2026" : "Save"}
            </button>
          </div>
          {serverNameError && (
            <div className="mt-2 text-xs text-red-600 dark:text-red-400">
              {serverNameError}
            </div>
          )}
          {serverNameMessage && !serverNameError && (
            <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
              {serverNameMessage}
            </div>
          )}
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Top-left server name on the chat page, Server dropdown entries,
            "last used" quick-switch buttons, and the mobile Agent Picker.
            The URL slug (<code>{self.name}</code>) is immutable — only the
            label changes. Clear to fall back to the slug.
          </div>
        </div>
      )}

      {/* Project Directory Display Name — per-directory cosmetic label */}
      {projectBasename && (
        <div>
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block">
            Project Directory Display Name
          </label>
          <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 rounded-lg">
            <TagIcon className="w-5 h-5 text-slate-600 dark:text-slate-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Directory:{" "}
                <span className="font-mono text-slate-700 dark:text-slate-300">
                  {projectBasename}
                </span>
              </div>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              type="text"
              value={projDisplayInput}
              onChange={(e) => setProjDisplayInput(e.target.value)}
              placeholder={projectBasename}
              maxLength={100}
              className="flex-1 px-3 py-2 text-sm bg-white/80 dark:bg-slate-800/80 border border-slate-300 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent backdrop-blur-sm shadow-sm transition-all duration-200"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={async () => {
                if (!projectBasename) return;
                setProjDisplayBusy(true);
                setProjDisplayMessage(null);
                const next = projDisplayInput.trim();
                const displayName = (!next || next === projectBasename) ? null : next;
                try {
                  const res = await fetch("/api/settings/project-display-name", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ project: projectBasename, displayName }),
                  });
                  if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    setProjDisplayMessage(data?.error ?? `Failed (${res.status})`);
                    return;
                  }
                  setProjDisplaySaved(displayName);
                  if (!displayName) {
                    setProjDisplayInput(projectBasename);
                    setProjDisplayMessage("Display Name cleared — using directory name.");
                  } else {
                    setProjDisplayMessage("Display Name saved.");
                  }
                } catch (err) {
                  setProjDisplayMessage(err instanceof Error ? err.message : String(err));
                } finally {
                  setProjDisplayBusy(false);
                }
              }}
              disabled={
                projDisplayBusy ||
                projDisplayInput.trim() ===
                  (projDisplaySaved ?? projectBasename)
              }
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {projDisplayBusy ? "Saving\u2026" : "Save"}
            </button>
          </div>
          {projDisplayMessage && (
            <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
              {projDisplayMessage}
            </div>
          )}
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Top-left project label on the chat page, Directory dropdown
            entries, "last used" buttons, and the mobile Agent Picker. The
            real working directory path is not renamed — only the label.
            Clear to revert to the directory name.
          </div>
        </div>
      )}

      {/* Project Directory Tab Name — per-directory browser tab title */}
      {projectBasename && (
        <div>
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block">
            Project Directory Tab Name
          </label>
          <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 rounded-lg">
            <WindowIcon className="w-5 h-5 text-slate-600 dark:text-slate-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Browser tab currently shows:{" "}
                <span className="font-mono text-slate-700 dark:text-slate-300">
                  {tabNameSaved || projDisplaySaved || projectBasename}
                </span>
              </div>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              type="text"
              value={tabNameInput}
              onChange={(e) => setTabNameInput(e.target.value)}
              placeholder={projDisplaySaved || projectBasename}
              disabled={tabNameBusy}
              maxLength={100}
              className="flex-1 px-3 py-2 text-sm bg-white/80 dark:bg-slate-800/80 border border-slate-300 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent backdrop-blur-sm shadow-sm disabled:opacity-50 transition-all duration-200"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={saveTabName}
              disabled={
                tabNameBusy ||
                tabNameInput.trim() === (tabNameSaved ?? "")
              }
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {tabNameBusy ? "Saving\u2026" : "Save"}
            </button>
          </div>
          {tabNameMessage && (
            <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
              {tabNameMessage}
            </div>
          )}
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Browser tab title only (also used when you bookmark the page).
            Falls back to Project Directory Display Name, then to the
            directory name. Nothing else in-app uses this string.
          </div>
        </div>
      )}

      {/* Enter Behavior */}
      <div>
        <label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block">
          Enter Key Behavior
        </label>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleEnterBehavior}
            className="flex items-center gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200 text-left flex-1"
            role="switch"
            aria-checked={enterBehavior === "send"}
            aria-label={`Enter key behavior toggle. Currently set to ${enterBehavior === "send" ? "send message" : "newline"}. Click to switch behavior.`}
          >
            <CommandLineIcon className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            <div>
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                {enterBehavior === "send"
                  ? "Enter to Send"
                  : "Enter for Newline"}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {enterBehavior === "send"
                  ? "Enter sends message, Shift+Enter for newline"
                  : "Enter adds newline, Shift+Enter sends message"}
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* Anthropic API Key */}
      <div>
        <label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block">
          Anthropic API Key
        </label>
        <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 rounded-lg">
          <KeyIcon className="w-5 h-5 text-slate-600 dark:text-slate-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            {keyStatus.state === "loading" && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Checking...
              </div>
            )}
            {keyStatus.state === "missing" && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                No key set &mdash; Claude uses your subscription auth.
              </div>
            )}
            {keyStatus.state === "set" && (
              <div>
                <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                  Key configured
                </div>
                <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
                  {keyStatus.masked}
                </div>
              </div>
            )}
          </div>
          {keyStatus.state === "set" && (
            <button
              type="button"
              onClick={clearKey}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-600 disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>

        <div className="mt-3 flex gap-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="sk-ant-..."
            disabled={busy}
            className="flex-1 px-3 py-2 text-sm font-mono bg-white/80 dark:bg-slate-800/80 border border-slate-300 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent backdrop-blur-sm shadow-sm disabled:opacity-50 transition-all duration-200"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={saveKey}
            disabled={busy || !keyInput.trim().startsWith("sk-ant-")}
            className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Saving\u2026" : "Save Key"}
          </button>
        </div>

        {keyError && (
          <div className="mt-2 text-xs text-red-600 dark:text-red-400">
            {keyError}
          </div>
        )}
        {keyMessage && !keyError && (
          <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
            {keyMessage}
          </div>
        )}

        <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Stored on the host's <code>.env</code> with mode 600. The key is
          validated against api.anthropic.com before saving and never proxied
          through the relay.
        </div>
      </div>
    </div>
  );
}
