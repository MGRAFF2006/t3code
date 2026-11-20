import type { TuiPreferences } from "../runtime/preferences.ts";
import type { FeatureProps } from "./controller.ts";

export function chooseTerminalAppearance(props: Pick<FeatureProps, "client" | "ui">) {
  const save = (theme: TuiPreferences["theme"]) => {
    void props.ui.run(
      () => props.client.updatePreferences({ theme }),
      "Terminal appearance saved.",
    );
  };
  props.ui.choose("Terminal appearance", [
    {
      title: "System",
      description: "Follow this terminal's theme reports. Use Dark when detection is unavailable.",
      run: () => save("system"),
    },
    {
      title: "Light",
      description: "Keep the TUI light regardless of the terminal or OS appearance.",
      run: () => save("light"),
    },
    {
      title: "Dark",
      description: "Keep the TUI dark regardless of the terminal or OS appearance.",
      run: () => save("dark"),
    },
  ]);
}
