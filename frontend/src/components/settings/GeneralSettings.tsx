import { useEffect, useState } from "react";
import {
  SunIcon,
  MoonIcon,
  SparklesIcon,
  BriefcaseIcon,
  ComputerDesktopIcon,
  CommandLineIcon,
  KeyIcon,
} from "@heroicons/react/24/outline";
import { useSettings } from "../../hooks/useSettings";
import type { Theme, Phosphor } from "../../types/settings";

const THEME_CHOICES: {
  id: Theme;
  label: string;
  description: string;
  Icon: typeof SunIcon;
  iconColor: string;
}[] = [
  {
    id: "light",
    label: "Light",
    description: "Bright, default",
    Icon: SunIcon,
    iconColor: "text-yellow-500",
  },
  {
    id: "dark",
    label: "Dark",
    description: "Classic dark mode",
    Icon: MoonIcon,
    iconColor: "text-blue-400",
  },
  {
    id: "glass",
    label: "Glass",
    description: "Glassmorphism, cyan/purple accents",
    Icon: SparklesIcon,
    iconColor: "text-cyan-400",
  },
  {
    id: "plain",
    label: "Plain",
    description: "Boring corporate, won't offend",
    Icon: BriefcaseIcon,
    iconColor: "text-slate-500",
  },
  {
    id: "70s-light",
    label: "70s Light",
    description: "Parchment + monospace",
    Icon: ComputerDesktopIcon,
    iconColor: "text-amber-700",
  },
  {
    id: "70s-dark",
    label: "70s Dark",
    description: "CRT phosphor terminal",
    Icon: ComputerDesktopIcon,
    iconColor: "text-green-400",
  },
];

const PHOSPHOR_CHOICES: { id: Phosphor; label: string; color: string }[] = [
  { id: "green", label: "Green", color: "#33ff33" },
  { id: "amber", label: "Amber", color: "#ffb000" },
  { id: "white", label: "White", color: "#f0f0f0" },
  { id: "cyan", label: "Cyan", color: "#00ffff" },
  { id: "red", label: "Red", color: "#ff5050" },
];

type KeyStatus =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "set"; masked: string };

export function GeneralSettings() {
  const {
    theme,
    phosphor,
    enterBehavior,
    setTheme,
    setPhosphor,
    toggleEnterBehavior,
  } = useSettings();

  const isSeventies = theme === "70s-light" || theme === "70s-dark";

  // Phase 4: BYO Anthropic API key — host-local, never proxied through relay.
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({ state: "loading" });
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyMessage, setKeyMessage] = useState<string | null>(null);

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
          setKeyStatus({ state: "set", masked: data.masked ?? "sk-ant-…" });
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
        setKeyStatus({ state: "set", masked: data.masked ?? "sk-ant-…" });
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
    <div className="space-y-6">
      {/* Live region for screen reader announcements */}
      <div aria-live="polite" className="sr-only" id="settings-announcements">
        {`${theme} theme enabled`}.{" "}
        {enterBehavior === "send"
          ? "Enter key sends messages"
          : "Enter key creates newlines"}
        .
      </div>

      <div>
        <h3 className="text-lg font-medium text-slate-800 dark:text-slate-100 mb-4">
          General Settings
        </h3>

        {/* Theme Setting */}
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block">
              Theme
            </label>
            <div className="grid grid-cols-2 gap-2">
              {THEME_CHOICES.map(
                ({ id, label, description, Icon, iconColor }) => {
                  const active = theme === id;
                  return (
                    <button
                      key={id}
                      onClick={() => setTheme(id)}
                      className={
                        "flex items-center gap-3 px-4 py-3 border rounded-lg text-left transition-all duration-150 " +
                        (active
                          ? "bg-blue-50 dark:bg-blue-900/30 border-blue-400 dark:border-blue-500 ring-2 ring-blue-300 dark:ring-blue-600"
                          : "bg-slate-50 dark:bg-slate-700/50 border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700")
                      }
                      role="radio"
                      aria-checked={active}
                      aria-label={`${label} theme. ${description}`}
                    >
                      <Icon className={`w-5 h-5 ${iconColor}`} />
                      <div>
                        <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                          {label}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {description}
                        </div>
                      </div>
                    </button>
                  );
                },
              )}
            </div>
          </div>

          {/* Phosphor color picker — only relevant for 70s themes */}
          {isSeventies && (
            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block">
                Phosphor Color
              </label>
              <div className="flex gap-2 flex-wrap">
                {PHOSPHOR_CHOICES.map(({ id, label, color }) => {
                  const active = phosphor === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setPhosphor(id)}
                      className={
                        "flex items-center gap-2 px-3 py-2 border rounded-lg transition-all duration-150 " +
                        (active
                          ? "ring-2 ring-blue-300 dark:ring-blue-600 border-blue-400 dark:border-blue-500"
                          : "border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700")
                      }
                      role="radio"
                      aria-checked={active}
                      aria-label={`${label} phosphor`}
                      title={label}
                    >
                      <span
                        className="block w-5 h-5 rounded-full border border-slate-300 dark:border-slate-600"
                        style={{ backgroundColor: color }}
                      />
                      <span className="text-xs font-mono text-slate-700 dark:text-slate-300">
                        {label.toLowerCase()}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Sets the phosphor tint for text, borders, and accents in 70s
                themes.
              </div>
            </div>
          )}

          {/* Enter Behavior Setting */}
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
            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Controls how the Enter key behaves when typing messages in the
              chat input.
            </div>
          </div>

          {/* Phase 4: BYO Anthropic API key */}
          <div>
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block">
              Anthropic API Key
            </label>
            <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 rounded-lg">
              <KeyIcon className="w-5 h-5 text-slate-600 dark:text-slate-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                {keyStatus.state === "loading" && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Checking…
                  </div>
                )}
                {keyStatus.state === "missing" && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    No key set — Claude uses your subscription auth.
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
                className="flex-1 px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-600 disabled:opacity-50"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={saveKey}
                disabled={busy || !keyInput.trim().startsWith("sk-ant-")}
                className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? "Saving…" : "Save Key"}
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
              validated against api.anthropic.com before saving and never
              proxied through the relay.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
