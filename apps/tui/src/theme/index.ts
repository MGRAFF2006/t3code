import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
} from "@t3tools/shared/themePalettes";
import { createSignal } from "solid-js";
import source from "./assets/opencode.json" with { type: "json" };

export type ThemeMode = "dark" | "light";

export function resolveTheme(mode: ThemeMode) {
  const definitions: Record<string, string> = source.defs;
  const syntax = Object.fromEntries(
    Object.entries(source.theme).map(([name, value]) => {
      const color = value[mode];
      return [name, definitions[color] ?? color];
    }),
  ) as { [Name in keyof typeof source.theme]: string };
  const colors = mode === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS;
  return {
    ...syntax,
    primary: colors.accent,
    secondary: colors.focus,
    accent: colors.accent,
    error: colors.error,
    warning: colors.warning,
    text: colors.text,
    textMuted: colors.textMuted,
    background: colors.canvas,
    backgroundPanel: colors.surface,
    backgroundElement: colors.input,
    border: colors.border,
    borderActive: colors.focus,
    borderSubtle: colors.toolbarBorder,
    sidebar: colors.sidebar,
    sidebarSelected: colors.sidebarRowSelected,
    // Match web's index.css status roles and SidebarThreadRow's indigo/fuchsia labels.
    statusWorking: mode === "dark" ? "#51a2ff" : "#1447e6",
    statusApproval: colors.warningForeground,
    statusInput: mode === "dark" ? "#a3b3ff" : "#4f39f6",
    statusRequest: mode === "dark" ? "#f4a8ff" : "#c800de",
    statusDone: mode === "dark" ? "#00d492" : "#007a55",
    statusWoken: colors.warningForeground,
    statusFailed: colors.errorForeground,
    message: colors.messageSurface,
    markdownHeading: colors.text,
    markdownStrong: colors.text,
    markdownLink: colors.accent,
  };
}

const palettes = { dark: resolveTheme("dark"), light: resolveTheme("light") };
const [mode, setMode] = createSignal<ThemeMode>("dark");
export const themeMode = mode;
export function setTheme(value: ThemeMode) {
  setMode(value);
}
export const theme = Object.defineProperties(
  {} as ReturnType<typeof resolveTheme>,
  Object.fromEntries(
    Object.keys(palettes.dark).map((key) => [
      key,
      {
        enumerable: true,
        get: () => palettes[mode()][key as keyof typeof palettes.dark],
      },
    ]),
  ),
);
