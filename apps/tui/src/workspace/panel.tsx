import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { WS_METHODS } from "@t3tools/contracts";
import { request, subscribe } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import type { FeatureProps } from "../ui/controller.ts";
import { BrowserPanel } from "../presentation/browser-panel.tsx";
import { ChangesPanel } from "./changes.tsx";
import { FilesPanel } from "./files.tsx";
import { GitPanel } from "./git.tsx";
import { DevicesPanel } from "./devices.tsx";
import { TerminalsPanel } from "./terminals.tsx";
import { reduceStatus, workspaceRoot, type WorkspaceStatus } from "./logic.ts";

export type WorkspaceTab = "changes" | "files" | "git" | "browser" | "terminals" | "devices";
const tabs = [
  { id: "changes", title: "Changes" },
  { id: "files", title: "Files" },
  { id: "git", title: "Git" },
  { id: "browser", title: "Browser" },
  { id: "terminals", title: "Terminals" },
  { id: "devices", title: "Devices" },
] as const;

export function WorkspacePanel(
  props: FeatureProps & {
    initialTab?: WorkspaceTab | undefined;
    openPath?: string | undefined;
    openLine?: number | undefined;
    compact?: boolean | undefined;
  },
) {
  const [tab, setTab] = createSignal<WorkspaceTab>(props.initialTab ?? "changes");
  const [status, setStatus] = createSignal<WorkspaceStatus>({ local: null, remote: null });
  const [error, setError] = createSignal("");
  const cwd = createMemo(() => workspaceRoot(props.state()));
  const environmentId = createMemo(() => props.state()?.environmentId);
  const connection = createMemo(() => props.state()?.connection);
  const mutation = createMemo(() => props.state()?.workspaceMutationId);

  createEffect(
    on(
      () => props.initialTab,
      (value) => {
        if (value) setTab(value);
      },
    ),
  );
  createEffect(
    on(
      () => props.openPath,
      (value) => {
        if (value) setTab("files");
      },
    ),
  );

  createEffect(
    on(
      () => [environmentId(), connection(), cwd()] as const,
      ([destination, phase, directory]) => {
        setStatus({ local: null, remote: null });
        setError("");
        if (!destination || !directory || phase !== "connected") return;
        const stop = subscribe(
          props.client,
          WS_METHODS.subscribeVcsStatus,
          { cwd: directory, includeRemote: true },
          (event) => setStatus((previous) => reduceStatus(previous, event)),
          (cause) => setError(cause.message),
        );
        onCleanup(stop);
      },
    ),
  );

  async function refresh() {
    const directory = cwd();
    if (!directory) return;
    const environmentId = props.state()?.environmentId;
    const result = await request(props.client, WS_METHODS.vcsRefreshStatus, { cwd: directory });
    if (props.state()?.environmentId !== environmentId || cwd() !== directory) return;
    setStatus({ local: result, remote: result });
    setError("");
  }

  useKeyboard((event) => {
    if (
      !props.focused ||
      props.ui.modal() ||
      !event.meta ||
      (event.name !== "left" && event.name !== "right")
    )
      return;
    const index = tabs.findIndex((entry) => entry.id === tab());
    setTab(tabs[(index + (event.name === "right" ? 1 : -1) + tabs.length) % tabs.length]!.id);
    event.preventDefault();
    event.stopPropagation();
  });

  return (
    <box
      flexGrow={1}
      minWidth={0}
      minHeight={0}
      backgroundColor={theme.background}
      onMouseDown={props.onFocus}
    >
      <box
        flexDirection="row"
        gap={2}
        paddingX={1}
        paddingY={1}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <Show
          when={!props.compact}
          fallback={
            <text
              fg={theme.primary}
              onMouseDown={() =>
                props.ui.choose(
                  "Workspace view",
                  tabs.map((entry) => ({ title: entry.title, run: () => setTab(entry.id) })),
                )
              }
            >
              {tabs.find((entry) => entry.id === tab())?.title} ▾
            </text>
          }
        >
          <For each={tabs}>
            {(entry) => (
              <text
                fg={tab() === entry.id ? theme.primary : theme.textMuted}
                onMouseDown={() => {
                  props.onFocus();
                  setTab(entry.id);
                }}
              >
                {entry.title}
              </text>
            )}
          </For>
        </Show>
        <text fg={theme.textMuted} flexGrow={1} truncate>
          {status().local?.refName ?? ""}
        </text>
        <text fg={theme.textMuted} onMouseDown={() => void props.ui.run(refresh)}>
          ↻
        </text>
      </box>
      <Show when={error()}>
        <text fg={theme.error} wrapMode="word" paddingX={1}>
          {error()}
        </text>
      </Show>
      <Show when={tab() === "browser"}>
        <BrowserPanel {...props} />
      </Show>
      <ChangesPanel
        {...props}
        cwd={cwd}
        status={status}
        mutation={mutation}
        refresh={refresh}
        visible={tab() === "changes"}
      />
      <FilesPanel
        {...props}
        cwd={cwd}
        status={status}
        mutation={mutation}
        refresh={refresh}
        visible={tab() === "files"}
      />
      <GitPanel
        {...props}
        cwd={cwd}
        status={status}
        mutation={mutation}
        refresh={refresh}
        visible={tab() === "git"}
      />
      <TerminalsPanel
        {...props}
        cwd={cwd}
        status={status}
        mutation={mutation}
        refresh={refresh}
        visible={tab() === "terminals"}
      />
      <DevicesPanel {...props} visible={tab() === "devices"} />
    </box>
  );
}
