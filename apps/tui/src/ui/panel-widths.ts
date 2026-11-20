import { DEFAULT_TUI_PREFERENCES } from "../runtime/preferences.ts";
import type { FeatureProps } from "./controller.ts";

export function editPanelWidths(props: Pick<FeatureProps, "client" | "ui">) {
  const preferences = props.client.preferences();
  props.ui.form({
    title: "Panel widths",
    description:
      "Widths are saved in terminal columns. Small windows temporarily constrain them. Use auto for the right panel to follow the window size.",
    fields: [
      {
        name: "left",
        label: "Left sidebar (22–1000 columns)",
        type: "number",
        value: String(preferences.sidebarWidth),
        required: true,
      },
      {
        name: "right",
        label: "Right panel (42–1000 columns or auto)",
        value: preferences.workspaceWidth === null ? "auto" : String(preferences.workspaceWidth),
        required: true,
      },
    ],
    submitLabel: "Save widths",
    onSubmit: async ({ left = "", right = "" }) => {
      const sidebarWidth = Number(left);
      const workspaceWidth = right.trim().toLowerCase() === "auto" ? null : Number(right);
      if (!Number.isInteger(sidebarWidth) || sidebarWidth < 22 || sidebarWidth > 1000)
        throw new Error("Enter a whole number from 22 to 1000 for the left sidebar.");
      if (
        workspaceWidth !== null &&
        (!Number.isInteger(workspaceWidth) || workspaceWidth < 42 || workspaceWidth > 1000)
      )
        throw new Error("Enter auto or a whole number from 42 to 1000 for the right panel.");
      await props.client.updatePreferences({ sidebarWidth, workspaceWidth });
    },
  });
}

export function resetPanelWidths(props: Pick<FeatureProps, "client" | "ui">) {
  void props.ui.run(
    () =>
      props.client.updatePreferences({
        sidebarWidth: DEFAULT_TUI_PREFERENCES.sidebarWidth,
        workspaceWidth: DEFAULT_TUI_PREFERENCES.workspaceWidth,
      }),
    "Panel widths reset.",
  );
}
