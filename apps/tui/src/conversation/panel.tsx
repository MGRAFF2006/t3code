import type { Renderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  CommandId,
  COMPOSER_CONTEXT_MAX_RECORDS,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type MentionContextRecord,
  type OrchestrationV2Command,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2PromptSuggestion,
  type OrchestrationV2SearchThreadResult,
  type RuntimeMode,
  type ModelSelection,
  type OrchestrationMessageContext,
  type ProjectId,
  type ChatAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  isCompactionCommandMessage,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { resolveIdleCompaction } from "@t3tools/contracts/settings";
import {
  deriveThreadQueueWorkflowState,
  threadSteersDuringCompaction,
} from "@t3tools/client-runtime/state/thread-workflows";
import { compactionBlocksSteering } from "@t3tools/client-runtime/state/composer-dispatch";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
  compactBeforeSendTokens,
} from "@t3tools/client-runtime/state/context-window";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { workspacePreparationRetryRunIds } from "@t3tools/client-runtime/state/turn-item-presentation";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request, subscribe } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { Transcript, turnItemText } from "../transcript.tsx";
import { messageLinkActions } from "../presentation/links.ts";
import { answerSecretRequest } from "../management/secrets.tsx";
import { copyTerminalText } from "../presentation/terminal.ts";
import { selectableModels } from "../presentation/models.ts";
import { referencedDraftContext, resolveFileMentions } from "./context.ts";
import { attachmentActions } from "./attachments.ts";
import { RequestCards } from "./requests.tsx";
import {
  hasDraftContent,
  promptSuggestionForLatestRun,
  settleSentDraft,
  type Draft,
} from "./draft.ts";
import { draftStore } from "./draft-storage.ts";
import { contextActions } from "./context-actions.ts";
import { planActions } from "./plan.ts";
import { createFanoutTargets, startFanoutTargets, type FanoutTarget } from "./fanout.ts";
import { createConversationStatus } from "./provider-status.tsx";

const drafts = new Map<string, Draft>();
const pendingSends = new Set<string>();
const dismissedSuggestions = new Set<string>();
const skippedCompactions = new Set<string>();
interface FanoutAttempt {
  readonly projectId: ProjectId;
  readonly draft: Draft;
  readonly text: string;
  readonly context?: OrchestrationMessageContext;
  readonly targets: ReadonlyArray<FanoutTarget>;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly runtimeMode: RuntimeMode;
}
const fanoutAttempts = new Map<string, FanoutAttempt>();
const queuedAttachmentEdits = new Map<
  string,
  {
    retained: ReadonlyArray<ChatAttachment>;
    local: ReadonlyArray<import("../runtime/attachments.ts").LocalAttachment>;
  }
