export type Theme =
  | "light"
  | "dark"
  | "glass"
  | "plain"
  | "70s-light"
  | "70s-dark";
export type Phosphor = "green" | "amber" | "white" | "cyan" | "red";
export type EnterBehavior = "send" | "newline";

export const THEME_OPTIONS: Theme[] = [
  "light",
  "dark",
  "glass",
  "plain",
  "70s-light",
  "70s-dark",
];
export const PHOSPHOR_OPTIONS: Phosphor[] = [
  "green",
  "amber",
  "white",
  "cyan",
  "red",
];

export interface AppSettings {
  theme: Theme;
  phosphor: Phosphor;
  enterBehavior: EnterBehavior;
  version: number;
}

export interface LegacySettings {
  theme?: Theme;
  phosphor?: Phosphor;
  enterBehavior?: EnterBehavior;
}

export interface SettingsContextType {
  settings: AppSettings;
  theme: Theme;
  phosphor: Phosphor;
  enterBehavior: EnterBehavior;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  setPhosphor: (phosphor: Phosphor) => void;
  toggleEnterBehavior: () => void;
  updateSettings: (updates: Partial<AppSettings>) => void;
}

// Default settings
export const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  phosphor: "green",
  enterBehavior: "send",
  version: 2,
};

// Current settings version for migration
export const CURRENT_SETTINGS_VERSION = 2;
