import { describe, expect, it } from "vite-plus/test";
import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";
import { editableKeybinding } from "./keybindings.logic.ts";

describe("server keybinding editing", () => {
  it.each([
    {
      key: "ctrl++",
      command: "preview.zoomIn" as const,
      when: "chatFocused && !(terminalFocused || dialogOpen)",
    },
    {
      key: "mod+shift+space",
      command: "commandPalette.toggle" as const,
      when: "chatFocused || terminalFocused && !dialogOpen",
    },
  ])("preserves conditional matching and literal keys when replacing $key", (rule) => {
    const resolved = compileResolvedKeybindingRule(rule);
    if (!resolved) throw new Error("Invalid fixture keybinding.");
    const editable = editableKeybinding(resolved);
    expect(compileResolvedKeybindingRule(editable)).toEqual(resolved);
  });
});
