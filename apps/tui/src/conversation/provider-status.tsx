import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { useRenderer } from "@opentui/solid";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type OrchestrationV2LimitRecoveryUpdate,
  type OrchestrationV2ThreadProjection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SecureRandom from "effect/crypto/SecureRandom";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  threadErrorSummary,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { CHATGPT_USAGE_URL, CHATGPT_WORKSPACE_ADMIN_REQUEST } from "@t3tools/shared/usageLimits";
import type { FeatureProps, Choice } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { copyTerminalText } from "../presentation/terminal.ts";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { toServerClock } from "@t3tools/client-runtime/clock";
import { providerStatusBanner } from "./provider-status.logic.ts";
import {
  threadErrorBanner,
  usageRecoveryResetDelay,
  usageRecoveryState,
} from "./error-banner.logic.ts";

const [dismissals, setDismissals] = createSignal<ReadonlySet<string>>(new Set());
function dismiss(key: string) {
  setDismissals((current) => {
    const next = new Set(current);
    next.add(key);
    if (next.size > 500) next.delete(next.values().next().value!);
    return next;
  });
}
function restore(key: string) {
  setDismissals((current) => {
    const next = new Set(current);
    next.delete(key);
    return next;
  });
}

export function createConversationStatus(
  props: FeatureProps & {
    projection: () => OrchestrationV2ThreadProjection;
  },
) {
  const renderer = useRenderer();
  const environmentId = props.state()?.environmentId;
  const threadId = props.projection().thread.id;
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const guard = () => {
    if (
      !active ||
      props.state()?.environmentId !== environmentId ||
      props.state()?.thread?.thread.id !== threadId
    )
      throw new Error("Return to the original conversation to use its status actions.");
  };
  const provider = createMemo(() =>
    props
      .state()
      ?.config?.providers.find(
        (entry) => entry.instanceId === props.projection().thread.modelSelection.instanceId,
      ),
  );
  const destination = createMemo(() => props.state()?.environmentId);
  const serverClockOffset = createMemo(() => {
    const id = props.state()?.environmentId;
    return id ? toServerClock(id, 0) : 0;
  });
  const providerId = createMemo(() => provider()?.instanceId);
  const shell = createMemo(() => {
    const value = props.state()?.shell;
    return (
      value?.threads.find((entry) => entry.id === threadId) ??
      value?.archivedThreads.find((entry) => entry.id === threadId)
    );
  });
  const providerBanner = createMemo(() => providerStatusBanner(environmentId, provider()));
  const error = createMemo(() => {
    const value = shell();
    if (value?.lastError !== undefined)
      return {
        lastError: value.lastError,
        lastErrorClass: value.lastErrorClass,
        lastErrorCode: value.lastErrorCode,
      };
    const projection = props.projection();
    return threadErrorSummary(
      latestRootProviderFailure(latestExecutedRun(projection.runs), projection.turnItems),
      null,
    );
  });
  const [deadlineRevision, setDeadlineRevision] = createSignal(0);
  const recovery = createMemo(() => {
    deadlineRevision();
    serverClockOffset();
    const pending = derivePendingThreadRequests(props.projection());
    return environmentId
      ? usageRecoveryState(
          shell(),
          environmentId,
          pending.approvals.length > 0 || pending.userInputs.length > 0,
          DateTime.formatIso(DateTime.nowUnsafe()),
        )
      : null;
  });
  const resetAt = createMemo(() => recovery()?.resetAt);
  const runId = createMemo(() => recovery()?.runId);
  const errorBanner = createMemo(() => {
    const value = error();
    const limited = recovery() !== null;
    return threadErrorBanner(
      environmentId,
      threadId,
      value.lastError || (limited ? "Usage limit reached" : null),
      limited ? "usage_limit" : value.lastErrorClass,
      value.lastErrorCode,
    );
  });
  createEffect(() => {
    serverClockOffset();
    const deadline = resetAt();
    if (!deadline || !environmentId) return;
    const remaining = usageRecoveryResetDelay(
      environmentId,
      deadline,
      DateTime.toEpochMillis(DateTime.nowUnsafe()),
    );
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = Effect.runFork(
      Effect.sleep(remaining).pipe(
        Effect.andThen(Effect.sync(() => setDeadlineRevision((value) => value + 1))),
      ),
    );
    onCleanup(() => {
      Effect.runFork(Fiber.interrupt(timer));
    });
  });
  const [canRefresh, setCanRefresh] = createSignal(false);
  const [canRecover, setCanRecover] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [savingRecovery, setSavingRecovery] = createSignal(false);
  createEffect(
    on(
      () => [destination(), providerId()] as const,
      ([destination, instanceId]) => {
        setCanRefresh(false);
        if (!destination || destination !== environmentId || !instanceId) return;
        onCleanup(
          props.client.observePermission(
            WS_METHODS.serverRefreshProviders,
            { instanceId, refreshModels: true },
            setCanRefresh,
          ),
        );
      },
    ),
  );
  createEffect(
    on(
      () => [destination(), runId(), resetAt()] as const,
      ([destination, runId, resetAt]) => {
        setCanRecover(false);
        if (!destination || destination !== environmentId || !runId || !resetAt) return;
        onCleanup(props.client.observeScope(AuthOrchestrationOperateScope, setCanRecover));
      },
    ),
  );
  const visibleProvider = () => {
    const value = providerBanner();
    return value && !dismissals().has(value.key) ? value : null;
  };
  const visibleError = () => {
    const value = errorBanner();
    return value && !dismissals().has(value.key) ? value : null;
  };
  async function refresh(instanceId: ProviderInstanceId) {
    guard();
    if (provider()?.instanceId !== instanceId || !canRefresh() || refreshing()) return;
    setRefreshing(true);
    try {
      await request(props.client, WS_METHODS.serverRefreshProviders, {
        instanceId,
        refreshModels: true,
      });
      guard();
      if (provider()?.instanceId !== instanceId) return;
      props.ui.notify("Provider status refreshed.");
    } finally {
      if (active) setRefreshing(false);
    }
  }
  function setup(instanceId: ProviderInstanceId) {
    guard();
    if (provider()?.instanceId !== instanceId) return;
    if (props.ui.openProviderSettings) props.ui.openProviderSettings(instanceId);
    else props.ui.openArea("settings");
  }
  async function changeRecovery(update: OrchestrationV2LimitRecoveryUpdate) {
    guard();
    const value = recovery();
    if (
      !environmentId ||
      !value ||
      !value.canSchedule ||
      !value.resetAt ||
      !canRecover() ||
      savingRecovery()
    )
      return;
    if (value.runId !== update.runId || value.resetAt !== update.resetAt)
      throw new Error("Usage recovery changed. Reopen status actions for the latest run.");
    if (
      update.snooze &&
      usageRecoveryResetDelay(
        environmentId,
        value.resetAt,
        DateTime.toEpochMillis(DateTime.nowUnsafe()),
      ) <= 0
    ) {
      setDeadlineRevision((previous) => previous + 1);
      throw new Error("The reset time has passed. Retry the thread manually.");
    }
    setSavingRecovery(true);
    try {
      await request(props.client, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
        type: "thread.metadata.update",
        commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
        threadId,
        limitRecovery: update,
      });
      guard();
    } finally {
      if (active) setSavingRecovery(false);
    }
  }
  const copy = (text: string) => {
    const copied = copyTerminalText(renderer, text);
    props.ui.notify(copied.message, !copied.attempted);
  };
  function openActions() {
    guard();
    const currentProvider = provider();
    const currentProviderBanner = providerBanner();
    const currentError = errorBanner();
    const fullError = error().lastError;
    const value = recovery();
    const choices: Choice[] = [
      ...(currentProvider
        ? [
            {
              title: `${currentProviderBanner?.setup ? "Set up provider" : "Provider settings"}: ${currentProvider.displayName ?? currentProvider.driver}`,
              run: () => setup(currentProvider.instanceId),
            },
          ]
        : []),
      ...(currentProvider && canRefresh()
        ? [
            {
              title: refreshing() ? "Refreshing provider…" : "Refresh provider status and models",
              run: () => void props.ui.run(() => refresh(currentProvider.instanceId)),
            },
          ]
        : []),
      ...(currentProviderBanner
        ? [
            {
              title: "Provider status details",
              run: () => props.ui.text(currentProviderBanner.title, currentProviderBanner.message),
            },
          ]
        : []),
      ...(currentError
        ? [
            {
              title: "View full error",
              run: () => props.ui.text(currentError.title, fullError ?? currentError.message),
            },
            { title: "Copy error", run: () => copy(fullError ?? currentError.message) },
            ...(currentError.workspaceLimit
              ? [
                  {
                    title: "Copy request for workspace admin",
                    run: () => copy(CHATGPT_WORKSPACE_ADMIN_REQUEST),
                  },
                ]
              : currentError.chatGptLimit
                ? [
                    {
                      title: "Manage ChatGPT usage",
                      run: () => props.ui.openBrowser?.(CHATGPT_USAGE_URL),
                    },
                  ]
                : []),
          ]
        : []),
      ...(value?.canSchedule && value.resetAt && canRecover()
        ? [
            {
              title: value.scheduled ? "Cancel auto-resume" : "Resume at reset",
              description: value.description,
              run: () =>
                void props.ui.run(() =>
                  changeRecovery({
                    runId: value.runId,
                    resetAt: value.resetAt!,
                    autoResume: !value.scheduled,
                  }),
                ),
            },
            ...(value.snoozed || !value.resetPassed
              ? [
                  {
                    title: value.snoozed ? "Wake now" : "Snooze until reset",
                    description: "Snoozing and auto-resuming are separate choices.",
                    run: () =>
                      void props.ui.run(() =>
                        changeRecovery({
                          runId: value.runId,
                          resetAt: value.resetAt!,
                          snooze: !value.snoozed,
                        }),
                      ),
                  },
                ]
              : []),
          ]
        : []),
      {
        title: "Choose another model",
        run: () => {
          guard();
          props.ui.chooseModel();
        },
      },
      ...(currentProviderBanner
        ? [
            {
              title: dismissals().has(currentProviderBanner.key)
                ? "Show provider notice again"
                : "Dismiss provider notice for this session",
              run: () =>
                dismissals().has(currentProviderBanner.key)
                  ? restore(currentProviderBanner.key)
                  : dismiss(currentProviderBanner.key),
            },
          ]
        : []),
      ...(currentError
        ? [
            {
              title: dismissals().has(currentError.key)
                ? "Show error again"
                : "Dismiss this error for this session",
              run: () =>
                dismissals().has(currentError.key)
                  ? restore(currentError.key)
                  : dismiss(currentError.key),
            },
          ]
        : []),
    ];
    props.ui.choose("Provider and conversation status", choices);
  }
  function Banners() {
    return (
      <box flexShrink={0}>
        <Show when={visibleProvider()}>
          {(value) => (
            <box paddingX={1}>
              <box height={1} flexDirection="row" gap={2}>
                <text
                  flexGrow={1}
                  truncate
                  fg={value().tone === "warning" ? theme.statusApproval : theme.error}
                >
                  {value().title}
                </text>
                <text selectable={false} fg={theme.primary} onMouseDown={openActions}>
                  Actions /status
                </text>
                <text
                  selectable={false}
                  fg={theme.textMuted}
                  onMouseDown={() => dismiss(value().key)}
                >
                  Dismiss
                </text>
              </box>
              <text height={1} truncate fg={theme.textMuted}>
                {value().message}
              </text>
            </box>
          )}
        </Show>
        <Show when={visibleError()}>
          {(value) => (
            <box paddingX={1}>
              <box height={1} flexDirection="row" gap={2}>
                <text
                  flexGrow={1}
                  truncate
                  fg={value().tone === "warning" ? theme.statusApproval : theme.error}
                >
                  {value().title}
                </text>
                <text selectable={false} fg={theme.primary} onMouseDown={openActions}>
                  Recovery /status
                </text>
                <text
                  selectable={false}
                  fg={theme.textMuted}
                  onMouseDown={() => dismiss(value().key)}
                >
                  Dismiss
                </text>
              </box>
              <text height={1} truncate fg={theme.textMuted}>
                {recovery()?.description ?? value().message}
              </text>
            </box>
          )}
        </Show>
      </box>
    );
  }
  return { Banners, openActions };
}
