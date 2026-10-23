import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { palettes, type Palette } from "../theme/tokens";

export type ThemePreference = "system" | "light" | "dark";

export interface Settings {
  theme: ThemePreference;
  /** Rustige modus: muted palette, no decorative extras. */
  calm: boolean;
  largeText: boolean;
}

const DEFAULTS: Settings = { theme: "system", calm: false, largeText: false };
const STORAGE_KEY = "breinhap.settings.v1";

interface SettingsValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  palette: Palette;
  isDark: boolean;
  /** Multiplier for font sizes. */
  textScale: number;
  /** Missions finished today (in memory for now; progress sync comes later). */
  doneToday: ReadonlySet<string>;
  markDone: (missionId: string) => void;
}

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [doneToday, setDoneToday] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw) setSettings({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) });
      })
      .catch(() => {
        // Unreadable settings are not worth an error screen: keep the defaults.
      });
  }, []);

  const value = useMemo<SettingsValue>(() => {
    const isDark = settings.theme === "dark" || (settings.theme === "system" && system === "dark");
    const palette = settings.calm
      ? isDark
        ? palettes.calmDark
        : palettes.calmLight
      : isDark
        ? palettes.dark
        : palettes.light;
    return {
      settings,
      update: (patch) =>
        setSettings((current) => {
          const next = { ...current, ...patch };
          AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
          return next;
        }),
      palette,
      isDark,
      textScale: settings.largeText ? 1.2 : 1,
      doneToday,
      markDone: (id) => setDoneToday((current) => new Set(current).add(id)),
    };
  }, [settings, system, doneToday]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings must be used inside SettingsProvider");
  return value;
}
