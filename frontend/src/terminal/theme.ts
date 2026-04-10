/**
 * Phase 6.1: Terminal renderer ANSI palette mapping.
 *
 * Maps ANSI 16-color names to tailwind utility classes that respect the
 * existing theme system (light, dark, glass, plain, 70s-light, 70s-dark).
 *
 * The 70s themes pull their accent from the phosphor color picker via the
 * `--phosphor` CSS variable, so we route the "primary" color through that
 * variable when those themes are active. Other themes use plain tailwind.
 *
 * Contract: every component in components.tsx accepts a `color` prop whose
 * value is an `AnsiColor` and resolves it through `colorClass()`.
 */

export type AnsiColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite"
  | "default";

/**
 * Map an ANSI color to a tailwind text-color class.
 *
 * The mapping is intentionally conservative — we use the same family for
 * dark/light modes via tailwind's `dark:` variant so the renderer looks
 * coherent across all six themes without per-theme branching.
 */
export function colorClass(color: AnsiColor = "default"): string {
  switch (color) {
    case "black":
      return "text-slate-900 dark:text-slate-300";
    case "red":
      return "text-red-600 dark:text-red-400";
    case "green":
      return "text-emerald-600 dark:text-emerald-400";
    case "yellow":
      return "text-amber-600 dark:text-amber-400";
    case "blue":
      return "text-blue-600 dark:text-blue-400";
    case "magenta":
      return "text-fuchsia-600 dark:text-fuchsia-400";
    case "cyan":
      return "text-cyan-600 dark:text-cyan-400";
    case "white":
      return "text-slate-700 dark:text-slate-100";
    case "gray":
      return "text-slate-500 dark:text-slate-400";
    case "brightRed":
      return "text-red-500 dark:text-red-300";
    case "brightGreen":
      return "text-emerald-500 dark:text-emerald-300";
    case "brightYellow":
      return "text-amber-500 dark:text-amber-300";
    case "brightBlue":
      return "text-blue-500 dark:text-blue-300";
    case "brightMagenta":
      return "text-fuchsia-500 dark:text-fuchsia-300";
    case "brightCyan":
      return "text-cyan-500 dark:text-cyan-300";
    case "brightWhite":
      return "text-white";
    case "default":
    default:
      return "text-slate-700 dark:text-slate-200";
  }
}

/**
 * Tailwind class for a "card-like" background panel used by tool cards,
 * code blocks, and bordered boxes. Themed via tailwind dark variant only —
 * the 70s themes inherit via the global CSS variables already in index.css.
 */
export const PANEL_BG =
  "bg-slate-50/80 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/70";
