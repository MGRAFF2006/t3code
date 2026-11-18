import type { Renderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type MentionContextRecord,
  type OrchestrationV2Command,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { Transcript, turnItemText } from "../transcript.tsx";
import { answerSecretRequest } from "../management/secrets.tsx";
import { copyTerminalText } from "../presentation/terminal.ts";
import { resolveFileMentions } from "./context.ts";
import { attachmentActions } from "./attachments.ts";
import type { LocalAttachment } from "../runtime/attachments.ts";
import { RequestCards } from "./requests.tsx";

interface Draft {
  text: string;
  mentions: ReadonlyArray<MentionContextRecord>;
  attachments: ReadonlyArray<LocalAttachment>;
}
const drafts = new Map<string, Draft>();
const pendingSends = new Set<string>();
const draftOwners = new Map<string, { apply: (draft: Draft) => void; settled: () => void }>();
const runtimeLabels: Record<RuntimeMode, string> = {
  "approval-required": "Ask before changes",
  "auto-accept-edits": "Accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

function ThreadConversation(
  props: FeatureProps & { scope: string; projection: () => OrchestrationV2ThreadProjection },
) {
  const dimensions = useTerminalDimensions();
  const renderer = useRenderer();
  const environmentId = props.state()?.environmentId;
  const destinationThreadId = props.projection().thread.id;
  let disposed = false;
  const initialDraft = drafts.get(props.scope) ?? { text: "", mentions: [], attachments: [] };
  const [draft, setDraft] = createSignal(initialDraft.text);
  const [mentions, setMentions] = createSignal(initialDraft.mentions);
  const [attachments, setAttachments] = createSignal(initialDraft.attachments);
  const [sending, setSending] = createSignal(pendingSends.has(props.scope));
  const [preferences, setPreferences] = createSignal(props.client.preferences());
  onCleanup(props.client.subscribePreferences(setPreferences));
  const [loadingHistory, setLoadingHistory] = createSignal(false);
  const [requestFocus, setRequestFocus] = createSignal(false);
  const [expandWork, setExpandWork] = createSignal(false);
  const [following, setFollowing] = createSignal(true);
  let composer: TextareaRenderable | undefined;
  let history: ScrollBoxRenderable | undefined;
  const rows = new Map<string, Renderable>();
  const thread = () => props.projection().thread;
  const queue = createMemo(() => deriveThreadQueueWorkflowState(props.projection()));
  const pending = createMemo(() => derivePendingThreadRequests(props.projection()));
  const secretRequests = createMemo(() =>
    props
      .projection()
      .visibleTurnItems.flatMap((entry) =>
        entry.visibility === "local" &&
        entry.item.type === "secret_request" &&
        entry.item.secretStatus === "pending"
          ? [entry.item]
          : [],
      ),
  );
  const pendingCount = () =>
    pending().approvals.length + pending().userInputs.length + secretRequests().length;
  createEffect(() => {
    if (pendingCount() === 0) setRequestFocus(false);
  });
  const project = () =>
    props.state()?.shell?.projects.find((value) => value.id === thread().projectId);
  const cwd = () => thread().worktreePath ?? project()?.workspaceRoot ?? props.state()?.config?.cwd;
  const provider = () =>
    props
      .state()
      ?.config?.providers.find((value) => value.instanceId === thread().modelSelection.instanceId);
  const workspaceProvider = () =>
    provider()?.workspaceSnapshots?.find((value) => value.cwd === cwd());
  const usage = createMemo(() => {
    const projection = props.projection();
    const providerThread = projection.providerThreads.find(
      (value) => value.id === projection.thread.activeProviderThreadId,
    );
    return deriveLatestContextWindowSnapshot(
      projection.visibleTurnItems,
      latestProviderTurnTokenUsage(projection.providerTurns, projection, providerThread),
      providerThread,
    );
  });
  const saveDraft = () =>
    drafts.set(props.scope, {
      text: composer && !composer.isDestroyed ? composer.plainText : draft(),
      mentions: mentions(),
      attachments: attachments(),
    });
  const setText = (value: string) => {
    composer?.setText(value);
    setDraft(value);
    drafts.set(props.scope, { text: value, mentions: mentions(), attachments: attachments() });
  };
  const owner = {
    apply: (value: Draft) => {
      setMentions(value.mentions);
      setAttachments(value.attachments);
      setText(value.text);
    },
    settled: () => setSending(false),
  };
  draftOwners.set(props.scope, owner);
  onCleanup(() => {
    saveDraft();
    disposed = true;
    if (draftOwners.get(props.scope) === owner) draftOwners.delete(props.scope);
  });
  function attach() {
    if (sending()) {
      props.ui.notify("Wait for this message's attachments to finish uploading.");
      return;
    }
    attachmentActions(
      props,
      attachments(),
      (next) => {
        if (environmentId)
          props.client.releaseLocalAttachments(
            environmentId,
            attachments().filter((value) => !next.some((current) => current.id === value.id)),
          );
        setAttachments(next);
        saveDraft();
      },
      () =>
        !disposed &&
        !sending() &&
        props.state()?.environmentId === environmentId &&
        props.state()?.thread?.thread.id === destinationThreadId,
    );
  }
  const command = (value: OrchestrationV2Command) => {
    if (props.state()?.environmentId !== environmentId)
      return Promise.reject(new Error("Return to this thread's environment to continue."));
    return request(props.client, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, value);
  };
  const id = () => CommandId.make(SecureRandom.uuidV4Unsafe());
  const goBottom = () => {
    history?.scrollTo(Infinity);
    setFollowing(true);
  };
  function activateRequests() {
    if (pendingCount() === 0) {
      props.ui.notify("No requests need your response.");
      return;
    }
    props.onFocus();
    if (pending().approvals.length + pending().userInputs.length === 0) {
      props.ui.choose(
        "Provide a requested secret",
        secretRequests().map((item) => ({
          title: item.label,
          description: item.reason,
          run: () => answerSecretRequest(props, item),
        })),
      );
      return;
    }
    setRequestFocus(true);
    goBottom();
  }
  async function earlier() {
    if (loadingHistory() || !props.state()?.hasMoreHistory || !history) return;
    const box = history;
    const visible = [...rows.values()].find(
      (row) => !row.isDestroyed && row.y + row.height > box.y && row.y < box.y + box.height,
    );
    const release = visible ? box.anchor(visible) : undefined;
    setLoadingHistory(true);
    try {
      await props.client.loadEarlier();
    } finally {
      setLoadingHistory(false);
      if (!box.isDestroyed) box.afterLayout(() => release?.());
      else release?.();
    }
  }
  const loadEarlier = () => {
    void props.ui.run(earlier);
  };
  const openItem = (entry: OrchestrationV2ProjectedTurnItem) => {
    const sourceThreadId = entry.sourceThreadId;
    const itemId = entry.sourceItemId;
    void props.ui.run(async () => {
      const result = await request(props.client, ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
        threadId: sourceThreadId,
        itemId,
      });
      const value = result.item ?? entry.item;
      props.ui.text(
        value.title ?? value.type.replaceAll("_", " "),
        turnItemText(value),
        value.type === "proposed_plan" || value.type === "assistant_message"
          ? "markdown"
          : value.type === "file_change"
            ? "diff"
            : undefined,
      );
    });
  };
  function workLog() {
    props.ui.choose("Work log", [
      {
        title: expandWork() ? "Collapse all details" : "Expand all details",
        run: () => setExpandWork((value) => !value),
      },
      ...props
        .projection()
        .visibleTurnItems.filter(
          (value) => value.item.type !== "user_message" && value.item.type !== "assistant_message",
        )
        .map((entry) => ({
          title: entry.item.title ?? entry.item.type.replaceAll("_", " "),
          description: turnItemText(entry.item).replaceAll("\n", " ").slice(0, 160),
          run: () => openItem(entry),
        })),
    ]);
  }
  function permissions() {
    const threadId = thread().id;
    props.ui.choose(
      "Agent permissions",
      (Object.entries(runtimeLabels) as [RuntimeMode, string][]).map(([value, title]) => ({
        title: `${thread().runtimeMode === value ? "✓ " : ""}${title}`,
        description:
          value === "full-access"
            ? "Allow this agent to run commands and change files without approval."
            : value === "approval-required"
              ? "Approve commands and edits as the provider requests them."
              : value === "auto-accept-edits"
                ? "Accept file edits; keep command approval checks."
                : "Use the provider's automatic permission policy.",
        run: () => {
          void props.ui.run(() =>
            command({
              type: "thread.runtime-mode.set",
              commandId: id(),
              threadId,
              runtimeMode: value,
            }),
          );
        },
      })),
    );
  }
  function togglePlan() {
    const threadId = thread().id;
    const interactionMode = thread().interactionMode === "plan" ? "default" : "plan";
    void props.ui.run(() =>
      command({ type: "thread.interaction-mode.set", commandId: id(), threadId, interactionMode }),
    );
  }
  function options() {
    const selection = thread().modelSelection;
    const threadId = thread().id;
    const descriptors =
      workspaceProvider()?.optionDescriptors ??
      provider()?.models.find((value) => value.slug === selection.model)?.capabilities
        ?.optionDescriptors ??
      [];
    if (descriptors.length === 0) {
      props.ui.notify("This model has no configurable options.");
      return;
    }
    props.ui.form({
      title: "Model options",
      fields: descriptors.map((descriptor) => {
        const selected =
          selection.options?.find((value) => value.id === descriptor.id)?.value ??
          descriptor.currentValue;
        return {
          name: descriptor.id,
          label: descriptor.label,
          ...(descriptor.description ? { description: descriptor.description } : {}),
          type: descriptor.type === "boolean" ? ("toggle" as const) : ("select" as const),
          value:
            selected === undefined
              ? descriptor.type === "boolean"
                ? "false"
                : (descriptor.options[0]?.id ?? "")
              : String(selected),
          ...(descriptor.type === "select"
            ? {
                options: descriptor.options.map((value) => ({
                  label: value.label,
                  value: value.id,
                })),
              }
            : {}),
        };
      }),
      submitLabel: "Save options",
      onSubmit: async (values) => {
        await command({
          type: "thread.model-selection.set",
          commandId: id(),
          threadId,
          modelSelection: {
            ...selection,
            options: [
              ...(selection.options ?? []).filter(
                (selected) => !descriptors.some((descriptor) => descriptor.id === selected.id),
              ),
              ...descriptors.map((descriptor) => ({
                id: descriptor.id,
                value:
                  descriptor.type === "boolean"
                    ? values[descriptor.id] === "true"
                    : (values[descriptor.id] ?? ""),
              })),
            ],
          },
        });
      },
    });
  }
  function queueActions() {
    const threadId = thread().id;
    const current = queue();
    const choices: Choice[] = [];
    if (current.isHeld)
      choices.push({
        title: "Resume queued messages",
        run: () => {
          void props.ui.run(() => command({ type: "queue.resume", commandId: id(), threadId }));
        },
      });
    for (const [index, queued] of current.queuedRuns.entries()) {
      const runId = queued.run.id;
      const title = `#${index + 1} ${queued.text.replaceAll("\n", " ").slice(0, 110)}`;
      choices.push({
        title,
        description: `${queued.attachments.length > 0 ? `${queued.attachments.length} attachments · ` : ""}Edit, steer, reorder or remove this message`,
        run: () => {
          const actions: Choice[] = [
            {
              title: "Edit message",
              run: () =>
                props.ui.form({
                  title: "Edit queued message",
                  fields: [
                    {
                      name: "text",
                      label: "Message",
                      type: "multiline",
                      value: queued.text,
                      required: true,
                    },
                  ],
                  submitLabel: "Save message",
                  onSubmit: async (values) => {
                    await command({
                      type: "queued-run.edit",
                      commandId: id(),
                      threadId,
                      runId,
                      text: values.text ?? "",
                      ...(queued.context ? { context: queued.context } : {}),
                    });
                  },
                }),
            },
          ];
          if (current.canPromoteToSteer && current.activeRun) {
            const targetRunId = current.activeRun.id;
            actions.push({
              title: "Steer the current turn",
              run: () => {
                void props.ui.run(() =>
                  command({
                    type: "queued-message.promote-to-steer",
                    commandId: id(),
                    threadId,
                    queuedRunId: runId,
                    targetRunId,
                  }),
                );
              },
            });
          }
          if (current.canSendNow)
            actions.push({
              title: "Send now",
              run: () => {
                void props.ui.run(() =>
                  command({ type: "queued-run.start", commandId: id(), threadId, runId }),
                );
              },
            });
          if (index > 0)
            actions.push({
              title: "Move to front",
              run: () => {
                void props.ui.run(() =>
                  command({
                    type: "queued-run.reorder",
                    commandId: id(),
                    threadId,
                    runId,
                    beforeRunId: current.queuedRuns[0]!.run.id,
                  }),
                );
              },
            });
          actions.push({
            title: "Remove from queue",
            run: () =>
              props.ui.confirm(
                "Remove queued message?",
                queued.text,
                async () => {
                  await command({ type: "queued-run.cancel", commandId: id(), threadId, runId });
                },
                "Remove message",
              ),
          });
          props.ui.choose("Queued message", actions);
        },
      });
    }
    if (choices.length === 0) {
      props.ui.notify(
        "No queued messages. While the agent works, Enter adds your next message to the queue.",
      );
      return;
    }
    props.ui.choose(current.isHeld ? "Queue paused" : "Queued messages", choices);
  }
  function mention(query = "") {
    const directory = cwd();
    if (!directory) return;
    const scope = props.scope;
    const destinationEnvironment = props.state()?.environmentId;
    const search = async (value: string) => {
      const result = await request(props.client, WS_METHODS.projectsSearchEntries, {
        cwd: directory,
        query: value,
        kind: "file",
        limit: 80,
      });
      props.ui.choose(
        "Add a file to your message",
        result.entries.map((entry) => ({
          title: entry.path,
          run: () => {
            if (
              props.scope !== scope ||
              props.state()?.environmentId !== destinationEnvironment ||
              disposed
            ) {
              props.ui.notify("Return to the original thread to add this file.", true);
              return;
            }
            const record: MentionContextRecord = {
              version: 1,
              kind: "mention",
              contextId: toKindScopedComposerContextId("mention", SecureRandom.uuidV4Unsafe()),
              label: entry.path.slice(0, 200),
              path: entry.path,
            };
            setMentions((value) => [...value, record]);
            const text = composer?.plainText ?? draft();
            const token = `@${entry.path}`;
            const prefix = text.replace(
              new RegExp(`@${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
              "",
            );
            setText(`${prefix}${prefix && !/\s$/.test(prefix) ? " " : ""}${token} `);
          },
        })),
      );
    };
    if (query) {
      void props.ui.run(() => search(query));
      return;
    }
    props.ui.form({
      title: "Mention a workspace file",
      fields: [{ name: "query", label: "File name or path", value: "" }],
      submitLabel: "Find files",
      onSubmit: async (values) => search(values.query ?? ""),
    });
  }
  const slashChoices = (): Choice[] => [
    { title: "/model", description: "Choose provider and model", run: props.ui.chooseModel },
    { title: "/plan", description: "Toggle plan mode", run: togglePlan },
    { title: "/permissions", description: "Change agent permissions", run: permissions },
    { title: "/options", description: "Configure this model", run: options },
    {
      title: "/files",
      description: "Browse workspace files",
      run: () => props.ui.openArea("workspace"),
    },
    { title: "/diff", description: "Review workspace changes", run: props.ui.showChanges },
    { title: "/queue", description: "Manage queued messages", run: queueActions },
    { title: "/work", description: "Inspect the work log", run: workLog },
    { title: "/attach", description: "Attach a local image or file", run: attach },
    { title: "/mention", description: "Add file context from the workspace", run: () => mention() },
    {
      title: "/stop",
      description: "Interrupt the current turn",
      run: () => {
        void props.ui.run(() => props.client.interrupt());
      },
    },
    ...(workspaceProvider()?.slashCommands ?? provider()?.slashCommands ?? []).map((value) => ({
      title: `/${value.name.replace(/^\//, "")}`,
      description: value.description ?? "Provider command",
      category: "Provider commands",
      run: () => setText(`/${value.name.replace(/^\//, "")} `),
    })),
    ...(workspaceProvider()?.skills ?? provider()?.skills ?? [])
      .filter((value) => value.enabled && value.userInvocable !== false)
      .map((value) => ({
        title: `/${value.name}`,
        description: value.shortDescription ?? value.description ?? "Skill",
        category: "Skills",
        run: () => setText(`/${value.name} `),
      })),
  ];
  function slashMenu() {
    const prefix = (composer?.plainText ?? draft()).trim();
    props.ui.choose(
      "Message commands",
      slashChoices().filter((value) =>
        value.title.startsWith(prefix.startsWith("/") ? prefix : "/"),
      ),
    );
  }
  async function send(delivery?: "queue" | "steer" | "restart") {
    const text = composer?.plainText ?? draft();
    if ((!text.trim() && attachments().length === 0) || sending()) return;
    const local = slashChoices().find((value) => value.title === text.trim() && !value.category);
    if (local) {
      setText("");
      local.run();
      return;
    }
    const scope = props.scope;
    const { text: outgoingText, records } = resolveFileMentions(text, mentions());
    const captured = { text, mentions: mentions(), attachments: attachments() };
    pendingSends.add(scope);
    setSending(true);
    try {
      await props.client.send(outgoingText, {
        ...(delivery
          ? { dispatchMode: delivery }
          : queue().activeRun
            ? {
                dispatchMode:
                  preferences().followUpMode === "steer" && queue().canPromoteToSteer
                    ? ("steer" as const)
                    : ("queue" as const),
              }
            : {}),
        ...(captured.attachments.length > 0 ? { localAttachments: captured.attachments } : {}),
        ...(records.length > 0 ? { context: { version: 1 as const, records } } : {}),
      });
      const current = drafts.get(scope) ?? captured;
      const unchanged = current.text === captured.text;
      const next: Draft = {
        text: unchanged ? "" : current.text,
        mentions: unchanged ? [] : current.mentions,
        attachments: current.attachments.filter(
          (value) => !captured.attachments.some((sent) => sent.id === value.id),
        ),
      };
      drafts.set(scope, next);
      draftOwners.get(scope)?.apply(next);
      if (!disposed && unchanged) goBottom();
    } finally {
      pendingSends.delete(scope);
      draftOwners.get(scope)?.settled();
    }
  }
  function deliveryMenu() {
    const choices: Choice[] = [
      {
        title: queue().activeRun ? "Queue after current turn" : "Send message",
        run: () => {
          void props.ui.run(() => send(queue().activeRun ? "queue" : undefined));
        },
      },
    ];
    if (queue().canPromoteToSteer)
      choices.push({
        title: "Steer current turn",
        description: "Send this message while the agent is working",
        run: () => {
          void props.ui.run(() => send("steer"));
        },
      });
    if (queue().activeRun)
      choices.push({
        title: "Interrupt and send",
        description: "Stop the current turn and restart with this message",
        run: () => {
          void props.ui.run(() => send("restart"));
        },
      });
    props.ui.choose("Send message", choices);
  }
  useKeyboard((key) => {
    if (!props.focused || props.ui.modal()) return;
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      history?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
      setFollowing(
        key.name === "pagedown" &&
          (history?.scrollTop ?? 0) + (history?.height ?? 0) >= (history?.scrollHeight ?? 0),
      );
      if (key.name === "pageup" && (history?.scrollTop ?? 0) === 0) loadEarlier();
    }
    if (key.ctrl && key.name === "home") {
      key.preventDefault();
      history?.scrollTo(0);
      setFollowing(false);
    }
    if (key.ctrl && key.name === "end") {
      key.preventDefault();
      goBottom();
    }
    if (key.ctrl && key.name === "a") {
      key.preventDefault();
      activateRequests();
    }
    if (key.ctrl && key.name === "j") {
      key.preventDefault();
      queueActions();
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault();
      workLog();
    }
    if (key.ctrl && key.name === "m") {
      key.preventDefault();
      props.ui.chooseModel();
    }
    if (key.ctrl && key.name === "r") {
      key.preventDefault();
      permissions();
    }
    if (key.ctrl && key.name === "x") {
      key.preventDefault();
      void props.ui.run(() => props.client.interrupt());
    }
    if (key.ctrl && key.name === "space") {
      key.preventDefault();
      mention();
    }
    if ((key.ctrl && key.name === "return") || key.name === "f2") {
      key.preventDefault();
      deliveryMenu();
    }
    if (!requestFocus() && key.ctrl && key.name === "s") {
      key.preventDefault();
      key.stopPropagation();
      void props.ui.run(() => send());
    }
    if (!requestFocus() && key.name === "f3") {
      key.preventDefault();
      attach();
    }
    if (!requestFocus() && key.shift && key.name === "tab") {
      key.preventDefault();
      togglePlan();
    }
    if (!requestFocus() && !key.shift && key.name === "tab") {
      const text = composer?.plainText ?? draft();
      if (text.startsWith("/") && !text.includes("\n")) {
        key.preventDefault();
        slashMenu();
      }
      const match = /(?:^|\s)@([^\s]*)$/.exec(text);
      if (match) {
        key.preventDefault();
        mention(match[1] ?? "");
      }
    }
  });
  return (
    <box flexGrow={1} minHeight={0} onMouseDown={props.onFocus}>
      <scrollbox
        ref={(node) => {
          history = node;
          node.verticalScrollBar.on("change", () =>
            setFollowing(node.scrollTop + node.height >= node.scrollHeight),
          );
        }}
        flexGrow={1}
        minHeight={0}
        stickyScroll
        stickyStart="bottom"
        scrollY
        scrollX={!preferences().wordWrap}
        contentOptions={{ paddingX: dimensions().width > 120 ? 3 : 1 }}
      >
        <Show when={props.state()?.hasMoreHistory}>
          <text fg={theme.primary} onMouseDown={loadEarlier}>
            {loadingHistory() ? "Loading earlier messages…" : "↑ Load earlier messages"}
          </text>
        </Show>
        <Show
          when={
            props.projection().visibleTurnItems.length === 0 &&
            props.projection().messages.length === 0
          }
        >
          <box paddingY={2} gap={1}>
            <text fg={theme.text}>What would you like to work on?</text>
            <text fg={theme.textMuted} wrapMode="word">
              Ask a question, describe a change, or mention a file with @. Your agent works in{" "}
              {cwd() ?? "this project"}.
            </text>
            <box flexDirection="row" gap={2}>
              <text
                fg={theme.primary}
                onMouseDown={() => setText("Explain how this project is organized.")}
              >
                Explore this project
              </text>
              <text
                fg={theme.primary}
                onMouseDown={() => {
                  setText("Review the current changes for bugs and regressions.");
                }}
              >
                Review changes
              </text>
            </box>
          </box>
        </Show>
        <Transcript
          projection={props.projection()}
          hidePendingRequests
          wordWrap={preferences().wordWrap}
          expandAll={expandWork()}
          onOpenItem={openItem}
          onOpenThread={props.ui.openThread}
          onSecretRequest={(item) => answerSecretRequest(props, item)}
          onCopyItem={(entry) => {
            const threadId = entry.sourceThreadId;
            const itemId = entry.sourceItemId;
            void props.ui.run(async () => {
              const result = await request(props.client, ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
                threadId,
                itemId,
              });
              const copied = copyTerminalText(renderer, turnItemText(result.item ?? entry.item));
              props.ui.notify(copied.message, !copied.attempted);
            });
          }}
          onOpenFile={props.ui.openFile}
          onOpenHtml={props.ui.openHtml}
          onCopy={(text) => {
            const result = copyTerminalText(renderer, text);
            props.ui.notify(result.message, !result.attempted);
          }}
          onPreviewAsset={props.ui.previewImage}
          loadAsset={(resource) => props.client.readAsset(resource)}
          onFocus={props.onFocus}
          rowRef={(entry, node) => {
            rows.set(`${entry.sourceThreadId}/${entry.sourceItemId}`, node);
          }}
        />
        <RequestCards
          {...props}
          active={requestFocus()}
          onActivate={() => setRequestFocus(true)}
          onDone={() => setRequestFocus(false)}
          reveal={(node) => history?.scrollChildIntoView(node, { align: "nearest", inset: 1 })}
        />
      </scrollbox>
      <Show when={!following()}>
        <text fg={theme.primary} onMouseDown={goBottom}>
          ↓ Latest messages
        </text>
      </Show>
      <Show when={queue().queuedRuns.length > 0}>
        <box backgroundColor={theme.backgroundPanel} paddingX={1}>
          <text
            fg={theme.textMuted}
            onMouseDown={queueActions}
          >{`${queue().isHeld ? "Ⅱ Queue paused" : "Queued"} · ${queue().queuedRuns.length} message${queue().queuedRuns.length === 1 ? "" : "s"} · Ctrl+J manage`}</text>
          <For each={queue().queuedRuns.slice(0, 2)}>
            {(value, index) => (
              <text
                fg={theme.textMuted}
                truncate
                onMouseDown={queueActions}
              >{`${index() + 1}. ${value.text.replaceAll("\n", " ")}`}</text>
            )}
          </For>
        </box>
      </Show>
      <box flexDirection="row" paddingX={1} height={1}>
        <text
          fg={
            pendingCount() > 0 ? theme.warning : queue().activeRun ? theme.primary : theme.textMuted
          }
          flexGrow={1}
          truncate
          onMouseDown={() => {
            if (pendingCount()) activateRequests();
          }}
        >
          {pendingCount() > 0
            ? `${pendingCount()} request${pendingCount() === 1 ? "" : "s"} need your response · Ctrl+A`
            : queue().activeRun
              ? `${provider()?.displayName ?? "Agent"} ${queue().activeRun?.status === "waiting" ? "finishing turn" : queue().activeRun?.status === "preparing" ? "preparing workspace" : "working"}…`
              : "Ready"}
        </text>
        <Show when={usage()}>
          {(value) => (
            <text
              fg={theme.textMuted}
            >{`${value().usedTokens.toLocaleString()} tokens${value().usedPercentage === null ? "" : ` · ${Math.round(value().usedPercentage!)}% context`}`}</text>
          )}
        </Show>
        <Show when={queue().activeRun}>
          <text
            fg={theme.textMuted}
            onMouseDown={() => {
              void props.ui.run(() => props.client.interrupt());
            }}
          >
            {" "}
            Stop Ctrl+X
          </text>
        </Show>
      </box>
      <box
        marginTop={1}
        paddingX={1}
        paddingY={1}
        backgroundColor={theme.backgroundPanel}
        border={["left"]}
        borderColor={props.focused ? theme.borderActive : theme.borderSubtle}
        flexShrink={0}
      >
        <Show when={mentions().some((record) => draft().includes(`@${record.path}`))}>
          <text fg={theme.textMuted} truncate>
            {mentions()
              .filter((record) => draft().includes(`@${record.path}`))
              .map((record) => `@${record.path}`)
              .join("   ")}
          </text>
        </Show>
        <Show when={attachments().length > 0}>
          <text fg={theme.textMuted} truncate onMouseDown={attach}>
            {attachments()
              .map((value) => `${value.type === "image" ? "▧" : "▤"} ${value.name}`)
              .join("   ")}{" "}
            · F3 manage
          </text>
        </Show>
        <textarea
          ref={(node) => {
            composer = node;
          }}
          initialValue={initialDraft.text}
          focused={props.focused && !props.ui.modal() && !requestFocus()}
          minHeight={2}
          maxHeight={7}
          placeholder={
            sending()
              ? "Sending…"
              : queue().activeRun
                ? "Send a follow-up…"
                : "Ask anything, @ to mention a file, / for commands"
          }
          placeholderColor={theme.textMuted}
          textColor={theme.text}
          focusedTextColor={theme.text}
          backgroundColor={theme.backgroundPanel}
          focusedBackgroundColor={theme.backgroundPanel}
          cursorColor={theme.primary}
          onContentChange={() => {
            if (!composer || composer.isDestroyed) return;
            setDraft(composer.plainText);
            saveDraft();
          }}
          keyBindings={[
            {
              name: "return",
              action: preferences().sendShortcut === "enter" ? "submit" : "newline",
            },
            { name: "return", shift: true, action: "newline" },
            { name: "return", meta: true, action: "newline" },
          ]}
          onSubmit={() => {
            if (props.focused && !props.ui.modal() && !requestFocus())
              void props.ui.run(() => send());
          }}
        />
        <box flexDirection="row" height={1} marginTop={1}>
          <text
            fg={thread().interactionMode === "plan" ? theme.primary : theme.textMuted}
            onMouseDown={togglePlan}
          >
            {thread().interactionMode === "plan" ? "Plan" : "Build"}
          </text>
          <text
            fg={theme.text}
            onMouseDown={props.ui.chooseModel}
            truncate
          >{`  ${thread().modelSelection.model}`}</text>
          <text fg={theme.textMuted} onMouseDown={options}>
            {" "}
            ⚙{" "}
          </text>
          <text fg={theme.textMuted} onMouseDown={attach}>
            {" "}
            Attach{" "}
          </text>
          <text fg={theme.textMuted} flexGrow={1} truncate onMouseDown={permissions}>
            {runtimeLabels[thread().runtimeMode]}
          </text>
          <text
            fg={
              (draft().trim() || attachments().length > 0) && !sending()
                ? theme.primary
                : theme.textMuted
            }
            onMouseDown={() => {
              void props.ui.run(() => send());
            }}
          >
            {sending()
              ? "Sending…"
              : queue().activeRun
                ? preferences().followUpMode === "steer" && queue().canPromoteToSteer
                  ? "Steer"
                  : "Queue"
                : preferences().sendShortcut === "ctrl-s"
                  ? "Send ^S"
                  : "Send ↵"}
          </text>
        </box>
      </box>
      <text height={1} fg={theme.textMuted} paddingX={1} truncate>
        {requestFocus()
          ? "↑↓ choose · space select · enter activate · esc compose"
          : `${preferences().sendShortcut === "ctrl-s" ? "Enter newline · Ctrl+S send" : "Alt+Enter newline"} · F2 delivery · F3 attach · / Tab commands`}
      </text>
    </box>
  );
}

export function ConversationPanel(props: FeatureProps) {
  const scope = () =>
    props.state()?.thread
      ? `${props.state()?.environmentId}/${props.state()?.thread?.thread.id}`
      : null;
  return (
    <Show
      when={scope()}
      keyed
      fallback={
        <box flexGrow={1} padding={3} gap={1}>
          <text fg={theme.text}>
            {props.state()?.selectedThreadId
              ? "Opening conversation…"
              : "Your agents, in your terminal"}
          </text>
          <text fg={theme.textMuted} wrapMode="word">
            Choose a thread from the sidebar or start a new conversation. Projects, worktrees,
            providers and history stay on your T3 environment.
          </text>
        </box>
      }
    >
      {(key) => (
        <ThreadConversation {...props} scope={key} projection={() => props.state()!.thread!} />
      )}
    </Show>
  );
}
