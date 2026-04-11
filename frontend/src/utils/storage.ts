import type { AppSettings, Theme, EnterBehavior } from "../types/settings";
import { CURRENT_SETTINGS_VERSION } from "../types/settings";

// TODO(spaiglass): rename these localStorage keys to "spaiglass-*" in a future
// release that includes a one-shot migration step. Renaming today would silently
// reset every existing user's preferences, so the upstream `claude-code-webui-*`
// keys are deliberately preserved for now. Tracked alongside Phase 7 attribution
// audit follow-ups.
export const STORAGE_KEYS = {
  // Unified settings key
  SETTINGS: "claude-code-webui-settings",
  // Legacy keys for migration
  THEME: "claude-code-webui-theme",
  ENTER_BEHAVIOR: "claude-code-webui-enter-behavior",
  PERMISSION_MODE: "claude-code-webui-permission-mode",
} as const;

// Type-safe storage utilities
export function getStorageItem<T>(key: string, defaultValue: T): T {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setStorageItem<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Silently fail if localStorage is not available
  }
}

export function removeStorageItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Silently fail if localStorage is not available
  }
}

// Settings-specific utilities
export function getSettings(): AppSettings {
  // Try to load unified settings first
  const unifiedSettings = getStorageItem<AppSettings | null>(
    STORAGE_KEYS.SETTINGS,
    null,
  );

  if (unifiedSettings && unifiedSettings.version === CURRENT_SETTINGS_VERSION) {
    return unifiedSettings;
  }

  // v1 → v2: backfill the phosphor field for pre-70s-theme users so the
  // settings object stays a complete AppSettings and TS isn't lying to us.
  if (unifiedSettings && unifiedSettings.version === 1) {
    const upgraded: AppSettings = {
      theme: unifiedSettings.theme ?? "glass",
      phosphor: "green",
      enterBehavior: unifiedSettings.enterBehavior ?? "send",
      version: CURRENT_SETTINGS_VERSION,
    };
    setSettings(upgraded);
    return upgraded;
  }

  // If no unified settings or unknown version, migrate from legacy format
  return migrateLegacySettings();
}

export function setSettings(settings: AppSettings): void {
  setStorageItem(STORAGE_KEYS.SETTINGS, settings);
}

function migrateLegacySettings(): AppSettings {
  // SpAIglass defaults to "glass" for new installs. Existing users who had a
  // legacy theme key get their previous choice preserved below; only first-time
  // visitors with no localStorage at all land on glass.
  const defaultTheme: Theme = "glass";

  // Load legacy settings
  const legacyTheme = getStorageItem<Theme>(STORAGE_KEYS.THEME, defaultTheme);
  const legacyEnterBehavior = getStorageItem<EnterBehavior>(
    STORAGE_KEYS.ENTER_BEHAVIOR,
    "send",
  );

  // Create migrated settings
  const migratedSettings: AppSettings = {
    theme: legacyTheme,
    phosphor: "green",
    enterBehavior: legacyEnterBehavior,
    version: CURRENT_SETTINGS_VERSION,
  };

  // Save migrated settings
  setSettings(migratedSettings);

  // Clean up legacy storage keys
  removeStorageItem(STORAGE_KEYS.THEME);
  removeStorageItem(STORAGE_KEYS.ENTER_BEHAVIOR);

  return migratedSettings;
}
