/**
 * Per-project favicon color palette.
 *
 * Eight saturated mid-tones, chosen to remain visually distinct at favicon
 * scale (16×16, 32×32) in the browser tab strip. The "default" entry is
 * not in the palette — it represents the project's stock SpAIglass dark
 * background, used when no override is set.
 */

export interface IconColor {
  id: string;
  hex: string;
  label: string;
}

export const ICON_COLORS: readonly IconColor[] = [
  { id: "violet", hex: "#7c3aed", label: "Violet" },
  { id: "indigo", hex: "#4f46e5", label: "Indigo" },
  { id: "blue", hex: "#2563eb", label: "Blue" },
  { id: "teal", hex: "#0d9488", label: "Teal" },
  { id: "green", hex: "#16a34a", label: "Green" },
  { id: "amber", hex: "#d97706", label: "Amber" },
  { id: "red", hex: "#dc2626", label: "Red" },
  { id: "pink", hex: "#db2777", label: "Pink" },
] as const;

export const DEFAULT_ICON_HEX = "#131318";

export function iconHexFor(colorId: string | null | undefined): string {
  if (!colorId) return DEFAULT_ICON_HEX;
  const match = ICON_COLORS.find((c) => c.id === colorId);
  return match?.hex ?? DEFAULT_ICON_HEX;
}
