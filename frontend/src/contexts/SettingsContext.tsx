import React, { useState, useEffect, useCallback, useMemo } from "react";
import type {
  AppSettings,
  SettingsContextType,
  Theme,
  Phosphor,
} from "../types/settings";
import { getSettings, setSettings } from "../utils/storage";
import { SettingsContext } from "./SettingsContextTypes";

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettingsState] = useState<AppSettings>(() =>
    getSettings(),
  );
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize settings on client side (handles migration automatically)
  useEffect(() => {
    const initialSettings = getSettings();
    setSettingsState(initialSettings);
    setIsInitialized(true);
  }, []);

  // Apply theme changes to document when settings change.
  // Strategy:
  //   - light/dark/glass/plain — toggle .dark / .glass / .plain classes (legacy)
  //   - 70s-light / 70s-dark   — set data-theme attribute + .seventies / .seventies-dark
  //     so scoped CSS in index.css can override Tailwind surfaces
  //   - phosphor color is exposed as data-phosphor (for the 70s --phosphor var)
  useEffect(() => {
    if (!isInitialized) return;

    const root = window.document.documentElement;
    const isSeventies =
      settings.theme === "70s-light" || settings.theme === "70s-dark";
    const isDarkBase =
      settings.theme === "dark" ||
      settings.theme === "glass" ||
      settings.theme === "70s-dark";

    root.classList.toggle("dark", isDarkBase);
    root.classList.toggle("glass", settings.theme === "glass");
    root.classList.toggle("plain", settings.theme === "plain");
    root.classList.toggle("seventies", isSeventies);
    root.classList.toggle("seventies-light", settings.theme === "70s-light");
    root.classList.toggle("seventies-dark", settings.theme === "70s-dark");

    if (isSeventies) {
      root.setAttribute("data-theme", settings.theme);
    } else {
      root.removeAttribute("data-theme");
    }
    root.setAttribute("data-phosphor", settings.phosphor);

    // Save settings to storage
    setSettings(settings);
  }, [settings, isInitialized]);

  const updateSettings = useCallback((updates: Partial<AppSettings>) => {
    setSettingsState((prev) => ({ ...prev, ...updates }));
  }, []);

  const setTheme = useCallback(
    (theme: Theme) => {
      updateSettings({ theme });
    },
    [updateSettings],
  );

  const setPhosphor = useCallback(
    (phosphor: Phosphor) => {
      updateSettings({ phosphor });
    },
    [updateSettings],
  );

  // Kept for backwards compat — cycles through themes
  const toggleTheme = useCallback(() => {
    const order: Theme[] = [
      "light",
      "dark",
      "glass",
      "plain",
      "70s-light",
      "70s-dark",
    ];
    const next = order[(order.indexOf(settings.theme) + 1) % order.length];
    updateSettings({ theme: next });
  }, [settings.theme, updateSettings]);

  const toggleEnterBehavior = useCallback(() => {
    updateSettings({
      enterBehavior: settings.enterBehavior === "send" ? "newline" : "send",
    });
  }, [settings.enterBehavior, updateSettings]);

  const value = useMemo(
    (): SettingsContextType => ({
      settings,
      theme: settings.theme,
      phosphor: settings.phosphor,
      enterBehavior: settings.enterBehavior,
      toggleTheme,
      setTheme,
      setPhosphor,
      toggleEnterBehavior,
      updateSettings,
    }),
    [
      settings,
      toggleTheme,
      setTheme,
      setPhosphor,
      toggleEnterBehavior,
      updateSettings,
    ],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}
