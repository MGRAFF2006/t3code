import { createSignal } from "solid-js";

export type IconMode = "auto" | "nerd" | "plain";
const glyphs = {
  thread: ["\uf075", ""],
  workspace: ["\uf07b", ""],
  terminal: ["\uf120", ">_"],
  file: ["\uf15b", "-"],
  folder: ["\uf07b", "+"],
  image: ["\uf03e", ""],
  browser: ["\uf0ac", ""],
  settings: ["\uf013", ""],
  schedule: ["\uf017", ""],
  pullRequest: ["\ue726", ""],
  issue: ["\uf188", ""],
  pin: ["\uf08d", "◆"],
  git: ["\ue702", "⎇"],
  success: ["\uf00c", "✓"],
  error: ["\uf00d", "×"],
  warning: ["\uf071", "!"],
  running: ["\uf111", "●"],
  waiting: ["\uf252", "◇"],
  woken: ["\uf185", "☀"],
  limited: ["\uf017", "◷"],
  stopped: ["\uf04d", "■"],
  expand: ["\uf0da", "▸"],
  collapse: ["\uf0d7", "▾"],
  add: ["\uf067", "+"],
  commands: ["\uf0c9", "⌘"],
} as const;
export type IconName = keyof typeof glyphs;

export function resolveIconMode(mode: IconMode, terminalName = "", override?: string) {
  const selected =
    override === "auto" || override === "nerd" || override === "plain" ? override : mode;
  if (selected !== "auto") return selected;
  // These terminals ship Nerd Font fallbacks; installed host fonts say nothing about remote clients.
  return /^(?:wezterm|ghostty)$/i.test(terminalName.trim()) ? "nerd" : "plain";
}

const [mode, setMode] = createSignal<"nerd" | "plain">("plain");
export const resolvedIconMode = mode;
export function setIconMode(preference: IconMode, terminalName = "", override?: string) {
  setMode(resolveIconMode(preference, terminalName, override));
}
export function icon(name: IconName) {
  return glyphs[name][mode() === "nerd" ? 0 : 1];
}
export function iconPreview() {
  return (["thread", "folder", "git", "terminal", "settings"] as const)
    .map((name) => `${glyphs[name][0]} ${name}`)
    .join("   ");
}
