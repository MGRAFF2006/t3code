import type { KeyEvent } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createEffect, onCleanup, type Accessor } from "solid-js";

export function useActiveKeyboard(enabled: Accessor<boolean>, callback: (event: KeyEvent) => void) {
  const { keyInput } = useRenderer();
  const listener = (event: KeyEvent) => {
    if (enabled()) callback(event);
  };
  createEffect(() => {
    if (!enabled()) return;
    keyInput.on("keypress", listener);
    onCleanup(() => keyInput.off("keypress", listener));
  });
}
