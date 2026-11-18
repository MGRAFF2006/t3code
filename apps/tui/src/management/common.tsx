import { createMemo, createSignal, type JSX } from "solid-js";
import type { ProjectId } from "@t3tools/contracts";
import type { FeatureProps } from "../ui/controller.ts";
import { theme } from "../theme/index.ts";

export function destinationGuard(props: FeatureProps) {
  const environmentId = props.state()?.environmentId;
  return () => {
    if (!environmentId || props.state()?.environmentId !== environmentId) {
      throw new Error(
        "The environment changed. Open this action again for the current environment.",
      );
    }
  };
}

export function createProjectScope(props: FeatureProps) {
  const [selection, setSelection] = createSignal<{ environment: string; projectId: ProjectId }>();
  const project = createMemo(() => {
    const state = props.state();
    const selected = selection();
    const id =
      selected?.environment === state?.environmentId
        ? selected?.projectId
        : (state?.thread?.thread.projectId ??
          state?.shell?.threads.find((thread) => thread.id === state.selectedThreadId)?.projectId);
    return state?.shell?.projects.find((entry) => entry.id === id) ?? state?.shell?.projects[0];
  });
  function choose() {
    const environment = props.state()?.environmentId;
    if (!environment) return;
    props.ui.choose(
      "Choose project",
      (props.state()?.shell?.projects ?? []).map((entry) => ({
        title: entry.title,
        description: entry.workspaceRoot,
        run: () => setSelection({ environment, projectId: entry.id }),
      })),
    );
  }
  return { project, choose };
}

export function Action(props: { label: string; onPress: () => void; muted?: boolean }) {
  return (
    <text fg={props.muted ? theme.textMuted : theme.primary} onMouseDown={props.onPress}>
      {props.label}
    </text>
  );
}

export function Section(props: { title: string; children?: JSX.Element }) {
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={theme.text} attributes={1} marginBottom={1}>
        {props.title}
      </text>
      {props.children}
    </box>
  );
}

export function SettingRow(props: {
  label: string;
  value: string;
  description?: string;
  onPress: () => void;
}) {
  return (
    <box flexDirection="column" marginBottom={1} onMouseDown={props.onPress}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.text}>{props.label}</text>
        <text fg={theme.primary}>{props.value}</text>
      </box>
      {props.description ? (
        <text fg={theme.textMuted} wrapMode="word">
          {props.description}
        </text>
      ) : null}
    </box>
  );
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const splitNames = (value: string) =>
  value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
