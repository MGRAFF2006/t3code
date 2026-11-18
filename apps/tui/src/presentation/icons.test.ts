import { describe, expect, it } from "vite-plus/test";
import { resolveIconMode } from "./icons.ts";

describe("terminal font compatibility", () => {
  it.each([
    ["auto", "kitty", undefined, "plain"],
    ["auto", "xterm-256color", undefined, "plain"],
    ["auto", "", undefined, "plain"],
    ["auto", "WezTerm", undefined, "nerd"],
    ["auto", "ghostty", undefined, "nerd"],
    ["plain", "WezTerm", undefined, "plain"],
    ["nerd", "kitty", undefined, "nerd"],
    ["nerd", "ghostty", "plain", "plain"],
    ["plain", "kitty", "nerd", "nerd"],
    ["auto", "kitty", "unknown", "plain"],
  ] as const)(
    "resolves %s in %s with override %s as %s",
    (preference, terminal, override, expected) => {
      expect(resolveIconMode(preference, terminal, override)).toBe(expected);
    },
  );
});
