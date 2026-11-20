import { createSignal, onCleanup } from "solid-js";
import type { TuiPreferencesPatch } from "../runtime/preferences.ts";
import { DEFAULT_TUI_PREFERENCES } from "../runtime/preferences.ts";
import { editPanelWidths, resetPanelWidths } from "../ui/panel-widths.ts";
import { chooseTerminalAppearance } from "../ui/appearance.ts";
import type { FeatureProps } from "../ui/controller.ts";
import { theme, themeMode } from "../theme/index.ts";
import { Action, Section } from "./common.tsx";
import { iconPreview, resolvedIconMode } from "../presentation/icons.ts";

export function createTerminalSettings(props: FeatureProps) {
  const [preferences, setPreferences] = createSignal(props.client.preferences());
  onCleanup(props.client.subscribePreferences(setPreferences));
  const save = (patch: TuiPreferencesPatch) => {
    void props.ui.run(() => props.client.updatePreferences(patch), "Terminal preferences saved.");
  };
  const entries = () => [
    {
      title: "Appearance",
      value:
        preferences().theme === "system"
          ? `System · ${themeMode() === "dark" ? "Dark" : "Light"}`
          : preferences().theme === "dark"
            ? "Dark"
            : "Light",
      description: "Choose Light or Dark, or follow this terminal with System.",
      run: () => chooseTerminalAppearance(props),
    },
    {
      title: "Icons",
      value: `${preferences().icons === "auto" ? "Auto · " : ""}${resolvedIconMode() === "nerd" ? "Nerd Font" : "Plain"}`,
      description:
        "Decorative icons retain readable labels. Choose Plain if glyphs appear as boxes.",
      run: () =>
        props.ui.choose("Terminal icons", [
          {
            title: "Auto",
            description: "Use bundled icons in Ghostty/WezTerm; plain symbols elsewhere.",
            run: () => save({ icons: "auto" }),
          },
          {
            title: "Nerd Font",
            description: "Your terminal already uses a Nerd Font or symbol fallback.",
            run: () => save({ icons: "nerd" }),
          },
          {
            title: "Plain",
            description: "Use ordinary symbols and text, without patched-font requirements.",
            run: () => save({ icons: "plain" }),
          },
          {
            title: "Font preview and setup",
            run: () =>
              props.ui.choose("Nerd Font setup", [
                {
                  title: "Show sample icons",
                  run: () =>
                    props.ui.text(
                      "Nerd Font preview",
                      `${iconPreview()}\n\nIf these appear as boxes, install a Nerd Font and select it in your terminal's font settings. JetBrainsMono Nerd Font Mono is one option. For remote connections, configure the terminal on your own computer.\n\nThe TUI cannot reliably inspect another terminal's configured font. Plain mode always remains available.\n\nhttps://www.nerdfonts.com/font-downloads`,
                    ),
                },
                {
                  title: "Open font downloads",
                  run: () => props.ui.openBrowser?.("https://www.nerdfonts.com/font-downloads"),
                },
              ]),
          },
        ]),
    },
    {
      title: "Send message",
      value: preferences().sendShortcut === "enter" ? "Enter" : "Ctrl+S",
      description: "Ctrl+S leaves Enter available for a new line in every terminal.",
      run: () =>
        props.ui.choose("Send shortcut", [
          {
            title: "Enter sends · Alt+Enter inserts a new line",
            run: () => save({ sendShortcut: "enter" }),
          },
          {
            title: "Ctrl+S sends · Enter inserts a new line",
            run: () => save({ sendShortcut: "ctrl-s" }),
          },
        ]),
    },
    {
      title: "Time format",
      value: preferences().timestampFormat,
      description: "Hover over a message or tool-call header to see its local time.",
      run: () =>
        props.ui.choose("Time format", [
          { title: "System locale", run: () => save({ timestampFormat: "locale" }) },
          { title: "12-hour", run: () => save({ timestampFormat: "12-hour" }) },
          { title: "24-hour", run: () => save({ timestampFormat: "24-hour" }) },
        ]),
    },
    {
      title: "Follow-up messages",
      value: preferences().followUpMode === "queue" ? "Queue" : "Steer",
      description:
        "Choose the default delivery while the agent is working. Unsupported steering falls back to the queue.",
      run: () =>
        props.ui.choose("Follow-up delivery", [
          { title: "Queue after the current turn", run: () => save({ followUpMode: "queue" }) },
          {
            title: "Steer the current turn when supported",
            run: () => save({ followUpMode: "steer" }),
          },
        ]),
    },
    {
      title: "Wrap file contents",
      value: preferences().wordWrap ? "On" : "Off",
      description: "Wrap long lines in file previews and review patches.",
      run: () => save({ wordWrap: !preferences().wordWrap }),
    },
    {
      title: "Default diff layout",
      value: preferences().diffView === "unified" ? "Unified" : "Split",
      description: "Choose one column or side-by-side changes. Each review can override this.",
      run: () =>
        props.ui.choose("Diff layout", [
          { title: "Unified", run: () => save({ diffView: "unified" }) },
          { title: "Split", run: () => save({ diffView: "split" }) },
        ]),
    },
    {
      title: "Panel widths",
      value: `${preferences().sidebarWidth} left · ${preferences().workspaceWidth ?? "auto"} right`,
      description:
        "Resize both sidebars in terminal columns. Drag their dividers or enter exact widths.",
      run: () => editPanelWidths(props),
    },
    {
      title: "Reset panel widths",
      description: "Restore the default left width and automatic right width.",
      run: () => resetPanelWidths(props),
    },
    {
      title: "Reset terminal preferences",
      description:
        "Restore System appearance, automatic icons, system time format, Enter to send, queued follow-ups, wrapping, unified diffs and default panel widths.",
      run: () =>
        props.ui.confirm(
          "Reset terminal preferences",
          "Only this terminal client's preferences change.",
          async () => {
            await props.client.updatePreferences(DEFAULT_TUI_PREFERENCES);
          },
          "Reset preferences",
        ),
    },
  ];
  function Details() {
    return (
      <Section title="Terminal preferences">
        <text fg={theme.textMuted} wrapMode="word">
          These preferences are saved on this computer and apply to every connected environment.
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          The terminal controls its font, opacity and graphics capabilities. Browser and desktop
          appearance settings stay separate.
        </text>
        <Action label="Change appearance" onPress={() => entries()[0]!.run()} />
      </Section>
    );
  }
  return { entries, Details };
}