>();
const queuedAttachmentSends = new Set<string>();
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
  let panel: Renderable | undefined;
  const [panelWidth, setPanelWidth] = createSignal(dimensions().width);
  const measurePanel = () => {
    if (panel && !panel.isDestroyed && panel.width > 0) setPanelWidth(panel.width);
  };
  const compactControls = () => panelWidth() < 95;
  const environmentId = props.state()?.environmentId;
  const destinationThreadId = props.projection().thread.id;
  let disposed = false;
  const persistence = draftStore(props.client.localStateDirectory, (message) =>
    props.ui.notify(message, true),
  );
  const initialDraft = drafts.get(props.scope) ??
    persistence.get(props.scope) ?? {
      text: "",
      mentions: [],
      context: [],
      attachments: [],
      freshContext: false,
    };
  const [draft, setDraft] = createSignal(initialDraft.text);
  const [mentions, setMentions] = createSignal(initialDraft.mentions);
  const [context, setContext] = createSignal(initialDraft.context);
  const [attachments, setAttachments] = createSignal(initialDraft.attachments);
  const [freshContext, setFreshContext] = createSignal(initialDraft.freshContext);
  let lastComposerText = initialDraft.text;
  const [sending, setSending] = createSignal(pendingSends.has(props.scope));
  const [preferences, setPreferences] = createSignal(props.client.preferences());
  onCleanup(props.client.subscribePreferences(setPreferences));
  const [loadingHistory, setLoadingHistory] = createSignal(false);
  const [requestFocus, setRequestFocus] = createSignal(false);
  const [expandWork, setExpandWork] = createSignal(false);
  const [following, setFollowing] = createSignal(true);
  const [compactionRevision, setCompactionRevision] = createSignal(0);
  const [skipCompaction, setSkipCompaction] = createSignal(skippedCompactions.has(props.scope));
  const [fanoutRevision, setFanoutRevision] = createSignal(0);
  const [suggestion, setSuggestion] = createSignal<OrchestrationV2PromptSuggestion>(null);
  const [dismissedSuggestion, setDismissedSuggestion] = createSignal<string | null>(null);
  const [findQuery, setFindQuery] = createSignal("");
  const [findResult, setFindResult] = createSignal<OrchestrationV2SearchThreadResult | null>(null);
  const [finding, setFinding] = createSignal(false);
  let findGeneration = 0;
  const [retryingPreparation, setRetryingPreparation] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  let composer: TextareaRenderable | undefined;
  let history: ScrollBoxRenderable | undefined;
  const rows = new Map<string, Renderable>();
  const thread = () => props.projection().thread;
  const queue = createMemo(() => deriveThreadQueueWorkflowState(props.projection()));
  const canSteer = createMemo(() => {
    const active = queue().activeRun;
    if (!active || freshContext()) return false;
    const projection = props.projection();
    const compactItems = projection.visibleTurnItems.filter(
      ({ item }) => item.runId === active.id && item.type === "compaction",
    );
    const activeMessage = projection.messages.find(
      (message) => message.id === active.userMessageId,
    );
    const compactCommandIsActive =
      activeMessage !== undefined &&
      isCompactionCommandMessage(activeMessage) &&
      !compactItems.some(({ item }) => !["running", "pending", "waiting"].includes(item.status));
    return (
      queue().canPromoteToSteer &&
      !compactionBlocksSteering({
        compactCommandIsActive,
        compactionRunning: compactItems.some(({ item }) => item.status === "running"),
        steersDuringCompaction: threadSteersDuringCompaction(projection),
        run: active,
        messages: projection.messages,
      })
    );
  });
  const pending = createMemo(() => derivePendingThreadRequests(props.projection()));
  const retryablePreparation = createMemo(() => [
    ...workspacePreparationRetryRunIds(props.projection().runs, props.projection().turnItems),
  ]);
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
  const linkRequests = createMemo(() =>
    props
      .projection()
      .visibleTurnItems.flatMap((entry) =>
        entry.visibility === "local" &&
        entry.item.type === "link_request" &&
        entry.item.linkStatus === "pending"
          ? [entry.item]
          : [],
      ),
  );
  const pendingCount = () =>
    pending().approvals.length +
    pending().userInputs.length +
    secretRequests().length +
    linkRequests().length;
  createEffect(() => {
    if (
      props.state()?.config?.settings.promptSuggestionsEnabled !== true ||
      props.state()?.environmentId !== environmentId
    )
      return;
    const stop = subscribe(
      props.client,
      ORCHESTRATION_V2_WS_METHODS.subscribePromptSuggestion,
      { threadId: destinationThreadId },
      setSuggestion,
    );
    onCleanup(stop);
  });
  const offeredSuggestion = createMemo(() => {
    const latestRunId = props
      .state()
      ?.shell?.threads.find((value) => value.id === destinationThreadId)?.latestRunId;
    const value = promptSuggestionForLatestRun(suggestion(), latestRunId, props.projection().runs);
    const key = value ? `${props.scope}/${value.runId}` : null;
    return value &&
      key !== dismissedSuggestion() &&
      !dismissedSuggestions.has(key!) &&
      !draft().trim() &&
      attachments().length === 0 &&
      !freshContext() &&
      !queue().activeRun
      ? value
      : null;
  });
  const dismissSuggestion = () => {
    const value = offeredSuggestion();
    if (!value) return;
    const key = `${props.scope}/${value.runId}`;
    dismissedSuggestions.add(key);
    if (dismissedSuggestions.size > 500)
      dismissedSuggestions.delete(dismissedSuggestions.values().next().value!);
    setDismissedSuggestion(key);
  };
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
  const conversationStatus = createConversationStatus(props);
  const StatusBanners = conversationStatus.Banners;
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
  createEffect(() => {
    compactionRevision();
    const config = props.state()?.config;
    if (
      !config ||
      queue().activeRun ||
      resolveIdleCompaction(config.settings, thread().modelSelection.instanceId) === "off"
    )
      return;
    const timer = Effect.runFork(
      Effect.sleep("1 minute").pipe(
        Effect.andThen(Effect.sync(() => setCompactionRevision((value) => value + 1))),
      ),
    );
    onCleanup(() => {
      Effect.runFork(Fiber.interrupt(timer));
    });
  });
  const compactTokens = createMemo(() => {
    compactionRevision();
    const config = props.state()?.config;
    if (!config || freshContext() || skipCompaction()) return null;
    return compactBeforeSendTokens({
      projection: props.projection(),
      visibleTurnItems: props.projection().visibleTurnItems,
      selection: thread().modelSelection,
      providers: config.providers,
      settings: config.settings,
      text: draft(),
      threadIdle: !queue().activeRun,
      now: DateTime.formatIso(DateTime.nowUnsafe()),
    });
  });
  const captureDraft = (): Draft => ({
    text: composer && !composer.isDestroyed ? composer.plainText : draft(),
    mentions: mentions(),
    context: context(),
    attachments: attachments(),
    freshContext: freshContext(),
  });
  const saveDraft = () => {
    const value = captureDraft();
    drafts.set(props.scope, value);
    persistence.save(props.scope, value);
  };
  const setText = (value: string) => {
    lastComposerText = value;
    composer?.setText(value);
    setDraft(value);
    const next = {
      text: value,
      mentions: mentions(),
      context: context(),
      attachments: attachments(),
      freshContext: freshContext(),
    };
    drafts.set(props.scope, next);
    persistence.save(props.scope, next);
  };
  const owner = {
    apply: (value: Draft) => {
      setMentions(value.mentions);
      setContext(value.context);
      setAttachments(value.attachments);
      setFreshContext(value.freshContext);
      setText(value.text);
    },
    settled: () => setSending(false),
  };
  draftOwners.set(props.scope, owner);
  void persistence.ready
    .then(() => {
      const recovered = persistence.get(props.scope);
      if (!disposed && !drafts.has(props.scope) && recovered) owner.apply(recovered);
    })
    .catch(() => undefined);
  onCleanup(() => {
    if (drafts.has(props.scope) || hasDraftContent(captureDraft())) saveDraft();
    void persistence
      .flush()
      .catch((error: unknown) =>
        props.ui.notify(
          error instanceof Error ? error.message : "Could not save the conversation draft.",
          true,
        ),
      );
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
  function addContext() {
    contextActions(
      props,
      (record) => {
        const text = composer?.plainText ?? draft();
        const active = referencedDraftContext(text, context());
        if (active.length + mentions().length >= COMPOSER_CONTEXT_MAX_RECORDS)
          throw new Error("Remove some message context before adding more.");
        setContext([...active.filter((value) => value.contextId !== record.contextId), record]);
        if (
          !collectComposerContextReferences(text).some(
            (value) => value.contextId === record.contextId,
          )
        )
          setText(
            `${text}${text && !/\s$/.test(text) ? " " : ""}${formatComposerContextReference(record)} `,
          );
        else saveDraft();
      },
      () =>
        !disposed &&
        !sending() &&
        props.state()?.environmentId === environmentId &&
        props.state()?.thread?.thread.id === destinationThreadId,
    );
  }
  function contextMenu() {
    props.ui.choose("Message context", [
      { title: "Add context…", run: addContext },
      ...referencedDraftContext(composer?.plainText ?? draft(), context()).map((record) => ({
        title: `Remove ${record.label}`,
        description: record.kind,
        run: () => {
          let text = composer?.plainText ?? draft();
          for (const reference of collectComposerContextReferences(text).toReversed())
            if (reference.contextId === record.contextId)
              text = text.slice(0, reference.start) + text.slice(reference.end);
          setContext((values) => values.filter((value) => value.contextId !== record.contextId));
          setText(text);
        },
      })),
    ]);
  }
  const findEntry = (entryId: string) =>
    props
      .projection()
      .visibleTurnItems.find(
        (entry) =>
          entry.sourceItemId === entryId ||
          entry.item.id === entryId ||
          ((entry.item.type === "user_message" || entry.item.type === "assistant_message") &&
            entry.item.messageId === entryId),
      );
  async function findInThread(query: string, index = 0) {
    const generation = ++findGeneration;
    const current = () =>
      !disposed &&
      findGeneration === generation &&
      props.state()?.environmentId === environmentId &&
      props.state()?.thread?.thread.id === destinationThreadId;
    if (!current()) throw new Error("Return to this conversation to search it.");
    const value = query.trim();
    if (!value || value.length > 200)
      throw new Error("Enter a search phrase of at most 200 characters.");
    setFindQuery(value);
    setFindResult(null);
    setFinding(true);
    try {
      const result = await request(props.client, ORCHESTRATION_V2_WS_METHODS.searchThread, {
        threadId: destinationThreadId,
        query: value,
        index,
      });
      if (!current()) return;
      setFindResult(result);
      const match = result.match;
      if (!match) return;
      setFollowing(false);
      if (!findEntry(match.entryId)) {
        const loaded = await props.client.loadEarlier(match.entryId);
        if (loaded._tag === "error") throw new Error(loaded.message);
      }
      if (!current()) return;
      const entry = findEntry(match.entryId);
      if (!entry)
        throw new Error("This match is not available in the loaded conversation history.");
      const box = history;
      box?.afterLayout(() => {
        const node = rows.get(`${entry.sourceThreadId}/${entry.sourceItemId}`);
        if (current() && box && !box.isDestroyed && node && !node.isDestroyed)
          box.scrollChildIntoView(node, { align: "nearest", inset: 1 });
      });
    } finally {
      if (current()) setFinding(false);
    }
  }
  function findPrompt() {
    props.ui.form({
      title: "Find in conversation",
      fields: [{ name: "query", label: "Words or phrase", value: findQuery(), required: true }],
      submitLabel: "Find",
      onSubmit: async ({ query = "" }) => findInThread(query),
    });
  }
  function stepFind(delta: number) {
    const current = findResult();
    if (!current?.totalMatches || finding()) return;
    const index = (current.activeIndex + delta + current.totalMatches) % current.totalMatches;
    void props.ui.run(() => findInThread(findQuery(), index));
  }
  function closeFind() {
    findGeneration += 1;
    setFindResult(null);
    setFinding(false);
  }
  function savedPrompts() {
    const guard = () => {
      if (
        disposed ||
        props.state()?.environmentId !== environmentId ||
        props.state()?.thread?.thread.id !== destinationThreadId
      )
        throw new Error("Return to the original conversation to change its draft.");
    };
    void props.ui.run(async () => {
      await persistence.refresh();
      guard();
      props.ui.choose("Saved prompts", [
        {
          title: "Save current prompt…",
          description: "Keep this draft aside, including its local attachments and context.",
          run: () => {
            guard();
            if (sending()) {
              props.ui.notify("Wait until the current message finishes sending.");
              return;
            }
            const captured = captureDraft();
            if (!hasDraftContent(captured)) {
              props.ui.notify("Write a prompt or attach a file first.");
              return;
            }
            drafts.set(props.scope, captured);
            props.ui.form({
              title: "Save prompt",
              fields: [
                {
                  name: "label",
                  label: "Name",
                  value: captured.text.trim().split("\n")[0]?.slice(0, 120) || "Saved prompt",
                  required: true,
                },
              ],
              submitLabel: "Save aside",
              onSubmit: async ({ label = "" }) => {
                guard();
                persistence.stashDraft({
                  id: SecureRandom.uuidV4Unsafe(),
                  scope: props.scope,
                  label: label.trim().slice(0, 200),
                  draft: captured,
                });
                await persistence.flush();
                if (!disposed && drafts.get(props.scope) === captured)
                  owner.apply({
                    text: "",
                    mentions: [],
                    context: [],
                    attachments: [],
                    freshContext: false,
                  });
                props.ui.notify("Prompt saved. Restore it from /stash.");
              },
            });
          },
        },
        ...persistence.stash().map((entry) => ({
          title: entry.label,
          description:
            entry.scope === props.scope
              ? "Saved in this conversation"
              : "Saved in another conversation; copy text only",
          run: () =>
            props.ui.choose(entry.label, [
              {
                title: "Copy into composer",
                run: () => {
                  const restore = async () => {
                    guard();
                    if (sending())
                      throw new Error("Wait until the current message finishes sending.");
                    owner.apply(
                      entry.scope === props.scope
                        ? entry.draft
                        : {
                            text: entry.draft.text,
                            mentions: [],
                            context: [],
                            attachments: [],
                            freshContext: false,
                          },
                    );
                    props.ui.notify(
                      "Saved prompt copied. The saved copy is retained until you delete it.",
                    );
                  };
                  if (hasDraftContent(captureDraft()))
                    props.ui.confirm(
                      "Replace current draft?",
                      "The saved prompt replaces your current unsent draft.",
                      restore,
                      "Replace draft",
                    );
                  else void props.ui.run(restore);
                },
              },
              {
                title: "Delete saved prompt",
                run: () =>
                  props.ui.confirm(
                    "Delete saved prompt?",
                    entry.label,
                    async () => {
                      guard();
                      persistence.removeStash(entry.id);
                      await persistence.flush();
                    },
                    "Delete saved prompt",
                  ),
              },
            ]),
        })),
      ]);
    });
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
    if (pending().approvals.length + pending().userInputs.length + linkRequests().length === 0) {
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
  const loadWork = async (entry: OrchestrationV2ProjectedTurnItem) => {
    if (disposed || props.state()?.environmentId !== environmentId)
      throw new Error("Return to the original conversation to load its work.");
    const box = history;
    const row = rows.get(`${entry.sourceThreadId}/${entry.sourceItemId}`);
    const release = box && row && !row.isDestroyed ? box.anchor(row) : undefined;
    try {
      await props.client.loadWork(entry);
    } finally {
      if (box && !box.isDestroyed) box.afterLayout(() => release?.());
      else release?.();
    }
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
      if (value.type === "proposed_plan") {
        if (disposed) return;
        planActions(
          props,
          value.markdown,
          () => {
            const result = copyTerminalText(renderer, value.markdown);
            props.ui.notify(result.message, !result.attempted);
          },
          () => !disposed && props.state()?.environmentId === environmentId,
        );
        return;
      }
      props.ui.text(
        value.title ?? value.type.replaceAll("_", " "),
        turnItemText(value),
        value.type === "assistant_message"
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
      ...retryablePreparation().map((runId) => ({
        title: "Retry workspace setup",
        description: `Failed turn ${runId}`,
        run: () => retryPreparation(runId),
      })),
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
  function retryPreparation(runId: OrchestrationV2ThreadProjection["runs"][number]["id"]) {
    if (retryingPreparation().has(runId)) return;
    const threadId = destinationThreadId;
    setRetryingPreparation((values) => new Set([...values, runId]));
    void props.ui.run(async () => {
      try {
        await command({ type: "prepared-run.retry", commandId: id(), threadId, runId });
      } finally {
        setRetryingPreparation((values) => new Set([...values].filter((value) => value !== runId)));
      }
    });
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
            { title: "Manage attachments…", run: () => queuedAttachments(queued) },
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
              title: current.promoteSkipsCompaction
                ? "Skip compaction and send this message"
                : "Steer the current turn",
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
  function queuedAttachments(
    queued: ReturnType<typeof deriveThreadQueueWorkflowState>["queuedRuns"][number],
  ) {
    const key = `${props.scope}/${queued.run.id}`;
    const guard = () => {
      if (
        disposed ||
        props.state()?.environmentId !== environmentId ||
        props.state()?.thread?.thread.id !== destinationThreadId
      )
        throw new Error("Return to the original conversation to edit its queued attachments.");
      if (queuedAttachmentSends.has(key))
        throw new Error("Wait for this queued message's attachment changes to finish.");
    };
    let edit = queuedAttachmentEdits.get(key) ?? { retained: queued.attachments, local: [] };
    const show = () =>
      props.ui.choose("Queued message attachments", [
        {
          title: "Apply attachment changes",
          description: `${edit.retained.length} retained · ${edit.local.length} new local files`,
          run: () =>
            void props.ui.run(async () => {
              guard();
              if (!queued.text.trim() && edit.retained.length + edit.local.length === 0)
                throw new Error("Keep some text or an attachment in the queued message.");
              queuedAttachmentSends.add(key);
              try {
                await props.client.editQueuedMessage(
                  destinationThreadId,
                  queued.run.id,
                  queued.text,
                  edit.retained,
                  edit.local,
                  queued.context,
                );
                queuedAttachmentEdits.delete(key);
                props.ui.notify("Queued message attachments updated.");
              } finally {
                queuedAttachmentSends.delete(key);
              }
            }),
        },
        {
          title: "Add or remove local files…",
          run: () =>
            attachmentActions(
              props,
              edit.local,
              (next) => {
                guard();
                if (edit.retained.length + next.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
                  throw new Error(
                    `Keep at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments in this message.`,
                  );
                if (environmentId)
                  props.client.releaseLocalAttachments(
                    environmentId,
                    edit.local.filter((value) => !next.some((kept) => kept.id === value.id)),
                  );
                edit = { ...edit, local: next };
                queuedAttachmentEdits.set(key, edit);
                props.ui.notify(
                  "Attachment changes are ready. Reopen this queued message's attachments and apply them.",
                );
              },
              () =>
                !disposed &&
                props.state()?.environmentId === environmentId &&
                props.state()?.thread?.thread.id === destinationThreadId &&
                !queuedAttachmentSends.has(key),
            ),
        },
        ...edit.retained.map((attachment) => ({
          title: `Remove ${attachment.name}`,
          run: () => {
            guard();
            edit = {
              ...edit,
              retained: edit.retained.filter((value) => value.id !== attachment.id),
            };
            queuedAttachmentEdits.set(key, edit);
            show();
          },
        })),
        ...(edit.retained.length + edit.local.length
          ? [
              {
                title: "Remove all attachments",
                run: () => {
                  guard();
                  if (environmentId)
                    props.client.releaseLocalAttachments(environmentId, edit.local);
                  edit = { retained: [], local: [] };
                  queuedAttachmentEdits.set(key, edit);
                  show();
                },
              },
            ]
          : []),
      ]);
    show();
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
    {
      title: "/status",
      description: "Provider setup, errors, usage recovery and dismissed notices",
      run: conversationStatus.openActions,
    },
    {
      title: "/links",
      description: "Open file and browser links from a message",
      run: () =>
        props.ui.choose(
          "Choose a message",
          props
            .projection()
            .visibleTurnItems.filter(
              (entry) =>
                entry.item.type === "user_message" || entry.item.type === "assistant_message",
            )
            .map((entry) => ({
              title: turnItemText(entry.item).slice(0, 100),
              run: () => messageLinkActions(props, entry),
            })),
        ),
    },
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
    { title: "/find", description: "Find text in this conversation", run: findPrompt },
    { title: "/attach", description: "Attach a local image or file", run: attach },
    {
      title: "/stash",
      description: "Save this draft aside or restore a saved prompt",
      run: savedPrompts,
    },
    { title: "/mention", description: "Add file context from the workspace", run: () => mention() },
    {
      title: "/context",
      description: "Add response, thread, environment, terminal or review context",
      run: contextMenu,
    },
    ...(props.state()?.config?.environment.capabilities.freshContext
      ? [
          {
            title: "/clear",
            description: "Start a fresh session with your next message",
            run: () => {
              setFreshContext(true);
              saveDraft();
            },
          },
        ]
      : []),
    ...((workspaceProvider()?.slashCommands ?? provider()?.slashCommands ?? []).some(
      (value) => value.name.replace(/^\//, "") === "compact",
    )
      ? [
          {
            title: "/compact",
            description: "Compact this provider's context",
            run: () => {
              void props.ui.run(() => props.client.send("/compact"));
            },
          },
        ]
      : []),
    {
      title: "/stop",
      description: "Interrupt the current turn",
      run: () => {
        void props.ui.run(() => props.client.interrupt());
      },
    },
    ...(workspaceProvider()?.slashCommands ?? provider()?.slashCommands ?? [])
      .filter((value) => value.name.replace(/^\//, "") !== "compact")
      .map((value) => ({
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
      slashChoices()
        .filter((value) => value.title.startsWith(prefix.startsWith("/") ? prefix : "/"))
        .map((value) => ({
          ...value,
          run: () => {
            if (!value.category) setText("");
            value.run();
          },
        })),
    );
  }
  async function send(delivery?: "queue" | "steer" | "restart") {
    const text = composer?.plainText ?? draft();
    if ((!text.trim() && attachments().length === 0) || sending()) return;
    if (delivery === "steer" && !canSteer())
      throw new Error("This turn cannot take steering input. Queue the message instead.");
    const local = slashChoices().find((value) => value.title === text.trim() && !value.category);
    if (local && (local.title !== "/clear" || attachments().length === 0)) {
      setText("");
      local.run();
      return;
    }
    const scope = props.scope;
    const { text: outgoingText, records } = resolveFileMentions(text, mentions());
    const captured = {
      text,
      mentions: mentions(),
      context: context(),
      attachments: attachments(),
      freshContext: freshContext(),
    };
    pendingSends.add(scope);
    setSending(true);
    try {
      await props.client.send(outgoingText, {
        ...(captured.freshContext ? { freshContext: true } : {}),
        ...(compactTokens() !== null && !captured.freshContext ? { compactBeforeSend: true } : {}),
        ...(delivery
          ? { dispatchMode: delivery }
          : queue().activeRun
            ? {
                dispatchMode:
                  preferences().followUpMode === "steer" && canSteer()
                    ? ("steer" as const)
                    : ("queue" as const),
              }
            : {}),
        ...(captured.attachments.length > 0 ? { localAttachments: captured.attachments } : {}),
        ...(records.length > 0 || captured.context.length > 0
          ? {
              context: {
                version: 1 as const,
                records: [...records, ...referencedDraftContext(outgoingText, captured.context)],
              },
            }
          : {}),
      });
      const current = drafts.get(scope) ?? captured;
      const unchanged = current.text === captured.text;
      const next = settleSentDraft(current, captured);
      drafts.set(scope, next);
      persistence.save(scope, next);
      skippedCompactions.delete(scope);
      setSkipCompaction(false);
      draftOwners.get(scope)?.apply(next);
      if (!disposed && unchanged) goBottom();
    } finally {
      pendingSends.delete(scope);
      draftOwners.get(scope)?.settled();
    }
  }
  function fanoutResults(attempt: FanoutAttempt) {
    props.ui.choose(
      "Multi-model conversations",
      attempt.targets.map((target) => ({
        title: target.selection.model,
        description:
          target.status === "started"
            ? "Started · Open conversation"
            : (target.error ?? "Starting…"),
        run: () => {
          if (target.status === "started") props.ui.openThread(target.threadId);
          else
            props.ui.text(
              target.selection.model,
              target.error ?? "This conversation has not started.",
            );
        },
      })),
    );
  }
  async function launchFanout(attempt: FanoutAttempt) {
    if (
      disposed ||
      props.state()?.environmentId !== environmentId ||
      props.state()?.thread?.thread.id !== destinationThreadId
    )
      throw new Error("Return to the original conversation to send to multiple models.");
    if (sending()) return;
    const scope = props.scope;
    pendingSends.add(scope);
    setSending(true);
    try {
      await startFanoutTargets(
        attempt.targets,
        async (target) => {
          if (props.state()?.environmentId !== environmentId)
            throw new Error("The environment changed before this model was started.");
          return props.client.createThread(
            attempt.projectId,
            attempt.text.trim().split("\n")[0]?.slice(0, 120) || "New conversation",
            attempt.text,
            {
              modelSelection: target.selection,
              runtimeMode: attempt.runtimeMode,
              threadId: target.threadId,
              commandId: target.commandId,
              messageId: target.messageId,
              workspaceStrategy: {
                type: "worktree",
                baseRef: attempt.baseRef,
                startFromOrigin: attempt.startFromOrigin,
              },
              ...(attempt.context ? { context: attempt.context } : {}),
              ...(attempt.draft.attachments.length
                ? { localAttachments: attempt.draft.attachments }
                : {}),
            },
          );
        },
        () => {
          if (!disposed) setFanoutRevision((value) => value + 1);
        },
      );
      const failed = attempt.targets.filter((target) => target.status !== "started").length;
      if (!failed) {
        const next = settleSentDraft(drafts.get(scope) ?? attempt.draft, attempt.draft);
        drafts.set(scope, next);
        persistence.save(scope, next);
        draftOwners.get(scope)?.apply(next);
      }
      props.ui.notify(
        `${attempt.targets.length - failed} conversations started${failed ? `; ${failed} failed. Draft retained; use F2 to retry failed models.` : "."}`,
        failed > 0,
      );
      if (
        !disposed &&
        props.state()?.environmentId === environmentId &&
        props.state()?.thread?.thread.id === destinationThreadId
      )
        fanoutResults(attempt);
    } finally {
      pendingSends.delete(scope);
      draftOwners.get(scope)?.settled();
    }
  }
  function chooseFanoutModels() {
    if (sending()) {
      props.ui.notify("Wait for the current message to finish sending.");
      return;
    }
    const selected = new Map<string, ModelSelection>();
    const initial = thread().modelSelection;
    const selectionKey = (selection: ModelSelection) =>
      `${selection.instanceId}/${selection.model}`;
    selected.set(selectionKey(initial), initial);
    const show = () =>
      props.ui.choose("Send to multiple models", [
        {
          title: `Start ${selected.size} separate conversation${selected.size === 1 ? "" : "s"}`,
          description: "Each model receives this prompt in its own worktree.",
          run: () => {
            const captured = captureDraft();
            if (!captured.text.trim() && !captured.attachments.length) {
              props.ui.notify("Write a prompt or attach a file first.");
              return;
            }
            if (!selected.size) {
              props.ui.notify("Choose at least one model.");
              return;
            }
            const currentProject = project();
            if (!currentProject) {
              props.ui.notify("Select a project before sending to multiple models.", true);
              return;
            }
            const resolved = resolveFileMentions(captured.text, captured.mentions);
            const records = [
              ...resolved.records,
              ...referencedDraftContext(resolved.text, captured.context),
            ];
            const attempt: FanoutAttempt = {
              projectId: currentProject.id,
              draft: captured,
              text: resolved.text,
              targets: createFanoutTargets([...selected.values()]),
              baseRef: thread().branch ?? "HEAD",
              startFromOrigin: props.state()?.config?.settings.newWorktreesStartFromOrigin ?? true,
              runtimeMode: thread().runtimeMode,
              ...(records.length ? { context: { version: 1, records } } : {}),
            };
            props.ui.confirm(
              "Send to multiple models?",
              `Start ${selected.size} separate conversations, each in its own worktree. This sends a real agent turn to every selected model.`,
              async () => {
                fanoutAttempts.set(props.scope, attempt);
                await launchFanout(attempt);
              },
              "Start conversations",
            );
          },
        },
        ...selectableModels(
          props.state()?.config?.providers ?? [],
          props.state()?.config?.settings,
          initial,
        ).map(({ provider: instance, model, favorite }) => {
          const selection: ModelSelection = {
            instanceId: instance.instanceId,
            model: model.slug,
          };
          const key = selectionKey(selection);
          return {
            title: `${selected.has(key) ? "✓ " : ""}${favorite ? "★ " : ""}${model.name}`,
            category: instance.displayName ?? instance.driver,
            run: () => {
              if (selected.has(key)) selected.delete(key);
              else selected.set(key, selection);
              show();
            },
          };
        }),
      ]);
    show();
  }
  function deliveryMenu() {
    fanoutRevision();
    const choices: Choice[] = [
      {
        title: queue().activeRun ? "Queue after current turn" : "Send message",
        run: () => {
          void props.ui.run(() => send(queue().activeRun ? "queue" : undefined));
        },
      },
      {
        title: "Send to multiple models…",
        description: "Start separate conversations and worktrees",
        run: chooseFanoutModels,
      },
    ];
    const attempt = fanoutAttempts.get(props.scope);
    if (attempt) {
      if (attempt.targets.some((target) => target.status !== "started"))
        choices.push({
          title: "Retry failed model launches",
          description:
            "Only failed selections are retried, using their original submission identities.",
          run: () => void props.ui.run(() => launchFanout(attempt)),
        });
      choices.push({
        title: "Multi-model conversation results",
        run: () => fanoutResults(attempt),
      });
    }
    if (canSteer())
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
    if (!requestFocus() && key.ctrl && key.name === "f") {
      key.preventDefault();
      findPrompt();
    }
    if (!requestFocus() && key.ctrl && key.name === "g" && findResult()) {
      key.preventDefault();
      stepFind(key.shift ? -1 : 1);
    }
    if (!requestFocus() && key.name === "escape" && findResult()) {
      key.preventDefault();
      closeFind();
      return;
    }
    if (!requestFocus() && key.name === "escape" && offeredSuggestion()) {
      key.preventDefault();
      dismissSuggestion();
    }
    if (!requestFocus() && key.name === "tab" && !key.shift && offeredSuggestion()) {
      key.preventDefault();
      key.stopPropagation();
      const value = offeredSuggestion()!;
      dismissSuggestion();
      setText(value.text);
      return;
    }
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
    if (!requestFocus() && key.name === "f4") {
      key.preventDefault();
      savedPrompts();
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
    <box
      ref={(node) => {
        panel = node;
        measurePanel();
      }}
      onSizeChange={measurePanel}
      flexGrow={1}
      minWidth={0}
      minHeight={0}
      onMouseDown={props.onFocus}
    >
      <Show when={findQuery() && (findResult() || finding())}>
        <box height={1} paddingX={1} flexDirection="row" gap={2}>
          <text
            selectable={false}
            fg={theme.textMuted}
            flexGrow={1}
            truncate
            onMouseDown={findPrompt}
          >{`Find: ${findQuery()} · ${finding() ? "Searching…" : findResult()?.totalMatches ? `${findResult()!.activeIndex + 1}/${findResult()!.totalMatches}` : "No matches"}`}</text>
          <text selectable={false} fg={theme.primary} onMouseDown={() => stepFind(-1)}>
            Previous
          </text>
          <text selectable={false} fg={theme.primary} onMouseDown={() => stepFind(1)}>
            Next ^G
          </text>
          <text selectable={false} fg={theme.textMuted} onMouseDown={closeFind}>
            Close
          </text>
        </box>
      </Show>
      <StatusBanners />
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
        contentOptions={{ paddingX: 1 }}
      >
        <Show when={props.state()?.hasMoreHistory}>
          <text selectable={false} fg={theme.primary} onMouseDown={loadEarlier}>
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
                selectable={false}
                fg={theme.primary}
                onMouseDown={() => setText("Explain how this project is organized.")}
              >
                Explore this project
              </text>
              <text
                selectable={false}
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
          cwd={cwd()}
          onOpenLinks={(entry) => messageLinkActions(props, entry)}
          projection={props.projection()}
          hidePendingRequests
          wordWrap={preferences().wordWrap}
          timestampFormat={preferences().timestampFormat}
          expandAll={expandWork()}
          highlightedEntryId={findResult()?.match?.entryId}
          onOpenItem={openItem}
          onLoadWork={loadWork}
          onCommandOutput={
            props.state()?.config?.environment.capabilities.commandOutputStreaming
              ? (entry, onFrame, onError) => {
                  if (disposed || props.state()?.environmentId !== environmentId) {
                    onError(new Error("Return to the command's environment to view its output."));
                    return () => {};
                  }
                  return subscribe(
                    props.client,
                    ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
                    { threadId: entry.sourceThreadId, itemId: entry.sourceItemId },
                    onFrame,
                    onError,
                  );
                }
              : undefined
          }
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
        <text selectable={false} fg={theme.primary} onMouseDown={goBottom}>
          ↓ Latest messages
        </text>
      </Show>
      <Show when={queue().queuedRuns.length > 0}>
        <box backgroundColor={theme.backgroundPanel} paddingX={1}>
          <text
            selectable={false}
            fg={theme.textMuted}
            onMouseDown={queueActions}
          >{`${queue().isHeld ? "Ⅱ Queue paused" : "Queued"} · ${queue().queuedRuns.length} message${queue().queuedRuns.length === 1 ? "" : "s"} · Ctrl+J manage`}</text>
          <For each={queue().queuedRuns.slice(0, 2)}>
            {(value, index) => (
              <text
                selectable={false}
                fg={theme.textMuted}
                truncate
                onMouseDown={queueActions}
              >{`${index() + 1}. ${value.text.replaceAll("\n", " ")}`}</text>
            )}
          </For>
        </box>
      </Show>
      <For each={retryablePreparation()}>
        {(runId) => (
          <text
            selectable={false}
            fg={theme.warning}
            paddingX={1}
            onMouseDown={() => retryPreparation(runId)}
          >
            {retryingPreparation().has(runId)
              ? "Retrying workspace setup…"
              : "Workspace setup failed · Retry setup"}
          </text>
        )}
      </For>
      <Show when={freshContext()}>
        <text
          selectable={false}
          fg={theme.primary}
          paddingX={1}
          onMouseDown={() => {
            setFreshContext(false);
            saveDraft();
          }}
        >
          Next message starts a fresh session · Undo
        </text>
      </Show>
      <Show when={compactTokens()}>
        {(tokens) => (
          <text
            selectable={false}
            fg={theme.textMuted}
            paddingX={1}
            truncate
            onMouseDown={() => {
              skippedCompactions.add(props.scope);
              setSkipCompaction(true);
            }}
          >
            {`When you return: compact ${tokens().toLocaleString()} tokens before sending · Skip once`}
          </text>
        )}
      </Show>
      <Show when={offeredSuggestion()}>
        {(value) => (
          <text
            selectable={false}
            fg={theme.textMuted}
            paddingX={1}
            height={1}
            truncate
            onMouseDown={() => {
              dismissSuggestion();
              setText(value().text);
            }}
          >
            {`Suggestion: ${value().text} · Tab to use · Esc dismiss`}
          </text>
        )}
      </Show>
      <box flexDirection="row" paddingX={1} height={1}>
        <text
          selectable={false}
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
            selectable={false}
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
        marginTop={dimensions().height < 24 ? 0 : 1}
        paddingX={1}
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
          <text selectable={false} fg={theme.textMuted} truncate onMouseDown={attach}>
            {attachments()
              .map((value) => `${value.type === "image" ? "▧" : "▤"} ${value.name}`)
              .join("   ")}{" "}
            · F3 manage
          </text>
        </Show>
        <Show when={referencedDraftContext(draft(), context()).length > 0}>
          <text selectable={false} fg={theme.textMuted} truncate onMouseDown={contextMenu}>
            {referencedDraftContext(draft(), context())
              .map((record) => record.label)
              .join(" · ")}{" "}
            · Manage context
          </text>
        </Show>
        <textarea
          ref={(node) => {
            composer = node;
          }}
          initialValue={initialDraft.text}
          focused={props.focused && !props.ui.modal() && !requestFocus()}
          minHeight={dimensions().height < 30 ? 1 : 2}
          maxHeight={dimensions().height < 30 ? 5 : 7}
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
            if (composer.plainText === lastComposerText) return;
            lastComposerText = composer.plainText;
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
        <box flexDirection="row" height={1} gap={1} marginTop={dimensions().height < 30 ? 0 : 1}>
          <text
            selectable={false}
            flexShrink={0}
            fg={thread().interactionMode === "plan" ? theme.primary : theme.textMuted}
            onMouseDown={togglePlan}
          >
            {thread().interactionMode === "plan" ? "Plan" : "Build"}
          </text>
          <text
            selectable={false}
            fg={theme.text}
            onMouseDown={props.ui.chooseModel}
            flexGrow={1}
            minWidth={0}
            height={1}
            flexShrink={1}
            maxWidth={compactControls() ? "100%" : Math.max(12, Math.floor(panelWidth() * 0.3))}
            truncate
          >
            {thread().modelSelection.model}
          </text>
          <Show
            when={!compactControls()}
            fallback={
              <text
                selectable={false}
                flexShrink={0}
                fg={theme.textMuted}
                onMouseDown={() =>
                  props.ui.choose("Composer actions", [
                    { title: "Attach files", run: attach },
                    { title: "Add context", run: contextMenu },
                    { title: "Saved prompts", run: savedPrompts },
                    { title: "Model options", run: options },
                    {
                      title: `Permissions: ${runtimeLabels[thread().runtimeMode]}`,
                      run: permissions,
                    },
                  ])
                }
              >
                More ▾
              </text>
            }
          >
            <text selectable={false} flexShrink={0} fg={theme.textMuted} onMouseDown={options}>
              ⚙
            </text>
            <text selectable={false} flexShrink={0} fg={theme.textMuted} onMouseDown={attach}>
              Attach
            </text>
            <text selectable={false} flexShrink={0} fg={theme.textMuted} onMouseDown={contextMenu}>
              Context
            </text>
            <text selectable={false} flexShrink={0} fg={theme.textMuted} onMouseDown={savedPrompts}>
              Saved
            </text>
            <text
              selectable={false}
              fg={theme.textMuted}
              flexGrow={1}
              minWidth={0}
              height={1}
              flexShrink={1}
              truncate
              onMouseDown={permissions}
            >
              {runtimeLabels[thread().runtimeMode]}
            </text>
          </Show>
          <text
            selectable={false}
            flexShrink={0}
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
                ? preferences().followUpMode === "steer" && canSteer()
                  ? "Steer"
                  : "Queue"
                : compactTokens() !== null
                  ? "Compact and send"
                  : preferences().sendShortcut === "ctrl-s"
                    ? "Send ^S"
                    : "Send ↵"}
          </text>
        </box>
      </box>
      <text height={1} fg={theme.textMuted} paddingX={1} truncate>
        {requestFocus()
          ? "↑↓ choose · space select · enter activate · esc compose"
          : `${preferences().sendShortcut === "ctrl-s" ? "Enter newline · Ctrl+S send" : "Alt+Enter newline"} · F2 delivery · F3 attach · F4 saved · / Tab commands`}
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
