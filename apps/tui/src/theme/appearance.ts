import { CliRenderEvents, type CliRenderer } from "@opentui/core";
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { setTheme, type ThemeMode } from "./index.ts";
import type { TuiPreferences } from "../runtime/preferences.ts";

export function createTerminalAppearance(
  renderer: Pick<CliRenderer, "themeMode" | "on" | "off">,
  preference: Accessor<TuiPreferences["theme"]>,
) {
  const [terminalMode, setTerminalMode] = createSignal(renderer.themeMode);
  const changed = (mode: ThemeMode) => setTerminalMode(mode);
  renderer.on(CliRenderEvents.THEME_MODE, changed);
  onCleanup(() => renderer.off(CliRenderEvents.THEME_MODE, changed));
  // The app palette follows native terminal reports only while System is selected.
  createEffect(() => {
    const selected = preference();
    setTheme(selected === "system" ? (terminalMode() ?? "dark") : selected);
  });
}
