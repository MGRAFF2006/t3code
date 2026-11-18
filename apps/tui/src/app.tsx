import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import {
  DesktopSshEnvironmentTargetSchema,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { resolvePendingUserInputAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { turnItemOutputText } from "@t3tools/client-runtime/work-log/item-detail";

import { quickActions, serviceCategory, type TuiActionContext } from "./features/actions.ts";
import { Form, SecretForm, type FormProps } from "./forms.tsx";
import type { TuiClient, TuiSnapshot } from "./runtime/client.ts";
import { services, type TuiService } from "./rpc/catalog.ts";
import { theme } from "./theme/index.ts";
import { Transcript } from "./transcript.tsx";
import { openTerminal } from "./terminal/session.ts";
import { DialogSelect, type DialogSelectOption } from "./ui/dialog-select.tsx";

interface Choice {
  title: string;
  description?: string;
  category?: string;
  run: () => void;
}
type Modal =
  | { kind: "picker"; title: string; options: DialogSelectOption<() => void>[] }
  | { kind: "form"; props: FormProps }
  | { kind: "secret"; title: string; description: string; resolve: (value: string | null) => void };
interface Output {
  title: string;
  text: string;
  stop?: () => void;
}
const decodeSshTarget = Schema.decodeUnknownSync(DesktopSshEnvironmentTargetSchema);
const decodeItemDetail = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2GetTurnItemResult));
const draftKey = (state: TuiSnapshot | null) =>
  `${state?.environmentId ?? ""}/${state?.selectedThreadId ?? ""}`;

