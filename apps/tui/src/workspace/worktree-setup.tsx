import {
  WS_METHODS,
  worktreeSetupStageLabel,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { request, subscribe } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { useActiveKeyboard } from "../ui/keyboard.ts";
import type { Choice, FeatureProps } from "../ui/controller.ts";

export function WorktreeSetupStatus(props: FeatureProps & { visible: boolean }) {
  const [setup, setSetup] = createSignal<WorktreeSetupSnapshot | null>(null);
  const [error, setError] = createSignal("");
  const environment = createMemo(() => props.state()?.environmentId);
  const selectedThread = createMemo(() => props.state()?.selectedThreadId);
  const connection = createMemo(() => props.state()?.connection);
  createEffect(() => {
    const destination = environment();
    const threadId = selectedThread();
    setSetup(null);
    setError("");
    if (!props.visible || !destination || !threadId || connection() !== "connected") return;
    const current = () =>
      props.state()?.environmentId === destination && props.state()?.selectedThreadId === threadId;
    const stop = subscribe(
      props.client,
      WS_METHODS.subscribeWorktreeSetup,
      { threadId },
      (snapshot) => {
        if (current()) setSetup(snapshot);
      },
      (cause) => {
        if (current()) setError(cause.message);
      },
    );
    onCleanup(stop);
  });
  function actions(snapshot: WorktreeSetupSnapshot) {
    const destination = props.state()?.environmentId;
    const check = () => {
      if (
        !destination ||
        props.state()?.environmentId !== destination ||
        props.state()?.selectedThreadId !== snapshot.threadId
      )
        throw new Error("The selected thread changed. Open setup actions again.");
    };
    const choices: Choice[] = [
      {
        title: "Setup progress and output",
        run: () =>
          props.ui.text(
            "Worktree setup",
            [
              snapshot.phase,
              snapshot.worktreePath,
              snapshot.branch,
              ...snapshot.stages.map((stage) =>
                [
                  `${worktreeSetupStageLabel(stage.id)}: ${stage.status}${stage.percent === null ? "" : ` (${stage.percent}%)`}`,
                  stage.detail,
                  ...stage.tail,
                ]
                  .filter(Boolean)
                  .join("\n"),
              ),
              snapshot.error,
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
      },
    ];
    if (snapshot.setupScript) {
      const terminalId = snapshot.setupScript.terminalId;
      choices.push({
        title: "Open setup terminal",
        run: () => {
          check();
          props.ui.openTerminal?.(terminalId);
        },
      });
    }
    if (snapshot.phase === "running")
      choices.push({
        title: "Cancel worktree setup…",
        run: () =>
          props.ui.confirm(
            "Cancel worktree setup?",
            "Stops the pending setup. Work already written to the checkout is retained.",
            async () => {
              check();
              const result = await request(props.client, WS_METHODS.worktreeSetupCancel, {
                threadId: snapshot.threadId,
              });
              props.ui.notify(
                result.cancelled ? "Worktree setup cancelled." : "This setup has already finished.",
              );
            },
            "Cancel setup",
          ),
      });
    props.ui.choose("Worktree setup", choices);
  }
  useActiveKeyboard(
    () => props.visible && props.focused && !props.ui.modal(),
    (event) => {
      const value = setup();
      if (!value || event.ctrl || event.meta || event.name !== "u") return;
      event.preventDefault();
      event.stopPropagation();
      actions(value);
    },
  );
  return (
    <box flexShrink={0}>
      <Show when={setup()}>
        {(value) => (
          <text
            fg={value().phase === "failed" ? theme.error : theme.textMuted}
            truncate
            onMouseDown={() => actions(value())}
          >{`Worktree setup: ${value().phase}${value().stages.find((stage) => stage.status === "running")?.detail ? ` · ${value().stages.find((stage) => stage.status === "running")!.detail}` : ""} [U]`}</text>
        )}
      </Show>
      <Show when={error()}>
        <text fg={theme.error} wrapMode="word">
          {error()}
        </text>
      </Show>
    </box>
  );
}
