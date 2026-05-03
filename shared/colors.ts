/**
 * Per-project favicon color palette.
 *
 * Saturated mid-tones, chosen to remain visually distinct at favicon
 * scale (16×16, 32×32) in the browser tab strip. The "default" entry is
 * not in the palette — it represents the project's stock SpAIglass dark
 * background, used when no override is set.
 *
 * `fg` overrides the eye-paths color when the background is too light
 * for the default white to read (yellow, amber). Defaults to white
 * elsewhere.
 */

export interface IconColor {
  id: string;
  hex: string;
  label: string;
  /** Foreground color for the eye paths. Defaults to "#fff" when omitted. */
  fg?: string;
}

export const ICON_COLORS: readonly IconColor[] = [
  { id: "violet", hex: "#7c3aed", label: "Violet" },
  { id: "indigo", hex: "#4f46e5", label: "Indigo" },
  { id: "blue", hex: "#2563eb", label: "Blue" },
  { id: "teal", hex: "#0d9488", label: "Teal" },
  { id: "green", hex: "#16a34a", label: "Green" },
  { id: "yellow", hex: "#facc15", label: "Yellow", fg: "#000" },
  { id: "amber", hex: "#d97706", label: "Amber", fg: "#000" },
  { id: "red", hex: "#dc2626", label: "Red" },
  { id: "pink", hex: "#db2777", label: "Pink" },
] as const;

export const DEFAULT_ICON_HEX = "#131318";
export const DEFAULT_ICON_FG = "#fff";

export function iconHexFor(colorId: string | null | undefined): string {
  if (!colorId) return DEFAULT_ICON_HEX;
  const match = ICON_COLORS.find((c) => c.id === colorId);
  return match?.hex ?? DEFAULT_ICON_HEX;
}

export function iconFgFor(colorId: string | null | undefined): string {
  if (!colorId) return DEFAULT_ICON_FG;
  const match = ICON_COLORS.find((c) => c.id === colorId);
  return match?.fg ?? DEFAULT_ICON_FG;
}

/**
 * Build a complete SpAIglass eye favicon SVG with the chosen background
 * and eye-paths color. Identical output for the same input — used by
 * ChatPage's tab effect and SettingsModal's instant-apply on click.
 */
export function buildFaviconSvg(colorId: string | null | undefined): string {
  const bg = iconHexFor(colorId);
  const fg = iconFgFor(colorId);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="12" fill="${bg}"/>` +
    `<g fill="${fg}">` +
    `<path fill-rule="evenodd" d="M2,32C7,15 20,12 32,12C44,12 57,15 62,32C57,49 44,52 32,52C20,52 7,49 2,32ZM9,32C13,21 22,17 32,17C42,17 51,21 55,32C51,43 42,47 32,47C22,47 13,43 9,32Z"/>` +
    `<path d="M21.5,26.5C16,28 9,30 9,32C9,34 16,36 21.5,37.5A11,11 0 0,0 21.5,26.5Z"/>` +
    `<path fill-rule="evenodd" d="M20,32A11,11 0 1,1 42,32A11,11 0 1,1 20,32ZM24,32A7,7 0 1,0 38,32A7,7 0 1,0 24,32Z"/>` +
    `<path d="M31,32L27,28A5,5 0 1,1 26,33Z"/>` +
    `</g></svg>`
  );
}

/**
 * Apply the favicon for a project to the document head. Removes any
 * existing `<link rel="icon">` (some browsers cache by element identity
 * and won't refetch on href mutation) and appends a fresh one. Safe to
 * call from any effect or click handler.
 */
export function applyFavicon(colorId: string | null | undefined): void {
  if (typeof document === "undefined") return;
  const svg = buildFaviconSvg(colorId);
  document.querySelectorAll('link[rel="icon"]').forEach((el) => el.remove());
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = "data:image/svg+xml," + encodeURIComponent(svg);
  document.head.appendChild(link);
}
