import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import {
  scheduledTaskThreadMode,
  WS_METHODS,
  type ScheduledTask,
  type ScheduledTaskListResult,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import type { FeatureProps } from "../ui/controller.ts";
import { request, subscribe } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { Action, destinationGuard, errorMessage, Section } from "./common.tsx";
import { webhookActions } from "./webhook.ts";
import { parseSchedule, scheduleDescription } from "./schedule.ts";

export function SchedulesPanel(props: FeatureProps) {
  const [result, setResult] = createSignal<ScheduledTaskListResult>({ tasks: [] });
  const [revision, setRevision] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [selection, setSelection] = createSignal(0);
  const [pane, setPane] = createSignal<"list" | "detail">("list");
  const tasks = () => result().tasks;
  const selected = createMemo(() => tasks()[Math.min(selection(), tasks().length - 1)]);

  const environment = createMemo(() => props.state()?.environmentId);
  createEffect(() => {
    const environmentId = environment();
    revision();
    setResult({ tasks: [] });
    setLoaded(false);
    setError(null);
    setSelection(0);
    if (!environmentId) return;
    let active = true;
    const stop = subscribe(
      props.client,
      WS_METHODS.scheduledTasksSubscribe,
      {},
      (value) => {
        if (!active || environment() !== environmentId) return;
        setResult(value);
        setLoaded(true);
      },
      (failure) => {
        if (active) {
          setError(errorMessage(failure));
          setLoaded(true);
        }
      },
    );
    onCleanup(() => {
      active = false;
      stop();
    });
  });

  function edit(task?: ScheduledTask) {
    const guard = destinationGuard(props);
    const state = props.state();
    const projects = state?.shell?.projects ?? [];
    const providers =
      state?.config?.providers.filter((provider) => provider.enabled && provider.installed) ?? [];
    const models = providers.flatMap((provider) =>
      provider.models.map((model) => ({
        selection: { instanceId: provider.instanceId, model: model.slug },
        label: `${provider.displayName ?? provider.driver} / ${model.name}`,
      })),
    );
    if (
      task &&
      !models.some(
        (entry) =>
          entry.selection.instanceId === task.modelSelection.instanceId &&
          entry.selection.model === task.modelSelection.model,
      )
    ) {
      models.unshift({
        selection: task.modelSelection,
        label: `${task.modelSelection.instanceId} / ${task.modelSelection.model}`,
      });
    }
    if (!projects.length || !models.length) {
      props.ui.notify(
        !projects.length
          ? "Add a project before creating a schedule."
          : "Enable and install a provider before creating a schedule.",
        true,
      );
      return;
    }
    const thread = state?.thread?.thread;
    const threads = state?.shell?.threads ?? [];
    const initialModel =
      task?.modelSelection ??
      thread?.modelSelection ??
      state?.config?.settings.defaultModelSelection;
    const initialProject = task?.projectId ?? thread?.projectId ?? projects[0]!.id;
    const strategy = task?.workspaceStrategy;
    props.ui.form({
      title: task ? `Edit ${task.title}` : "New scheduled task",
      description: task
        ? "Changes apply to future runs. The current run continues."
        : "New tasks start disabled. Review the saved task, then enable it or run it once.",
      submitLabel: task ? "Save changes" : "Create disabled task",
      fields: [
        { name: "title", label: "Title", value: task?.title ?? "", required: true },
        {
          name: "prompt",
          label: "Prompt",
          type: "multiline",
          value: task?.prompt ?? "",
          required: true,
        },
        {
          name: "project",
          label: "Project",
          type: "select",
          value: initialProject,
          options: projects.map((project) => ({ label: project.title, value: project.id })),
        },
        {
          name: "schedule",
          label: "When",
          type: "select",
          value: task?.schedule.type ?? "interval",
          options: [
            { label: "Every interval", value: "interval" },
            { label: "At a fixed time", value: "fixed_time" },
            { label: "Once", value: "once" },
            { label: "Webhook", value: "webhook" },
          ],
        },
        {
          name: "minutes",
          label: "Interval in minutes",
          type: "number",
          value: task?.schedule.type === "interval" ? String(task.schedule.everyMs / 60_000) : "60",
          description: "Used for interval schedules; minimum 1 minute.",
        },
        {
          name: "time",
          label: "Time of day",
          value: task?.schedule.type === "fixed_time" ? task.schedule.timeOfDay : "09:00",
          description: `HH:MM in ${result().timeZone ?? "the environment's time zone"}; used for fixed-time schedules.`,
        },
        {
          name: "weekdays",
          label: "Weekdays",
          value:
            task?.schedule.type === "fixed_time" ? (task.schedule.weekdays?.join(",") ?? "") : "",
          description:
            "Optional: 0=Sunday through 6=Saturday, separated by commas. Blank means daily.",
        },
        {
          name: "runAt",
          label: "Run once at",
          value: task?.schedule.type === "once" ? task.schedule.runAt : "",
          description: "ISO time with offset, for example 2026-12-01T09:00:00+01:00.",
        },
        {
          name: "model",
          label: "Model",
          type: "select",
          value: String(
            Math.max(
              0,
              models.findIndex(
                (entry) =>
                  entry.selection.instanceId === initialModel?.instanceId &&
                  entry.selection.model === initialModel?.model,
              ),
            ),
          ),
          options: models.map((entry, index) => ({ label: entry.label, value: String(index) })),
        },
        {
          name: "runtime",
          label: "Permissions",
          type: "select",
          value: task?.runtimeMode ?? "approval-required",
          options: [
            { label: "Ask for approval", value: "approval-required" },
            { label: "Accept edits", value: "auto-accept-edits" },
            { label: "Automatic", value: "auto" },
            { label: "Full access", value: "full-access" },
          ],
        },
        {
          name: "interaction",
          label: "Interaction",
          type: "select",
          value: task?.interactionMode ?? "default",
          options: [
            { label: "Default", value: "default" },
            { label: "Plan", value: "plan" },
          ],
        },
        {
          name: "threadMode",
          label: "Conversation",
          type: "select",
          value: task ? scheduledTaskThreadMode(task) : "new_thread",
          options: [
            { label: "New thread for each run", value: "new_thread" },
            { label: "Continue one thread", value: "continue" },
            { label: "Fresh session in one thread", value: "fresh_session" },
          ],
        },
        {
          name: "thread",
          label: "Existing thread",
          type: "select",
          value: task?.threadId ?? "",
          options: [
            { label: "Create on first run", value: "" },
            ...threads.map((entry) => ({ label: entry.title, value: entry.id })),
          ],
          description: "Used by one-thread modes; must belong to the selected project.",
        },
        {
          name: "workspace",
          label: "Workspace",
          type: "select",
          value: strategy?.type ?? "root",
          options: [
            { label: "Project checkout", value: "root" },
            { label: "New worktree", value: "worktree" },
            { label: "Existing worktree", value: "existing_worktree" },
          ],
        },
        {
          name: "baseRef",
          label: "Worktree base reference",
          value: strategy?.type === "worktree" ? strategy.baseRef : "HEAD",
        },
        {
          name: "worktreePath",
          label: "Existing worktree path",
          value: strategy?.type === "existing_worktree" ? strategy.worktreePath : "",
        },
        { name: "branch", label: "Branch (optional)", value: strategy?.branch ?? "" },
      ],
      onSubmit: async (values) => {
        guard();
        const project = projects.find((entry) => entry.id === values.project);
        const model = models[Number(values.model)]?.selection;
        if (!project || !model) throw new Error("Choose a project and model.");
        const bound =
          values.threadMode === "new_thread"
            ? undefined
            : threads.find((entry) => entry.id === values.thread);
        if (
          values.threadMode !== "new_thread" &&
          values.thread &&
          (!bound || bound.projectId !== project.id)
        )
          throw new Error(
            "Choose an existing thread in the selected project, or create one on the first run.",
          );
        const branch = values.branch?.trim();
        const workspaceStrategy: ScheduledTaskUpsertInput["workspaceStrategy"] =
          values.workspace === "existing_worktree"
            ? {
                type: "existing_worktree",
                worktreePath: values.worktreePath?.trim() ?? "",
                ...(branch ? { branch } : {}),
              }
            : values.workspace === "worktree"
              ? {
                  type: "worktree",
                  baseRef: values.baseRef?.trim() ?? "HEAD",
                  ...(branch ? { branch } : {}),
                  ...(strategy?.type === "worktree" && strategy.startFromOrigin !== undefined
                    ? { startFromOrigin: strategy.startFromOrigin }
                    : {}),
                }
              : { type: "root", ...(branch ? { branch } : {}) };
        const input: ScheduledTaskUpsertInput = {
          ...(task ? { id: task.id, requireExisting: true } : {}),
          title: values.title?.trim() ?? "",
          prompt: values.prompt ?? "",
          enabled: task?.enabled ?? false,
          projectId: project.id,
          schedule: parseSchedule(values, task?.schedule),
          threadId: bound?.id ?? null,
          threadMode:
            values.threadMode === "continue" || values.threadMode === "fresh_session"
              ? values.threadMode
              : "new_thread",
          workspaceStrategy,
          modelSelection:
            task &&
            model.instanceId === task.modelSelection.instanceId &&
            model.model === task.modelSelection.model
              ? task.modelSelection
              : model,
          runtimeMode:
            values.runtime === "full-access" ||
            values.runtime === "auto" ||
            values.runtime === "auto-accept-edits"
              ? values.runtime
              : "approval-required",
          interactionMode: values.interaction === "plan" ? "plan" : "default",
        };
        await request(props.client, WS_METHODS.scheduledTasksUpsert, input);
        props.ui.notify(
          task ? "Scheduled task saved." : "Task created disabled. Enable it when ready.",
        );
      },
    });
  }

  function taskActions() {
    const task = selected();
    if (!task) return;
    const guard = destinationGuard(props);
    props.ui.choose(task.title, [
      { title: "Edit task", run: () => edit(task) },
      {
        title: task.enabled ? "Disable task" : "Enable task",
        description: task.blockedByPolicy,
        run: () =>
          void props.ui.run(
            async () => {
              guard();
              await request(props.client, WS_METHODS.scheduledTasksSetEnabled, {
                id: task.id,
                enabled: !task.enabled,
              });
            },
            task.enabled ? "Task disabled." : "Task enabled.",
          ),
      },
      {
        title: "Run now",
        description: "Starts an agent run using the saved prompt and permissions.",
        run: () =>
          props.ui.confirm(
            "Run scheduled task",
            `${task.title}\n\n${task.prompt}\n\nPermissions: ${task.runtimeMode}`,
            async () => {
              guard();
              await request(props.client, WS_METHODS.scheduledTasksRunNow, { id: task.id });
            },
            "Run now",
          ),
      },
      ...(task.threadId
        ? [
            {
              title: "Open thread",
              run: () => {
                guard();
                props.ui.openThread(task.threadId!);
              },
            },
          ]
        : []),
      ...webhookActions(props, task),
      ...(task.schedule.type === "webhook"
        ? [
            {
              title: "Webhook delivery history",
              run: () =>
                void props.ui.run(async () => {
                  guard();
                  const deliveries = await request(
                    props.client,
                    WS_METHODS.scheduledTasksListWebhookDeliveries,
                    { id: task.id, acceptAnyOutcome: true },
                  );
                  props.ui.choose(
                    "Webhook deliveries",
                    deliveries.deliveries.map((delivery) => ({
                      title: `${delivery.receivedAt} · ${delivery.outcome}`,
                      description: delivery.error ?? undefined,
                      run: () =>
                        void props.ui.run(async () => {
                          guard();
                          const result = await request(
                            props.client,
                            WS_METHODS.scheduledTasksGetWebhookDelivery,
                            { id: task.id, deliveryId: delivery.id, acceptAnyOutcome: true },
                          );
                          guard();
                          props.ui.text(
                            "Webhook delivery",
                            `${result.delivery.receivedAt}\n${result.delivery.outcome}\n${result.delivery.error ?? ""}\n\n${result.delivery.renderedPrompt ?? ""}\n\n${result.delivery.body}`,
                          );
                        }),
                    })),
                  );
                }),
            },
            {
              title: "Rotate webhook token",
              run: () =>
                props.ui.confirm(
                  "Rotate webhook token",
                  "Existing senders will need the new webhook URL.",
                  async () => {
                    guard();
                    await request(props.client, WS_METHODS.scheduledTasksRotateWebhookToken, {
                      id: task.id,
                    });
                  },
                  "Rotate token",
                ),
            },
          ]
        : []),
      {
        title: "Delete task",
        run: () =>
          props.ui.confirm(
            "Delete scheduled task",
            `Delete “${task.title}”? Its existing threads will remain.`,
            async () => {
              guard();
              await request(props.client, WS_METHODS.scheduledTasksDelete, { id: task.id });
            },
            "Delete task",
          ),
      },
    ]);
  }

  useKeyboard((event) => {
    if (!props.focused || props.ui.modal() || event.ctrl || event.meta) return;
    if (event.name === "n" && !event.ctrl && !event.meta) edit();
    else if (event.name === "return" || event.name === "a") taskActions();
    else if (event.name === "e") edit(selected());
    else if (event.name === "r") setRevision((value) => value + 1);
    else if (event.name === "right") setPane("detail");
    else if (event.name === "left") setPane("list");
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  return (
    <box flexGrow={1} flexDirection="column" minHeight={0} onMouseDown={props.onFocus}>
      <box paddingX={1} paddingY={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={1}>
          Scheduled tasks
        </text>
        <Action label="New task [n]" onPress={() => edit()} />
      </box>
      <Show when={error()}>
        <text fg={theme.error} paddingX={1}>
          {error()}
        </text>
      </Show>
      <Show
        when={tasks().length}
        fallback={
          <text fg={theme.textMuted} padding={2}>
            {loaded() ? "No scheduled tasks. Press n to create one." : "Loading scheduled tasks…"}
          </text>
        }
      >
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <select
            width="36%"
            flexShrink={0}
            flexGrow={1}
            focused={props.focused && !props.ui.modal() && pane() === "list"}
            options={tasks().map((task) => ({
              name: `${task.enabled ? "●" : "○"} ${task.title}`,
              description: scheduleDescription(task.schedule, result().timeZone),
            }))}
            selectedIndex={selection()}
            onChange={(index) => setSelection(index)}
            onSelect={taskActions}
            onMouseDown={() => setPane("list")}
            backgroundColor={theme.background}
            textColor={theme.text}
            descriptionColor={theme.textMuted}
            selectedTextColor={theme.primary}
            selectedBackgroundColor={theme.backgroundElement}
            showScrollIndicator
          />
          <scrollbox
            flexGrow={2}
            minWidth={0}
            focused={props.focused && !props.ui.modal() && pane() === "detail"}
            onMouseDown={() => setPane("detail")}
            paddingX={2}
          >
            <Show when={selected()}>
              {(task) => (
                <>
                  <Section title={task().title}>
                    <text fg={task().enabled ? theme.success : theme.textMuted}>
                      {task().enabled ? "Enabled" : "Disabled"} · {task().lastRunStatus}
                    </text>
                    <Show when={task().blockedByPolicy}>
                      <text fg={theme.warning}>{task().blockedByPolicy}</text>
                    </Show>
                    <text fg={theme.textMuted}>
                      {scheduleDescription(task().schedule, result().timeZone)}
                    </text>
                    <text fg={theme.textMuted}>
                      Project:{" "}
                      {props
                        .state()
                        ?.shell?.projects.find((project) => project.id === task().projectId)
                        ?.title ?? task().projectId}
                    </text>
                    <text fg={theme.textMuted}>
                      Model: {task().modelSelection.instanceId} / {task().modelSelection.model}
                    </text>
                    <text fg={theme.textMuted}>
                      Permissions: {task().runtimeMode} · {task().interactionMode}
                    </text>
                    <text fg={theme.textMuted}>
                      Conversation: {scheduledTaskThreadMode(task()).replaceAll("_", " ")}
                    </text>
                    <text fg={theme.textMuted}>
                      Workspace: {task().workspaceStrategy.type.replaceAll("_", " ")}
                    </text>
                  </Section>
                  <Section title="Prompt">
                    <text fg={theme.text} wrapMode="word">
                      {task().prompt}
                    </text>
                  </Section>
                  <Section title="Runs">
                    <text fg={theme.textMuted}>Next: {task().nextRunAt ?? "Not scheduled"}</text>
                    <text fg={theme.textMuted}>
                      Last: {task().lastRunAt ?? "Never"} · {task().runCount} runs
                    </text>
                    <Show when={task().lastRunError}>
                      <text fg={theme.error} wrapMode="word">
                        {task().lastRunError}
                      </text>
                    </Show>
                    <Show when={task().webhook}>
                      <text fg={theme.textMuted} wrapMode="word">
                        Webhook: {task().webhook?.url ?? task().webhook?.path}
                      </text>
                    </Show>
                  </Section>
                  <Action label="Task actions [enter]" onPress={taskActions} />
                </>
              )}
            </Show>
          </scrollbox>
        </box>
      </Show>
      <text fg={theme.textMuted} paddingX={1}>
        ↑↓ select · → details · ← list · enter actions · n new · e edit · r refresh
      </text>
    </box>
  );
}
