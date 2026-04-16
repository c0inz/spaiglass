import { useEffect, useState } from "react";
import {
  CommandLineIcon,
  KeyIcon,
  BookmarkIcon,
} from "@heroicons/react/24/outline";
import { useSettings } from "../../hooks/useSettings";

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

export function GeneralSettings() {
  const { enterBehavior, toggleEnterBehavior } = useSettings();

  const [keyStatus, setKeyStatus] = useState<KeyStatus>({ state: "loading" });
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyMessage, setKeyMessage] = useState<string | null>(null);

  // Browser tab title editor — only surfaced when running inside the relay
  // (i.e. window.__SG is set). In standalone VM mode there's no connector to
  // edit, so the whole section stays hidden.
  const isRelay =
    typeof window !== "undefined" &&
    !!(window as Window & { __SG?: unknown }).__SG;
  const [self, setSelf] = useState<SelfConnector | null>(null);
  const [titleInput, setTitleInput] = useState("");
  const [titleBusy, setTitleBusy] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [titleMessage, setTitleMessage] = useState<string | null>(null);
  // Capture the relay's server-rendered <title> before React touches it.
  // This is the auto-computed compact name (e.g. "Spglss-LdDv") that the
  // relay set at page-serve time — we show it as the placeholder/default so
  // the user knows what the tab actually says when no custom name is set.
  const [relayTitle] = useState(() => document.title);

  useEffect(() => {
    if (!isRelay) return;
    let cancelled = false;
    fetch("/api/__relay/self")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SelfConnector | null) => {
        if (cancelled || !data) return;
        setSelf(data);
        setTitleInput(data.customDisplayName ?? "");
        // Only sync document.title if a custom name is set. When empty,
        // the relay already server-rendered the correct compact title —
        // overwriting it with the raw connector name was the original bug.
        if (data.customDisplayName) {
          document.title = data.customDisplayName;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isRelay]);

  async function saveTitle() {
    setTitleBusy(true);
    setTitleError(null);
    setTitleMessage(null);
    try {
      const next = titleInput.trim();
      const res = await fetch("/api/__relay/self/display-name", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: next || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTitleError(data?.error ?? `Failed (${res.status})`);
        return;
      }
      // Optimistically update local state + the live document title so the
      // user sees the change immediately without a hard refresh.
      setSelf((prev) =>
        prev
          ? {
              ...prev,
              customDisplayName: next || null,
              displayName: next || prev.name,
            }
          : prev,
      );
      if (next) {
        document.title = next;
      } else {
        // Restore the relay's auto-computed title (compact project:role).
        document.title = relayTitle || self?.name || "SpAIglass";
      }
      setTitleMessage(
        next ? "Tab title saved." : "Tab title cleared — using default.",
      );
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : String(err));
    } finally {
      setTitleBusy(false);
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
      {/* Browser Tab Title — relay-only. Owner of this connector can set a
          custom label that shows up in the browser tab + fleet agent switcher
          entries. Clearing the field falls back to the connector name. */}
      {isRelay && self && self.role === "owner" && (
        <div>
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block">
            Browser Tab Title
          </label>
          <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 rounded-lg">
            <BookmarkIcon className="w-5 h-5 text-slate-600 dark:text-slate-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Current tab title:{" "}
                <span className="font-mono text-slate-700 dark:text-slate-300">
                  {self.customDisplayName || relayTitle || self.name}
                </span>
              </div>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              type="text"
              value={titleInput}
              onChange={(e) => {
                setTitleInput(e.target.value);
                // Live preview: update browser tab as user types.
                // Fall back to the relay's computed title, not the raw
                // connector name.
                document.title =
                  e.target.value.trim() || relayTitle || self?.name || "SpAIglass";
              }}
              placeholder={relayTitle || self.name}
              disabled={titleBusy}
              maxLength={100}
              className="flex-1 px-3 py-2 text-sm bg-white/80 dark:bg-slate-800/80 border border-slate-300 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent backdrop-blur-sm shadow-sm disabled:opacity-50 transition-all duration-200"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={saveTitle}
              disabled={
                titleBusy ||
                titleInput.trim() === (self.customDisplayName ?? "")
              }
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {titleBusy ? "Saving\u2026" : "Save"}
            </button>
          </div>
          {titleError && (
            <div className="mt-2 text-xs text-red-600 dark:text-red-400">
              {titleError}
            </div>
          )}
          {titleMessage && !titleError && (
            <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
              {titleMessage}
            </div>
          )}
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Sets the browser tab title for this agent and the label used in the
            agent switcher. Clear the field to revert to the default.
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
