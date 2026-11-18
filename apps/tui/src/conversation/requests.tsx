import type { Renderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  derivePendingThreadRequests,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2UserInputQuestion,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { attachmentActions } from "./attachments.ts";
import type { LocalAttachment } from "../runtime/attachments.ts";
import { answerLinkRequest } from "../management/link-request.ts";

interface Action {
  key: string;
  label: string;
  description?: string;
  section?: string;
  warning?: boolean;
  run: () => void;
}

const cachedDrafts = new Map<string, PendingUserInputDraftAnswer>();
const cachedAttachments = new Map<string, ReadonlyArray<LocalAttachment>>();

export function RequestCards(
  props: FeatureProps & {
    active: boolean;
    onActivate: () => void;
    onDone: () => void;
    reveal: (node: Renderable) => void;
  },
) {
  const scope = `${props.state()?.environmentId}/${props.state()?.thread?.thread.id}`;
  const actionRows = new Map<string, Renderable>();
  const [cursor, setCursor] = createSignal(0);
  const [drafts, setDrafts] = createSignal<Record<string, PendingUserInputDraftAnswer>>({});
  const [attachmentDrafts, setAttachmentDrafts] = createSignal<
    Record<string, ReadonlyArray<LocalAttachment>>
  >({});
  const [responding, setResponding] = createSignal<ReadonlySet<string>>(new Set());
  const projection = () => props.state()?.thread;
  const pending = createMemo(() => {
    const value = projection();
    return value ? derivePendingThreadRequests(value) : { approvals: [], userInputs: [] };
  });
  const draftKey = (id: RuntimeRequestId, question: string) => `${scope}/${id}/${question}`;
  const inOriginalThread = () =>
    `${props.state()?.environmentId}/${props.state()?.thread?.thread.id}` === scope;
  const attachmentsFor = (id: RuntimeRequestId, question: string) =>
    attachmentDrafts()[draftKey(id, question)] ??
    cachedAttachments.get(draftKey(id, question)) ??
    [];
  const currentDraft = (id: RuntimeRequestId, question: OrchestrationV2UserInputQuestion) =>
    drafts()[draftKey(id, question.id)] ??
    cachedDrafts.get(draftKey(id, question.id)) ??
    (question.initialAnswer !== undefined ? { customAnswer: question.initialAnswer } : {});
  const update = (
    id: RuntimeRequestId,
    question: OrchestrationV2UserInputQuestion,
    next: PendingUserInputDraftAnswer,
  ) => {
    cachedDrafts.set(draftKey(id, question.id), next);
    setDrafts((value) => ({ ...value, [draftKey(id, question.id)]: next }));
  };
  const execute = (command: OrchestrationV2Command) => {
    props.onFocus();
    void props.ui.run(async () => {
      if (!inOriginalThread())
        throw new Error("Return to the original conversation to answer this request.");
      await request(props.client, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command);
      props.onDone();
    });
  };
  const respond = (
    requestId: RuntimeRequestId,
    body: {
      decision?: "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
      feedback?: string;
      answers?: Record<string, unknown>;
    },
  ) => {
    const threadId = projection()?.thread.id;
    if (!threadId) return;
    execute({
      type: "runtime-request.respond",
      commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
      threadId,
      requestId,
      ...body,
    });
  };
  const cards = createMemo(() => [
    ...pending().approvals.map((approval) => {
      const actions: Action[] =
        approval.responseCapability === "live"
          ? (
              approval.options ?? [
                { decision: "accept" as const, label: "Allow once" },
                { decision: "acceptForSession" as const, label: "Allow for this session" },
                { decision: "decline" as const, label: "Decline" },
              ]
            ).map((option) => ({
              key: `${approval.requestId}/${option.decision}`,
              label: option.label,
              ...(option.warning ? { description: option.warning, warning: true } : {}),
              run: () => respond(approval.requestId, { decision: option.decision }),
            }))
          : [];
      if (approval.supportsFeedback)
        actions.push({
          key: `${approval.requestId}/feedback`,
          label: "Decline with feedback",
          run: () => {
            const threadId = projection()?.thread.id;
            const environmentId = props.state()?.environmentId;
            if (!threadId) return;
            props.ui.form({
              title: "Redirect your agent",
              fields: [
                {
                  name: "feedback",
                  label: "What should the agent do instead?",
                  type: "multiline",
                  required: true,
                },
              ],
              submitLabel: "Send feedback",
              onSubmit: async (values) => {
                if (props.state()?.environmentId !== environmentId)
                  throw new Error("Return to the request's environment to respond.");
                await request(props.client, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
                  type: "runtime-request.respond",
                  commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
                  threadId,
                  requestId: approval.requestId,
                  decision: "decline",
                  feedback: values.feedback ?? "",
                });
              },
            });
          },
        });
      return {
        id: approval.requestId,
        title: `${approval.appName ?? "Agent"} needs approval`,
        text: [
          approval.detail,
          approval.reason,
          approval.fullAccessOverride
            ? fullAccessOverrideExplanation(approval.fullAccessOverride)
            : null,
          approval.responseCapability !== "live"
            ? "This request can no longer be answered. Send a new message to continue."
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
        actions,
      };
    }),
    ...pending().userInputs.map((input) => {
      if (input.responseCapability === "not_resumable")
        return {
          id: input.requestId,
          title: "Question expired",
          text: `${input.questions.map((question) => question.question).join("\n")}\nThis request can no longer be answered. Send a new message to continue.`,
          actions: [] as Action[],
        };
      const actions: Action[] = [];
      const answers: Record<string, PendingUserInputDraftAnswer> = {};
      for (const question of input.questions) {
        const start = actions.length;
        answers[question.id] = {
          ...currentDraft(input.requestId, question),
          attachmentCount: attachmentsFor(input.requestId, question.id).length,
        };
        for (const option of question.options) {
          const value = option.value ?? option.label;
          actions.push({
            key: `${input.requestId}/${question.id}/${value}`,
            label: `${isPendingUserInputOptionSelected(question, currentDraft(input.requestId, question), value) ? "[x]" : "[ ]"} ${option.label}`,
            description: option.description,
            run: () =>
              update(
                input.requestId,
                question,
                togglePendingUserInputOptionSelection(
                  question,
                  currentDraft(input.requestId, question),
                  value,
                ),
              ),
          });
        }
        if (question.allowCustomAnswer !== false)
          actions.push({
            key: `${input.requestId}/${question.id}/custom`,
            label: currentDraft(input.requestId, question).customAnswer
              ? `Answer: ${currentDraft(input.requestId, question).customAnswer}`
              : question.options.length > 0
                ? "Write another answer…"
                : "Write your answer…",
            run: () =>
              props.ui.form({
                title: question.header || "Answer your agent",
                description: question.question,
                fields: [
                  {
                    name: "answer",
                    label: "Your answer",
                    type: "multiline",
                    value: currentDraft(input.requestId, question).customAnswer ?? "",
                    required: question.required !== false,
                  },
                ],
                submitLabel: "Use answer",
                onSubmit: async (values) => {
                  if (!inOriginalThread() || responding().has(input.requestId))
                    throw new Error("Return to the original request before changing its answer.");
                  update(
                    input.requestId,
                    question,
                    setPendingUserInputCustomAnswer(
                      question,
                      currentDraft(input.requestId, question),
                      values.answer ?? "",
                    ),
                  );
                },
              }),
          });
        if (
          props.state()?.config?.environment.capabilities.questionAttachments &&
          question.allowCustomAnswer !== false
        )
          actions.push({
            key: `${input.requestId}/${question.id}/attachments`,
            label: attachmentsFor(input.requestId, question.id).length
              ? `Manage ${attachmentsFor(input.requestId, question.id).length} answer attachments`
              : "Attach an image or file…",
            run: () =>
              attachmentActions(
                props,
                attachmentsFor(input.requestId, question.id),
                (next) => {
                  const environmentId = props.state()?.environmentId;
                  if (environmentId)
                    props.client.releaseLocalAttachments(
                      environmentId,
                      attachmentsFor(input.requestId, question.id).filter(
                        (value) => !next.some((attachment) => attachment.id === value.id),
                      ),
                    );
                  const key = draftKey(input.requestId, question.id);
                  cachedAttachments.set(key, next);
                  setAttachmentDrafts((values) => ({ ...values, [key]: next }));
                },
                () => inOriginalThread() && !responding().has(input.requestId),
              ),
          });
        const firstAction = actions[start];
        if (firstAction)
          firstAction.section = `${question.header ? `${question.header}: ` : ""}${question.question}${question.multiSelect ? " (select all that apply)" : ""}`;
      }
      const values = buildPendingUserInputAnswers(input.questions, answers);
      actions.push({
        key: `${input.requestId}/submit`,
        label: responding().has(input.requestId) ? "Sending answers…" : "Send answers",
        run: () => {
          if (responding().has(input.requestId)) return;
          if (values === null) {
            props.ui.notify("Answer each question before sending.", true);
            return;
          }
          const attachments = Object.fromEntries(
            input.questions.flatMap((question) => {
              const selected = attachmentsFor(input.requestId, question.id);
              return selected.length ? [[question.id, selected]] : [];
            }),
          );
          setResponding((current) => new Set([...current, input.requestId]));
          void props.ui.run(async () => {
            try {
              if (!inOriginalThread())
                throw new Error("Return to the original conversation to answer this request.");
              await props.client.answer(input.requestId, values, attachments);
              for (const question of input.questions) {
                cachedDrafts.delete(draftKey(input.requestId, question.id));
                cachedAttachments.delete(draftKey(input.requestId, question.id));
              }
              props.onDone();
            } finally {
              setResponding(
                (current) => new Set([...current].filter((id) => id !== input.requestId)),
              );
            }
          });
        },
      });
      if (input.dismissible)
        actions.push({
          key: `${input.requestId}/dismiss`,
          label: "Dismiss",
          run: () => {
            const threadId = projection()?.thread.id;
            if (threadId)
              execute({
                type: "thread.user-input.dismiss",
                commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
                threadId,
                requestId: input.requestId,
              });
          },
        });
      return {
        id: input.requestId,
        title: "Your agent has a question",
        text: "",
        actions: actions.map((action) => ({
          ...action,
          run: () => {
            if (!responding().has(input.requestId)) action.run();
          },
        })),
      };
    }),
    ...(projection()?.visibleTurnItems ?? []).flatMap((entry) => {
      const item = entry.item;
      if (
        entry.visibility !== "local" ||
        item.type !== "link_request" ||
        item.linkStatus !== "pending"
      )
        return [];
      const actions: Action[] = [
        {
          key: `${item.id}/link`,
          label: "Choose machine and access…",
          run: () => answerLinkRequest(props, item),
        },
      ];
      return [{ id: item.id, title: "Link another environment", text: item.reason, actions }];
    }),
  ]);
  const allActions = createMemo(() => cards().flatMap((card) => card.actions));
  createEffect(() => {
    if (!props.active) return;
    const selected = allActions()[cursor() % Math.max(1, allActions().length)];
    const row = selected ? actionRows.get(selected.key) : undefined;
    if (row && !row.isDestroyed) props.reveal(row);
  });
  useKeyboard((key) => {
    if (!props.focused || !props.active || props.ui.modal()) return;
    const count = allActions().length;
    if (key.name === "escape") {
      key.preventDefault();
      props.onDone();
    }
    if (key.name === "up" || key.name === "down" || key.name === "tab") {
      key.preventDefault();
      const direction = key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1;
      setCursor((value) => (count > 0 ? (value + direction + count) % count : 0));
    }
    if (key.name === "return" || key.name === "space") {
      key.preventDefault();
      allActions()[cursor() % Math.max(1, count)]?.run();
    }
  });
  return (
    <For each={cards()}>
      {(card) => (
        <box
          border={["left"]}
          borderColor={theme.warning}
          paddingLeft={1}
          marginTop={1}
          onMouseDown={() => {
            props.onFocus();
            props.onActivate();
          }}
        >
          <text fg={theme.warning}>{card.title}</text>
          <text fg={theme.text} wrapMode="word">
            {card.text}
          </text>
          <For each={card.actions}>
            {(action) => (
              <box
                ref={(node) => {
                  actionRows.set(action.key, node);
                }}
              >
                <Show when={action.section}>
                  <text fg={theme.text} wrapMode="word" marginTop={1}>
                    {action.section}
                  </text>
                </Show>
                <text
                  fg={
                    props.active &&
                    allActions()[cursor() % Math.max(1, allActions().length)]?.key === action.key
                      ? theme.primary
                      : action.warning
                        ? theme.warning
                        : theme.text
                  }
                  onMouseDown={() => {
                    props.onFocus();
                    props.onActivate();
                    setCursor(allActions().findIndex((entry) => entry.key === action.key));
                    action.run();
                  }}
                >{`${props.active && allActions()[cursor() % Math.max(1, allActions().length)]?.key === action.key ? "›" : " "} ${action.label}`}</text>
                <Show when={action.description}>
                  <text fg={theme.textMuted} paddingLeft={3} wrapMode="word">
                    {action.description}
                  </text>
                </Show>
              </box>
            )}
          </For>
          <Show when={props.active}>
            <text fg={theme.textMuted}>
              ↑↓ choose · space select · enter activate · esc return to message
            </text>
          </Show>
        </box>
      )}
    </For>
  );
}
