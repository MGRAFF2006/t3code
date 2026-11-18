import { useKeyboard } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { quickActions, serviceCategory } from "./actions.ts";
import { services, type TuiService } from "../rpc/catalog.ts";
import type { FeatureProps } from "../ui/controller.ts";
import { theme } from "../theme/index.ts";

export function AdvancedPanel(props: FeatureProps) {
  const [title, setTitle] = createSignal("Service inspector");
  const [output, setOutput] = createSignal(
    "Choose a service to inspect its typed request. This developer view exposes operations that do not yet have dedicated terminal controls.",
  );
  let stop: (() => void) | undefined;
  onCleanup(() => stop?.());
  function edit(service: TuiService, payload: unknown, label = service.method) {
    const destination = props.state()?.environmentId;
    props.ui.form({
      title: label,
      description:
        "Advanced request editor. Operations execute on the selected environment. Review every value before applying.",
      fields: [
        {
          name: "payload",
          label: "Request JSON",
          type: "multiline",
          value: JSON.stringify(payload, null, 2),
          required: true,
        },
      ],
      submitLabel: service.streaming ? "Subscribe" : "Run request",
      onSubmit: async (values) => {
        if (props.state()?.environmentId !== destination)
          throw new Error("The environment changed. Reopen this request.");
        const input: unknown = JSON.parse(values.payload!);
        stop?.();
        stop = undefined;
        setTitle(label);
        if (service.streaming) {
          setOutput("Waiting for results…");
          let received = false;
          stop = props.client.stream(
            service.method,
            input,
            (value) => {
              const line = typeof value === "string" ? value : JSON.stringify(value, null, 2);
              setOutput((previous) => {
                const next = received ? `${previous}\n${line}` : line;
                received = true;
                return next.length > 200_000
                  ? `[Earlier output omitted]\n${next.slice(-180_000)}`
                  : next;
              });
            },
            (error) => props.ui.notify(error.message, true),
          );
        } else {
          const result = await props.client.invoke(service.method, input);
          setOutput(
            typeof result === "string" ? result : (JSON.stringify(result, null, 2) ?? "Done"),
          );
        }
      },
    });
  }
  function pick() {
    const current = props.state();
    const projectId = current?.thread?.thread.projectId;
    const project = current?.shell?.projects.find((entry) => entry.id === projectId);
    const cwd =
      current?.thread?.thread.worktreePath ?? project?.workspaceRoot ?? current?.config?.cwd;
    props.ui.choose("Advanced services", [
      ...quickActions.map((action) => ({
        title: action.title,
        category: action.category,
        description: action.description,
        run: () => {
          const service = services.find((entry) => entry.method === action.method);
          if (service)
            edit(
              service,
              action.payload({
                ...(cwd ? { cwd } : {}),
                ...(current?.selectedThreadId ? { threadId: current.selectedThreadId } : {}),
                ...(projectId ? { projectId } : {}),
                ...(current?.thread
                  ? { modelSelection: current.thread.thread.modelSelection }
                  : {}),
              }),
              action.title,
            );
        },
      })),
      ...services.map((service) => ({
        title: service.method,
        category: serviceCategory(service.method),
        run: () => {
          const draft = (text: string) => {
            const input: Record<string, unknown> = JSON.parse(text);
            if ("threadId" in input) input.threadId ||= current?.selectedThreadId ?? "";
            if ("cwd" in input) input.cwd ||= cwd ?? "";
            if ("projectId" in input) input.projectId ||= projectId ?? "";
            if ("commandId" in input) input.commandId ||= SecureRandom.uuidV4Unsafe();
            return input;
          };
          if (service.variants.length > 1)
            props.ui.choose(
              service.method,
              service.variants.map((variant) => ({
                title: variant.name,
                run: () => edit(service, draft(variant.draft)),
              })),
            );
          else edit(service, draft(service.defaultDraft));
        },
      })),
    ]);
  }
  useKeyboard((event) => {
    if (!props.focused || props.ui.modal() || event.name !== "return") return;
    pick();
    event.preventDefault();
    event.stopPropagation();
  });
  return (
    <box flexGrow={1} minHeight={0} padding={1} onMouseDown={props.onFocus}>
      <text fg={theme.text}>{title()}</text>
      <text fg={theme.primary} marginTop={1} onMouseDown={pick}>
        Choose service… Enter
      </text>
      <text
        fg={theme.textMuted}
        marginBottom={1}
        onMouseDown={() => {
          stop?.();
          stop = undefined;
        }}
      >
        Stop subscription
      </text>
      <scrollbox flexGrow={1} minHeight={0}>
        <text fg={theme.text} wrapMode="word">
          {output()}
        </text>
      </scrollbox>
    </box>
  );
}
