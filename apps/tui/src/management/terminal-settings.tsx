import { createSignal, onCleanup } from "solid-js";
import type { TuiPreferencesPatch } from "../runtime/preferences.ts";
import type { FeatureProps } from "../ui/controller.ts";
import { theme } from "../theme/index.ts";
import { Action, Section } from "./common.tsx";

export function createTerminalSettings(props: FeatureProps) {
  const [preferences, setPreferences] = createSignal(props.client.preferences());
  onCleanup(props.client.subscribePreferences(setPreferences));
  const save = (patch: TuiPreferencesPatch) => {
    void props.ui.run(() => props.client.updatePreferences(patch), "Terminal preferences saved.");
  };
  const entries = () => [
    {
      title: "Appearance",
      value: preferences().theme === "dark" ? "Dark" : "Light",
      description: "Use T3 Code's dark or light palette in this terminal.",
      run: () =>
        props.ui.choose("Terminal appearance", [
          { title: "Dark", run: () => save({ theme: "dark" }) },
          { title: "Light", run: () => save({ theme: "light" }) },
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
      title: "Reset terminal preferences",
      description:
        "Restore dark appearance, Enter to send, queued follow-ups, wrapping and unified diffs.",
      run: () =>
        props.ui.confirm(
          "Reset terminal preferences",
          "Only this terminal client's preferences change.",
          async () => {
            await props.client.updatePreferences({
              theme: "dark",
              sendShortcut: "enter",
              followUpMode: "queue",
              wordWrap: true,
              diffView: "unified",
            });
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
