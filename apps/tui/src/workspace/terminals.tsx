import { WS_METHODS, type TerminalSummary } from "@t3tools/contracts";
import { applyTerminalMetadataStreamEvent } from "@t3tools/client-runtime/state/terminal";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { request, subscribe } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { useActiveKeyboard } from "../ui/keyboard.ts";
import type { WorkspaceContext } from "./types.ts";

export function TerminalsPanel(props: WorkspaceContext & { visible: boolean }) {
  const [terminals, setTerminals] = createSignal<readonly TerminalSummary[]>([]);
  const [failure, setFailure] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const environment = createMemo(() => props.state()?.environmentId);
  const thread = createMemo(() => props.state()?.selectedThreadId);
  createEffect(() => {
    const destination = environment();
    const id = thread();
    if (!props.visible || !destination || !id) return;
    setTerminals([]);
    setFailure("");
    setSelected(0);
    const stop = subscribe(
      props.client,
      WS_METHODS.subscribeTerminalMetadata,
      {},
      (event) => {
        if (environment() !== destination || thread() !== id) return;
        setTerminals((values) =>
          applyTerminalMetadataStreamEvent(values, event).filter((value) => value.threadId === id),
        );
      },
      (error) => setFailure(error.message),
    );
    onCleanup(stop);
  });
  function destination() {
    const environmentId = environment();
    const threadId = thread();
    const cwd = props.cwd();
    if (!environmentId || !threadId || !cwd)
      throw new Error("Select a thread before opening its terminals.");
    return {
      threadId,
      cwd,
      check: () => {
        if (environment() !== environmentId || thread() !== threadId || props.cwd() !== cwd)
          throw new Error("The workspace changed. Open terminal actions again.");
      },
    };
  }
  function create() {
    const target = destination();
    props.ui.form({
      title: "New terminal",
      fields: [{ name: "name", label: "Terminal name", required: true }],
      submitLabel: "Open terminal",
      onSubmit: async ({ name = "" }) => {
        target.check();
        const terminalId = name.trim();
        await request(props.client, WS_METHODS.terminalOpen, {
          threadId: target.threadId,
          terminalId,
          cwd: target.cwd,
        });
        target.check();
        props.ui.openTerminal?.(terminalId);
      },
    });
  }
  function actions(value = terminals()[Math.max(0, Math.min(selected(), terminals().length - 1))]) {
    if (!value) return;
    const target = destination();
    const session = { threadId: target.threadId, terminalId: value.terminalId };
    props.ui.choose(value.label || value.terminalId, [
      {
        title: value.status === "running" ? "Attach terminal" : "Open terminal",
        run: () => {
          target.check();
          props.ui.openTerminal?.(value.terminalId);
        },
      },
      {
        title: "Clear terminal history",
        run: () =>
          props.ui.confirm(
            "Clear terminal history?",
            "Clears stored output for this terminal. Its running process stays active.",
            async () => {
              target.check();
              await request(props.client, WS_METHODS.terminalClear, session);
            },
            "Clear history",
          ),
      },
      {
        title: "Close terminal",
        description: value.hasRunningSubprocess
          ? "A command is still running in this terminal."
          : undefined,
        run: () =>
          props.ui.confirm(
            "Close terminal?",
            value.hasRunningSubprocess
              ? "This stops its shell and the command running inside it."
              : "This stops the terminal's shell; its history is kept.",
            async () => {
              target.check();
              await request(props.client, WS_METHODS.terminalClose, session);
            },
            "Close terminal",
          ),
      },
      {
        title: "Delete terminal and history",
        run: () =>
          props.ui.confirm(
            "Delete terminal and history?",
            "Stops this shell and permanently removes its saved output.",
            async () => {
              target.check();
              await request(props.client, WS_METHODS.terminalClose, {
                ...session,
                deleteHistory: true,
              });
            },
            "Delete terminal",
          ),
      },
    ]);
  }
  useActiveKeyboard(
    () => props.visible && props.focused && !props.ui.modal(),
    (event) => {
      if (event.ctrl || event.meta) return;
      if (event.name === "up" || event.name === "down")
        setSelected((value) =>
          Math.max(0, Math.min(terminals().length - 1, value + (event.name === "up" ? -1 : 1))),
        );
      else if (event.name === "return") actions();
      else if (event.name === "n") {
        void props.ui.run(async () => create());
      } else return;
      event.preventDefault();
      event.stopPropagation();
    },
  );
  return (
    <box visible={props.visible} flexGrow={1} minHeight={0} paddingX={1}>
      <box height={2} flexDirection="row" alignItems="center">
        <text fg={theme.text} flexGrow={1}>
          Terminals
        </text>
        <text
          selectable={false}
          fg={theme.primary}
          onMouseDown={() => void props.ui.run(async () => create())}
        >
          New [N]
        </text>
      </box>
      <Show when={failure()}>
        <text fg={theme.error} wrapMode="word">
          {failure()}
        </text>
      </Show>
      <scrollbox flexGrow={1} minHeight={0}>
        <For each={terminals()}>
          {(value, index) => (
            <box
              paddingY={1}
              backgroundColor={selected() === index() ? theme.backgroundElement : theme.background}
              onMouseDown={() => {
                props.onFocus();
                setSelected(index());
                actions(value);
              }}
            >
              <text selectable={false} fg={theme.text}>
                {value.label || value.terminalId}
              </text>
              <text selectable={false} fg={theme.textMuted}>
                {value.status}
                {value.hasRunningSubprocess ? " · Command running" : ""}
              </text>
              <text selectable={false} fg={theme.textMuted} truncate>
                {value.cwd}
              </text>
            </box>
          )}
        </For>
        <Show when={!terminals().length}>
          <text fg={theme.textMuted} wrapMode="word">
            {thread()
              ? "No terminals in this thread. Open a terminal with N or Ctrl+T."
              : "Select a thread to manage its terminals."}
          </text>
        </Show>
      </scrollbox>
      <text fg={theme.textMuted}>↑↓ select · Enter actions · N new · Ctrl+T quick attach</text>
    </box>
  );
}