export function App(props: { client: TuiClient | null; demo?: boolean; onExit: () => void }) {
  const dimensions = useTerminalDimensions();
  const renderer = useRenderer();
  const [snapshot, setSnapshot] = createSignal<TuiSnapshot | null>(
    props.client?.snapshot() ?? null,
  );
  const [modal, setModal] = createSignal<Modal | null>(null);
  const [output, setOutput] = createSignal<Output | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let composer: TextareaRenderable | undefined;
  let history: ScrollBoxRenderable | undefined;
  let passwordPending: ((value: string | null) => void) | undefined;
  props.client?.setPasswordPrompt(
    (request) =>
      new Promise((resolve) => {
        passwordPending?.(null);
        passwordPending = resolve;
        setModal({
          kind: "secret",
          title: "SSH authentication",
          description: `${request.username ? `${request.username}@` : ""}${request.destination}\n${request.prompt}`,
          resolve,
        });
      }),
  );
  const drafts = new Map<string, string>();
  const unsubscribe = props.client?.subscribe((state) => {
    const previous = draftKey(snapshot());
    const next = draftKey(state);
    if (previous !== next) {
      drafts.set(previous, composer?.plainText ?? draft());
      const text = drafts.get(next) ?? "";
      composer?.setText(text);
      setDraft(text);
    }
    setSnapshot(state);
  });
  onCleanup(() => {
    unsubscribe?.();
    output()?.stop?.();
    passwordPending?.(null);
  });

  const projection = () => snapshot()?.thread;
  const selectedProject = createMemo(() => {
    const state = snapshot();
    const projectId =
      state?.thread?.thread.projectId ??
      state?.shell?.threads.find((thread) => thread.id === state.selectedThreadId)?.projectId;
    return state?.shell?.projects.find((project) => project.id === projectId);
  });
  const context = (): TuiActionContext => {
    const state = snapshot();
    const cwd =
      state?.thread?.thread.worktreePath ?? selectedProject()?.workspaceRoot ?? state?.config?.cwd;
    return {
      ...(cwd ? { cwd } : {}),
      ...(state?.selectedThreadId ? { threadId: state.selectedThreadId } : {}),
      ...(selectedProject() ? { projectId: selectedProject()!.id } : {}),
      ...(state?.thread ? { modelSelection: state.thread.thread.modelSelection } : {}),
    };
  };
  const pending = createMemo(
    () => projection()?.runtimeRequests.filter((request) => request.status === "pending") ?? [],
  );

  function client() {
    if (!props.client)
      throw new Error(
        "Demo data is offline. Restart with --pair URL or --connect URL to use a T3 environment.",
      );
    return props.client;
  }
  async function run(operation: () => Promise<unknown>, success?: string) {
    if (busy()) return;
    setBusy(true);
    setFailure(false);
    try {
      await operation();
      if (success) setNotice(success);
    } catch (error) {
      setFailure(true);
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  function pick(title: string, choices: readonly Choice[]) {
    setModal({
      kind: "picker",
      title,
      options: choices.map(({ run: value, ...choice }) => ({ ...choice, value })),
    });
  }
  function form(formProps: Omit<FormProps, "onCancel">) {
    setModal({ kind: "form", props: { ...formProps, onCancel: () => setModal(null) } });
  }
  function showOutput(title: string, value: unknown) {
    output()?.stop?.();
    setOutput({
      title,
      text: typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "Done"),
    });
  }
  function closeOutput() {
    output()?.stop?.();
    setOutput(null);
  }
  function environments() {
    void run(async () => {
      const available = await client().environments();
      pick(
        "Environments",
        available
          .map<Choice>((environment) => ({
            title: environment.label,
            description: environment.environmentId,
            run: () => {
              void run(async () => {
                closeOutput();
                await client().selectEnvironment(environment.environmentId);
              });
            },
          }))
          .concat([
            {
              title: "Pair another environment…",
              description: "Use a fresh pairing URL from the destination server.",
              run: connect,
            },
          ]),
      );
    });
  }
  function connect() {
    form({
      title: "Pair environment",
      description:
        "Paste a fresh pairing URL from your T3 server. It is exchanged and saved privately on this computer.",
      initialValue: "",
      onSubmit: async (pairingUrl) => {
        await client().connect(pairingUrl.trim());
        closeOutput();
        setModal(null);
      },
    });
  }
  function ssh() {
    form({
      title: "Connect with SSH",
      description:
        "Use an SSH config alias or host. T3 can install and start its remote server on this host when needed.",
      initialValue: JSON.stringify(
        { alias: "", hostname: "", username: null, port: null },
        null,
        2,
      ),
      multiline: true,
      onSubmit: async (text) => {
        const target = decodeSshTarget(JSON.parse(text));
        if (!target.alias.trim() && !target.hostname.trim())
          throw new Error("Enter an SSH alias or hostname.");
        try {
          await client().addSsh(target);
        } catch (error) {
          setFailure(true);
          setNotice(error instanceof Error ? error.message : String(error));
          throw error;
        }
        setModal(null);
        closeOutput();
      },
    });
  }
  function login() {
    void run(async () => {
      await client().login((prompt) =>
        showOutput(
          "Sign in to T3 Connect",
          `Open on any device:\n${prompt.verificationUriComplete ?? prompt.verificationUri}\n\nCode: ${prompt.userCode}\n\nWaiting for authorization. Ctrl+Q cancels and exits.`,
        ),
      );
      closeOutput();
      setNotice("Signed in. Choose Switch environment to see your hosts.");
    });
  }
  function threads() {
    const state = snapshot();
    pick(
      "Threads",
      (state?.shell?.threads ?? []).map((thread) => ({
        title: thread.title,
        category:
          state?.shell?.projects.find((project) => project.id === thread.projectId)?.title ??
          "Thread",
        description: `${thread.status} · ${thread.modelSelection.model}${thread.branch ? ` · ${thread.branch}` : ""}`,
        run: () => {
          closeOutput();
          client().selectThread(thread.id);
        },
      })),
    );
  }
  function newThread() {
    pick(
      "New thread in project",
      (snapshot()?.shell?.projects ?? [])
        .map((project) => ({
          title: project.title,
          description: project.workspaceRoot,
          run: () => {
            void run(async () => {
              await client().createThread(project.id);
              closeOutput();
            });
          },
        }))
        .concat([
          {
            title: "Add a project…",
            description: "Use a workspace path on the connected environment.",
            run: newProject,
          },
        ]),
    );
  }
  function newProject() {
    form({
      title: "Add project",
      description: "Workspace path on the connected T3 environment.",
      initialValue: context().cwd ?? "",
      onSubmit: async (path) => {
        if (!path.trim()) throw new Error("Enter a workspace path.");
        const id = await client().createProject(path.trim());
        await client().createThread(id);
        setModal(null);
        closeOutput();
      },
    });
  }
  function models() {
    pick(
      "Choose model",
      (snapshot()?.config?.providers ?? []).flatMap((provider) =>
        provider.enabled && provider.installed
          ? provider.models.map((model) => ({
              title: model.name,
              category: provider.displayName ?? provider.driver,
              description: model.slug,
              run: () => {
                void run(
                  () => client().setModel({ instanceId: provider.instanceId, model: model.slug }),
                  "Model updated",
                );
              },
            }))
          : [],
      ),
    );
  }
  function openItem(entry: OrchestrationV2ProjectedTurnItem) {
    void run(async () => {
      const result = decodeItemDetail(
        await client().invoke(ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
          threadId: entry.sourceThreadId,
          itemId: entry.sourceItemId,
        }),
      );
      if (!result.item) throw new Error("This item is no longer available.");
      showOutput(
        result.item.title ?? "Item details",
        turnItemOutputText(result.item) ?? result.item,
      );
    });
  }
  function itemDetails() {
    pick(
      "Item details and full output",
      (projection()?.visibleTurnItems ?? []).map((entry) => ({
        title: entry.item.title ?? entry.item.type.replaceAll("_", " "),
        description: entry.item.status,
        run: () => openItem(entry),
      })),
    );
  }
  function serviceForm(
    service: TuiService,
    initial?: unknown,
    title = service.method,
    description?: string,
  ) {
    const seeded = initial ?? JSON.parse(service.defaultDraft);
    const ctx = context();
    if (seeded && typeof seeded === "object") {
      if ("threadId" in seeded && !seeded.threadId) seeded.threadId = ctx.threadId ?? "";
      if ("cwd" in seeded && !seeded.cwd) seeded.cwd = ctx.cwd ?? "";
      if ("projectId" in seeded && !seeded.projectId) seeded.projectId = ctx.projectId ?? "";
      if ("commandId" in seeded && !seeded.commandId)
        seeded.commandId = SecureRandom.uuidV4Unsafe();
    }
    form({
      title,
      description: `${description ?? service.method}\n${service.streaming ? "Stream results until you close the result view." : "Review values before applying. Changes execute on the connected environment."}\n${service.payloadSchema}`,
      initialValue: JSON.stringify(seeded, null, 2),
      multiline: true,
      onSubmit: async (text) => {
        const payload: unknown = JSON.parse(text);
        if (service.streaming) {
          output()?.stop?.();
          setOutput({ title, text: "Waiting for results…" });
          let received = false;
          const stop = client().stream(
            service.method,
            payload,
            (value) => {
              const line = typeof value === "string" ? value : JSON.stringify(value, null, 2);
              setOutput((previous) => {
                if (previous?.title !== title) return previous;
                const combined = received ? `${previous.text}\n${line}` : line;
                received = true;
                return {
                  ...previous,
                  text:
                    combined.length > 200_000
                      ? `[Earlier output omitted]\n${combined.slice(-180_000)}`
                      : combined,
                };
              });
            },
            (error) => {
              setFailure(true);
              setNotice(error.message);
            },
          );
          setOutput((previous) => (previous ? { ...previous, stop } : previous));
        } else showOutput(title, await client().invoke(service.method, payload));
        setModal(null);
      },
    });
  }
  function servicePicker() {
    pick(
      "All T3 services",
      services.map((service) => ({
        title: service.method,
        category: serviceCategory(service.method),
        description: service.streaming ? "Streaming service" : "Request and response",
        run: () => {
          if (service.variants.length > 1)
            pick(
              service.method,
              service.variants.map((variant) => ({
                title: variant.name,
                run: () => serviceForm(service, JSON.parse(variant.draft)),
              })),
            );
          else serviceForm(service);
        },
      })),
    );
  }
  function answerQuestions(
    requestId: string,
    questions: readonly OrchestrationV2UserInputQuestion[],
  ) {
    const answers: Record<string, unknown> = {};
    function next(index: number) {
      const question = questions[index];
      if (!question) {
        void run(() => client().answer(requestId, answers), "Answer sent");
        return;
      }
      if (
        question.multiSelect ||
        question.options.length === 0 ||
        question.initialAnswer !== undefined
      ) {
        form({
          title: question.header,
          description: `${question.question}\n${question.options.map((option) => `${option.value ?? option.label}: ${option.description}`).join("\n")}${question.multiSelect ? "\nEnter a JSON array of the option values, or a custom answer." : ""}`,
          initialValue: question.initialAnswer ?? (question.multiSelect ? "[]" : ""),
          onSubmit: async (text) => {
            const selected: unknown =
              question.multiSelect && text.trim().startsWith("[") ? JSON.parse(text) : undefined;
            if (
              selected !== undefined &&
              (!Array.isArray(selected) || !selected.every((value) => typeof value === "string"))
            )
              throw new Error("Enter an array of option values.");
            const answer = resolvePendingUserInputAnswer(
              question,
              Array.isArray(selected) ? { selectedOptionValues: selected } : { customAnswer: text },
            );
            if (answer === null)
              throw new Error("Choose an offered option or enter an allowed answer.");
            answers[question.id] = answer;
            setModal(null);
            next(index + 1);
          },
        });
        return;
      }
      const options: Choice[] = question.options.map((option) => ({
        title: option.label,
        description: `${question.question}\n${option.description}`,
        run: () => {
          answers[question.id] = option.value ?? option.label;
          next(index + 1);
        },
      }));
      if (question.allowCustomAnswer !== false)
        options.push({
          title: "Write an answer…",
          run: () => {
            form({
              title: question.header,
              description: question.question,
              initialValue: "",
              onSubmit: async (text) => {
                const answer = resolvePendingUserInputAnswer(question, { customAnswer: text });
                if (answer === null) throw new Error("Enter an answer.");
                answers[question.id] = answer;
                setModal(null);
                next(index + 1);
              },
            });
          },
        });
      pick(question.header, options);
    }
    next(0);
  }
  function approvals() {
    pick(
      "Pending requests",
      pending().map((request) => {
        const item = projection()?.turnItems.find(
          (entry) =>
            (entry.type === "approval_request" || entry.type === "user_input_request") &&
            entry.requestId === request.id,
        );
        return {
          title: item?.title ?? request.kind.replaceAll("_", " "),
          description:
            item?.type === "approval_request"
              ? (item.prompt ?? item.reason ?? "Review request")
              : "Respond to the agent",
          run: () => {
            if (item?.type === "user_input_request") {
              answerQuestions(request.id, item.questions);
              return;
            }
            const decisions: readonly { title: string; decision: ProviderApprovalDecision }[] = [
              { title: "Allow once", decision: "accept" },
              { title: "Allow for session", decision: "acceptForSession" },
              { title: "Decline", decision: "decline" },
              { title: "Cancel", decision: "cancel" },
            ];
            pick(
              item?.type === "approval_request"
                ? (item.prompt ?? "Review approval")
                : "Review approval",
              decisions.map(({ title, decision }) => ({
                title,
                run: () => {
                  void run(() => client().approve(request.id, decision), "Response sent");
                },
              })),
            );
          },
        };
      }),
    );
  }
  function commandPalette() {
    const choices: Choice[] = [
      { title: "Switch thread", category: "Threads", run: threads },
      { title: "New thread", category: "Threads", run: newThread },
      { title: "Add project", category: "Projects", run: newProject },
      { title: "Choose model", category: "Agent", run: models },
      { title: "Switch environment", category: "Connections", run: environments },
      { title: "Pair environment", category: "Connections", run: connect },
      { title: "Connect with SSH", category: "Connections", run: ssh },
      { title: "Sign in to T3 Connect", category: "Connections", run: login },
      {
        title: "Sign out of T3 Connect",
        category: "Connections",
        run: () => {
          void run(() => client().logout(), "Signed out");
        },
      },
      {
        title: "Reconnect",
        category: "Connections",
        run: () => {
          void run(() => client().reconnect());
        },
      },
      { title: "Respond to pending requests", category: "Agent", run: approvals },
      {
        title: "Interrupt turn",
        category: "Agent",
        run: () => {
          void run(() => client().interrupt(), "Stop requested");
        },
      },
      {
        title: "Load earlier history",
        category: "Threads",
        run: () => {
          void run(() => client().loadEarlier());
        },
      },
      {
        title: "Thread details",
        category: "Threads",
        run: () => showOutput("Thread details", projection()),
      },
      { title: "Item details and full output", category: "Threads", run: itemDetails },
      {
        title: "Open terminal",
        category: "Terminal",
        description:
          "Attach an interactive shell on the connected environment. Ctrl+] returns to chat.",
        run: () => {
          void run(() => openTerminal({ client: client(), renderer, cwd: context().cwd ?? "" }));
        },
      },
      {
        title: "Environment settings",
        category: "Settings",
        run: () => showOutput("Environment settings", snapshot()?.config),
      },
      {
        title: "All T3 services",
        category: "Tools",
        description: "Search and run the complete typed server interface.",
        run: servicePicker,
      },
      { title: "Keyboard help", category: "Help", run: help },
      { title: "Exit", category: "App", run: props.onExit },
      ...quickActions.map((action) => ({
        title: action.title,
        category: action.category,
        description: action.description,
        run: () => {
          const service = services.find((candidate) => candidate.method === action.method);
          if (service)
            serviceForm(service, action.payload(context()), action.title, action.description);
        },
      })),
    ];
    pick("Commands", choices);
  }
  function help() {
    showOutput(
      "Keyboard help",
      "Ctrl+P   Commands and features\nCtrl+T   Switch thread\nCtrl+N   New thread\nCtrl+O   Choose model\nCtrl+A   Pending approvals and questions\nCtrl+K   Interrupt current turn\nCtrl+Q   Exit\nEnter    Send prompt\nShift+Enter   New line\nPageUp / PageDown   Scroll transcript\nEscape   Close result or dialog\n\nType /commands, /threads, /new, /models, /requests, /services or /help. Other provider slash commands are sent unchanged.\n\nService forms use JSON validated against the connected T3 contract. Ctrl+Enter executes the reviewed input. Streaming results stop when you close their view.",
    );
  }
  async function send() {
    const text = composer?.plainText ?? "";
    const destination = draftKey(snapshot());
    if (!text.trim() || busy() || modal()) return;
    const routes: Record<string, () => void> = {
      "/commands": commandPalette,
      "/threads": threads,
      "/new": newThread,
      "/models": models,
      "/requests": approvals,
      "/services": servicePicker,
      "/environments": environments,
      "/connect": connect,
      "/help": help,
    };
    const route = routes[text.trim()];
    if (route) {
      composer?.clear();
      setDraft("");
      route();
      return;
    }
    await run(async () => {
      await client().send(text);
      if (drafts.get(destination) === text) drafts.delete(destination);
      if (draftKey(snapshot()) === destination && composer?.plainText === text) {
        composer.clear();
        setDraft("");
      }
    });
  }
  useKeyboard((event) => {
    if (event.ctrl && event.name === "q") {
      props.onExit();
      event.preventDefault();
      return;
    }
    if (modal()) return;
    const shortcuts: Record<string, () => void> = {
      p: commandPalette,
      t: threads,
      n: newThread,
      o: models,
      a: approvals,
      k: () => {
        void run(() => client().interrupt(), "Stop requested");
      },
    };
    if (event.ctrl && shortcuts[event.name]) {
      event.preventDefault();
      shortcuts[event.name]?.();
    } else if (event.name === "pageup" || event.name === "pagedown") {
      history?.scrollBy(event.name === "pageup" ? -0.8 : 0.8, "viewport");
      event.preventDefault();
    } else if (event.name === "escape" && output()) {
      closeOutput();
      event.preventDefault();
    }
  });

  const modalView = (): JSX.Element => {
    const value = modal();
    if (value?.kind === "picker")
      return (
        <DialogSelect
          title={value.title}
          options={value.options}
          onCancel={() => setModal(null)}
          onSelect={(option) => {
            setModal(null);
            try {
              option.value();
            } catch (error) {
              setFailure(true);
              setNotice(error instanceof Error ? error.message : String(error));
            }
          }}
        />
      );
    if (value?.kind === "form") return <Form {...value.props} />;
    if (value?.kind === "secret")
      return (
        <SecretForm
          title={value.title}
          description={value.description}
          onSubmit={(secret) => {
            passwordPending = undefined;
            setModal(null);
            value.resolve(secret);
          }}
        />
      );
    return null;
  };
  return (
    <box width="100%" height="100%" backgroundColor={theme.background} flexDirection="column">
      <box
        height={2}
        paddingX={2}
        alignItems="center"
        flexDirection="row"
        backgroundColor={theme.backgroundPanel}
      >
        <text fg={theme.primary} flexShrink={0}>
          T3 Code
        </text>
        <text
          fg={theme.textMuted}
          flexGrow={1}
          truncate
        >{`  ${snapshot()?.label ?? "Terminal client"}`}</text>
        <text fg={snapshot()?.connection === "connected" ? theme.success : theme.textMuted}>
          {props.demo ? "Offline demo" : (snapshot()?.connection ?? "Not connected")}
        </text>
      </box>
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Show when={dimensions().width >= 100}>
          <box width={29} padding={1} backgroundColor={theme.backgroundPanel}>
            <text fg={theme.text}>Projects</text>
            <scrollbox flexGrow={1} marginTop={1}>
              <For each={snapshot()?.shell?.projects ?? []}>
                {(project) => (
                  <box marginBottom={1}>
                    <text
                      fg={theme.textMuted}
                      truncate
                      onMouseDown={() => {
                        void run(() => client().createThread(project.id));
                      }}
                    >
                      {project.title}
                    </text>
                    <For
                      each={
                        snapshot()?.shell?.threads.filter(
                          (thread) => thread.projectId === project.id,
                        ) ?? []
                      }
                    >
                      {(thread) => (
                        <text
                          fg={
                            snapshot()?.selectedThreadId === thread.id ? theme.primary : theme.text
                          }
                          truncate
                          onMouseDown={() => {
                            closeOutput();
                            client().selectThread(thread.id);
                          }}
                        >{`${snapshot()?.selectedThreadId === thread.id ? "┃" : " "} ${thread.title}`}</text>
                      )}
                    </For>
                  </box>
                )}
              </For>
              <Show when={props.demo}>
                <text fg={theme.textMuted}>
                  Your projects and threads appear here after connecting.
                </text>
              </Show>
            </scrollbox>
            <text fg={theme.textMuted}>ctrl+t switch · ctrl+n new</text>
          </box>
        </Show>
        <box flexGrow={1} minWidth={0} paddingX={2}>
          <box height={2} flexDirection="row" alignItems="center">
            <text fg={theme.text} flexGrow={1} truncate>
              {output()?.title ?? projection()?.thread.title ?? "Your agents, in your terminal"}
            </text>
            <Show when={output()}>
              <text fg={theme.textMuted}>esc close</text>
            </Show>
          </box>
          <scrollbox
            ref={(element) => {
              history = element;
            }}
            flexGrow={1}
            minHeight={0}
            stickyScroll={!output()}
            stickyStart="bottom"
            scrollY
          >
            <Show
              when={output()}
              fallback={
                <Show
                  when={projection()}
                  fallback={
                    <box marginTop={2} gap={1}>
                      <text fg={theme.primary}>T3 Code + OpenCode’s terminal interface</text>
                      <text fg={theme.text} wrapMode="word">
                        Work with every T3 provider from one terminal. Threads, permissions, tools
                        and checkpoints stay on your T3 environment.
                      </text>
                      <text fg={theme.textMuted} wrapMode="word">
                        Ctrl+T opens a thread. Ctrl+N starts one. Ctrl+P opens commands for files,
                        source control, scheduled tasks and settings.
                      </text>
                      <Show when={!props.demo && snapshot()?.environmentId === null}>
                        <text fg={theme.primary} onMouseDown={connect}>
                          Pair a T3 environment
                        </text>
                        <text fg={theme.primary} onMouseDown={ssh}>
                          Connect with SSH
                        </text>
                        <text fg={theme.primary} onMouseDown={login}>
                          Sign in to T3 Connect
                        </text>
                      </Show>
                      <Show when={props.demo}>
                        <box
                          marginTop={2}
                          border={["left"]}
                          borderColor={theme.primary}
                          paddingLeft={1}
                        >
                          <text fg={theme.primary}>You</text>
                          <text fg={theme.text}>Review my changes and show the diff.</text>
                        </box>
                        <box
                          marginTop={1}
                          border={["left"]}
                          borderColor={theme.borderSubtle}
                          paddingLeft={1}
                        >
                          <text fg={theme.textMuted}>Agent · example</text>
                          <text fg={theme.text}>
                            Connected sessions stream messages, tool output and approval requests
                            here.
                          </text>
                        </box>
                      </Show>
                    </box>
                  }
                >
                  {(thread) => <Transcript projection={thread()} onOpenItem={openItem} />}
                </Show>
              }
            >
              {(result) => (
                <text fg={theme.text} wrapMode="word">
                  {result().text}
                </text>
              )}
            </Show>
          </scrollbox>
          <Show when={pending().length > 0}>
            <text
              fg={theme.warning}
              onMouseDown={approvals}
            >{`${pending().length} request${pending().length === 1 ? "" : "s"} need your response · ctrl+a`}</text>
          </Show>
          <Show when={notice() ?? snapshot()?.error}>
            <text
              maxHeight={3}
              fg={failure() || snapshot()?.error ? theme.error : theme.textMuted}
              wrapMode="word"
            >
              {notice() ?? snapshot()?.error}
            </text>
          </Show>
          <box
            marginTop={1}
            backgroundColor={theme.backgroundPanel}
            paddingX={1}
            paddingY={1}
            flexShrink={0}
          >
            <textarea
              ref={(element) => {
                composer = element;
              }}
              focused={!modal() && !output()}
              minHeight={1}
              maxHeight={6}
              placeholder={busy() ? "Working…" : "Ask your agent…"}
              placeholderColor={theme.textMuted}
              textColor={theme.text}
              focusedTextColor={theme.text}
              backgroundColor={theme.backgroundPanel}
              focusedBackgroundColor={theme.backgroundPanel}
              cursorColor={theme.primary}
              onContentChange={() => setDraft(composer?.plainText ?? "")}
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "return", shift: true, action: "newline" },
              ]}
              onSubmit={() => {
                void send();
              }}
            />
            <box flexDirection="row" marginTop={1} height={1} flexShrink={0}>
              <text fg={theme.primary} flexGrow={1} truncate>
                {projection()?.thread.modelSelection.model ?? "Choose a thread to start"}
              </text>
              <text fg={theme.textMuted}>
                {draft().length > 0 ? "enter send · shift+enter newline" : "ctrl+o models"}
              </text>
            </box>
          </box>
          <text height={1} flexShrink={0} fg={theme.textMuted}>
            ctrl+p commands · ctrl+t threads · ctrl+k stop · ctrl+q exit
          </text>
        </box>
      </box>
      {modalView()}
    </box>
  );
}
