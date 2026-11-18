import type { CliRenderer, TerminalCapabilities } from "@opentui/core";
import { createSignal, onCleanup } from "solid-js";

export function createTerminalCapabilities(
  renderer: Pick<CliRenderer, "capabilities" | "on" | "off">,
) {
  const [capabilities, setCapabilities] = createSignal(renderer.capabilities);
  renderer.on("capabilities", setCapabilities);
  onCleanup(() => renderer.off("capabilities", setCapabilities));
  return capabilities;
}

export function terminalCapabilitiesReport(capabilities: TerminalCapabilities | null): string {
  if (!capabilities)
    return "Terminal detection is still running. Open this panel again after the terminal replies.";
  const yes = (value: boolean) => (value ? "Supported" : "Not detected");
  return [
    `Terminal: ${capabilities.terminal.name || "Unknown"}${capabilities.terminal.version ? ` ${capabilities.terminal.version}` : ""}`,
    `Enhanced keyboard: ${yes(capabilities.kitty_keyboard)}`,
    `Kitty graphics: ${yes(capabilities.kitty_graphics)}`,
    `Sixel graphics: ${yes(capabilities.sixel)}`,
    `Image protocol: ${capabilities.image_protocol ?? "auto"}`,
    `Hyperlinks: ${yes(capabilities.hyperlinks)}`,
    `Terminal clipboard (OSC52): ${capabilities.osc52_support}`,
    `Synchronized output: ${yes(capabilities.sync)}`,
    `True color: ${yes(capabilities.rgb)}`,
    `Bracketed paste: ${yes(capabilities.bracketed_paste)}`,
    `Multiplexer: ${capabilities.multiplexer}`,
    "",
    "Images use automatic terminal detection. To override at launch:",
    "OPENTUI_IMAGE_PROTOCOL=auto|kitty|sixel|blocks",
    "OPENTUI_GRAPHICS=1 enables graphics detection; =0 disables it.",
    "",
    "Copy uses the terminal's OSC52 clipboard. Enable clipboard access in the terminal or multiplexer if needed; otherwise select text and use the terminal's own Copy command.",
    "Enter sends and Shift+Enter inserts a line break. Ctrl+Enter delivery choices require enhanced keyboard support; the composer actions work with the mouse in other terminals.",
  ].join("\n");
}

export function copyTerminalText(
  renderer: Pick<CliRenderer, "copyToClipboardOSC52">,
  text: string,
): { attempted: boolean; message: string } {
  if (!text) return { attempted: false, message: "There is no text to copy." };
  if (!renderer.copyToClipboardOSC52(text))
    return {
      attempted: false,
      message:
        "The terminal could not accept the copy request. Enable OSC52 clipboard access, or select text and use the terminal's Copy command.",
    };
  return { attempted: true, message: "Copy sent to your terminal clipboard." };
}

export function terminalHyperlink(
  value: string,
  capabilities: TerminalCapabilities | null,
): string | null {
  if (!capabilities?.hyperlinks) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
