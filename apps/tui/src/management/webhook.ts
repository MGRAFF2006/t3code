import type {
  ScheduledTask,
  ScheduledTaskUpsertInput,
  ScheduledTaskUpsertSchedule,
  ScheduledTaskWebhookFilter,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { destinationGuard, splitNames } from "./common.tsx";

export function webhookActions(props: FeatureProps, task: ScheduledTask): Choice[] {
  if (task.schedule.type !== "webhook") return [];
  const schedule = task.schedule;
  const guard = destinationGuard(props);
  async function save(next: ScheduledTaskUpsertSchedule) {
    guard();
    const input: ScheduledTaskUpsertInput = {
      id: task.id,
      requireExisting: true,
      title: task.title,
      prompt: task.prompt,
      enabled: task.enabled,
      schedule: next,
      projectId: task.projectId,
      threadId: task.threadId,
      ...(task.threadMode ? { threadMode: task.threadMode } : {}),
      workspaceStrategy: task.workspaceStrategy,
      modelSelection: task.modelSelection,
      runtimeMode: task.runtimeMode,
      interactionMode: task.interactionMode,
    };
    await request(props.client, WS_METHODS.scheduledTasksUpsert, input);
    props.ui.notify("Webhook settings saved.");
  }
  function editFilter(index?: number) {
    const current = index === undefined ? undefined : schedule.filters?.[index];
    props.ui.form({
      title: current ? "Edit webhook filter" : "Add webhook filter",
      fields: [
        {
          name: "path",
          label: "Field path",
          value: current?.path ?? "body.action",
          required: true,
          description: "A body, headers or query path. Use [] to match array items.",
        },
        {
          name: "op",
          label: "Condition",
          type: "select",
          value: current?.op ?? "equals",
          options: [
            { label: "Equals", value: "equals" },
            { label: "Does not equal", value: "notEquals" },
            { label: "Starts with", value: "startsWith" },
            { label: "Is one of", value: "in" },
            { label: "Exists", value: "exists" },
          ],
        },
        {
          name: "value",
          label: "Value",
          value:
            current && "value" in current
              ? typeof current.value === "string"
                ? current.value
                : current.value.join(", ")
              : "",
          description: "For 'is one of', separate values with commas. Unused for 'exists'.",
        },
      ],
      submitLabel: "Save filter",
      onSubmit: async (values) => {
        const path = values.path?.trim() ?? "";
        const op = values.op;
        const filter: ScheduledTaskWebhookFilter =
          op === "exists"
            ? { path, op }
            : op === "in"
              ? { path, op, value: splitNames(values.value ?? "") }
              : {
                  path,
                  op: op === "notEquals" || op === "startsWith" ? op : "equals",
                  value: values.value ?? "",
                };
        const filters = [...(schedule.filters ?? [])];
        if (index === undefined) filters.push(filter);
        else filters[index] = filter;
        await save({ ...schedule, filters });
      },
    });
  }
  return [
    {
      title: "Webhook verification",
      description: schedule.signature ? "HMAC-SHA256 enabled" : "URL token only",
      run: () =>
        props.ui.form({
          title: "Webhook verification",
          fields: [
            {
              name: "verify",
              label: "Verify HMAC-SHA256 signatures",
              type: "toggle",
              value: String(schedule.signature !== null),
            },
            {
              name: "header",
              label: "Signature header",
              value: schedule.signature?.header ?? "x-hub-signature-256",
            },
            {
              name: "encoding",
              label: "Digest encoding",
              type: "select",
              value: schedule.signature?.encoding ?? "hex",
              options: [
                { label: "Hex", value: "hex" },
                { label: "Base64", value: "base64" },
              ],
            },
            {
              name: "prefix",
              label: "Digest prefix",
              value: schedule.signature?.prefix ?? "sha256=",
            },
            {
              name: "secret",
              label: "Signing secret",
              type: "secret",
              description: "Leave blank to retain the current signing secret.",
            },
          ],
          submitLabel: "Save verification",
          onSubmit: async (values) => {
            await save({
              ...schedule,
              signature:
                values.verify === "true"
                  ? {
                      header: values.header?.trim() ?? "",
                      encoding: values.encoding === "base64" ? "base64" : "hex",
                      prefix: values.prefix ?? "",
                      ...(values.secret?.trim() ? { secret: values.secret.trim() } : {}),
                    }
                  : null,
            });
          },
        }),
    },
    {
      title: "Webhook delivery rules",
      run: () =>
        props.ui.form({
          title: "Webhook delivery rules",
          fields: [
            {
              name: "age",
              label: "Maximum delivery age in minutes",
              type: "number",
              value:
                schedule.maxDeliveryAgeMinutes === null ||
                schedule.maxDeliveryAgeMinutes === undefined
                  ? ""
                  : String(schedule.maxDeliveryAgeMinutes),
              description:
                "Ignore older requests held offline. Blank allows any age; maximum 1440 minutes.",
            },
            {
              name: "replay",
              label: "Replay key template",
              value: schedule.dedupe?.replayKey ?? "",
              description:
                "Ignore duplicate deliveries, for example {{headers.x-github-delivery}}. Blank disables.",
            },
            {
              name: "coalesce",
              label: "Coalescing key template",
              value: schedule.dedupe?.coalesceKey ?? "",
              description:
                "Group related deliveries, for example {{body.pull_request.number}}. Blank disables.",
            },
            {
              name: "window",
              label: "Coalescing window in seconds",
              type: "number",
              value: String(schedule.dedupe?.coalesceWindowSeconds ?? 120),
              description: "10 to 3600 seconds.",
            },
          ],
          submitLabel: "Save delivery rules",
          onSubmit: async (values) => {
            const age = values.age?.trim() ? Number(values.age) : null;
            const window = Number(values.window);
            if (age !== null && (!Number.isInteger(age) || age < 1 || age > 1440))
              throw new Error("Delivery age must be 1 to 1440 minutes, or blank.");
            if (!Number.isInteger(window) || window < 10 || window > 3600)
              throw new Error("Coalescing window must be 10 to 3600 seconds.");
            await save({
              ...schedule,
              maxDeliveryAgeMinutes: age,
              dedupe: {
                ...(values.replay?.trim() ? { replayKey: values.replay.trim() } : {}),
                ...(values.coalesce?.trim()
                  ? { coalesceKey: values.coalesce.trim(), coalesceWindowSeconds: window }
                  : {}),
              },
            });
          },
        }),
    },
    {
      title: "Webhook filters",
      description: `${schedule.filters?.length ?? 0} filters; every condition must match.`,
      run: () =>
        props.ui.choose("Webhook filters", [
          ...((schedule.filters?.length ?? 0) < 16
            ? [{ title: "Add filter", run: () => editFilter() }]
            : []),
          ...(schedule.filters ?? []).map((filter, index) => ({
            title: `${filter.path} ${filter.op}${"value" in filter ? ` ${typeof filter.value === "string" ? filter.value : filter.value.join(", ")}` : ""}`,
            run: () =>
              props.ui.choose("Filter actions", [
                { title: "Edit filter", run: () => editFilter(index) },
                {
                  title: "Remove filter",
                  run: () =>
                    void props.ui.run(() =>
                      save({
                        ...schedule,
                        filters: (schedule.filters ?? []).filter((_, at) => at !== index),
                      }),
                    ),
                },
              ]),
          })),
        ]),
    },
  ];
}
