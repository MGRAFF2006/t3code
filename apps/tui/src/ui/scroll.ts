import { theme } from "../theme/index.ts";

export function scrollbarOptions() {
  return {
    showArrows: true,
    arrowOptions: {
      foregroundColor: theme.text,
      arrowChars: { up: "↑", down: "↓", left: "←", right: "→" },
    },
    trackOptions: {
      foregroundColor: theme.textMuted,
      backgroundColor: theme.backgroundElement,
    },
  };
}
