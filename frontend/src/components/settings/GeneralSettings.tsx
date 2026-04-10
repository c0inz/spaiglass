import {
  SunIcon,
  MoonIcon,
  SparklesIcon,
  BriefcaseIcon,
  ComputerDesktopIcon,
  CommandLineIcon,
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
        </div>
      </div>
    </div>
  );
}
