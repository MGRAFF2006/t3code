import {
  KnownComposerContextRecord,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import {
  threadContextRecord,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";

const isContextRecord = Schema.is(KnownComposerContextRecord);

export function contextActions(
  props: FeatureProps,
  add: (record: KnownComposerContextRecord) => void,
  canUpdate: () => boolean,
) {
  const environmentId = props.state()?.environmentId;
  if (!environmentId) return;
  const base = (kind: KnownComposerContextRecord["kind"], label: string) => ({
    version: 1,
    kind,
    contextId: toKindScopedComposerContextId(kind, SecureRandom.uuidV4Unsafe()),
    label: label.slice(0, 200),
  });
  const append = (record: unknown) => {
    if (!canUpdate()) throw new Error("Return to the original thread to add context.");
    if (!isContextRecord(record))
      throw new Error("Check the context fields and their size limits.");
    add(record);
  };
  const quote = (entry: OrchestrationV2ProjectedTurnItem) => {
    void props.ui.run(async () => {
      const { item } = await request(props.client, ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
        threadId: entry.sourceThreadId,
        itemId: entry.sourceItemId,
      });
      const response = item ?? entry.item;
      if (!canUpdate() || response.type !== "assistant_message") return;
      props.ui.form({
        title: "Reply to an agent response",
        description:
          "Keep the whole opening or select an exact passage. The agent can reread the original response.",
        fields: [
          {
            name: "quote",
            label: "Passage",
            type: "multiline",
            value: response.text.slice(0, 8000),
            required: true,
          },
          { name: "comment", label: "Comment", type: "multiline" },
        ],
        submitLabel: "Add response context",
        onSubmit: async (values) => {
          const text = values.quote ?? "";
          const start = response.text.indexOf(text);
          if (!text.trim() || start < 0)
            throw new Error("Choose an exact passage from the response.");
          append({
            ...base("response", `Reply: ${text.slice(0, 100)}`),
            itemId: entry.sourceItemId,
            citation: {
              version: 1,
              environmentId,
              threadId: entry.sourceThreadId,
              messageId: response.messageId,
              text,
              ...(values.comment ? { comment: values.comment } : {}),
              start,
              end: start + text.length,
              prefix: response.text.slice(Math.max(0, start - 32), start),
              suffix: response.text.slice(start + text.length, start + text.length + 32),
            },
          });
        },
      });
    });
  };
  props.ui.choose("Add message context", [
    {
      title: "Another thread",
      description: "Reference a conversation from this environment",
      run: () =>
        props.ui.choose(
          "Reference a thread",
          (props.state()?.shell?.threads ?? []).map((thread) => ({
            title: thread.title,
            run: () =>
              append(threadContextRecord({ environmentId, threadId: thread.id }, thread.title)),
          })),
        ),
    },
    {
      title: "Environment",
      description: "Mention a saved machine by identity",
      run: () =>
        void props.ui.run(async () => {
          const environments = await props.client.environments();
          if (!canUpdate()) return;
          props.ui.choose(
            "Reference an environment",
            environments.map((environment) => ({
              title: environment.label,
              run: () =>
                append({
                  ...base("environment", environment.label),
                  environmentId: environment.environmentId,
                }),
            })),
          );
        }),
    },
    {
      title: "Agent response",
      description: "Quote a response and retain its original identity",
      run: () =>
        props.ui.choose(
          "Reply to a response",
          (props.state()?.thread?.visibleTurnItems ?? []).flatMap((entry) =>
            entry.item.type === "assistant_message" && entry.item.text.trim()
              ? [
                  {
                    title: entry.item.text.replaceAll("\n", " ").slice(0, 140),
                    run: () => quote(entry),
                  },
                ]
              : [],
          ),
        ),
    },
    {
      title: "Terminal output",
      description: "Add selected terminal text with its terminal and line range",
      run: () =>
        props.ui.form({
          title: "Terminal context",
          fields: [
            { name: "terminal", label: "Terminal ID", value: "default", required: true },
            { name: "label", label: "Terminal name", value: "Terminal", required: true },
            { name: "start", label: "First line", type: "number", value: "0", required: true },
            { name: "text", label: "Selected output", type: "multiline", required: true },
          ],
          submitLabel: "Add terminal context",
          onSubmit: async (values) => {
            const text = values.text ?? "";
            const lineStart = Number(values.start);
            append({
              ...base("terminal", values.label ?? "Terminal"),
              terminalId: values.terminal,
              terminalLabel: values.label,
              lineStart,
              lineEnd: lineStart + text.split("\n").length - 1,
              text,
            });
          },
        }),
    },
    {
      title: "Diff review comment",
      description: "Attach a file, selected diff and review comment",
      run: () =>
        props.ui.form({
          title: "Review context",
          fields: [
            { name: "file", label: "Workspace file path", required: true },
            { name: "section", label: "Diff section", value: "Working tree", required: true },
            { name: "start", label: "First diff line", type: "number", value: "0", required: true },
            { name: "diff", label: "Selected diff", type: "multiline", required: true },
            { name: "comment", label: "Review comment", type: "multiline", required: true },
          ],
          submitLabel: "Add review context",
          onSubmit: async (values) => {
            const diff = values.diff ?? "";
            const startIndex = Number(values.start);
            const endIndex = startIndex + diff.split("\n").length - 1;
            append({
              ...base("review-comment", values.file ?? "Review"),
              sectionId: "terminal-review",
              sectionTitle: values.section,
              filePath: values.file,
              startIndex,
              endIndex,
              rangeLabel: `${startIndex + 1}–${endIndex + 1}`,
              text: values.comment,
              diff,
            });
          },
        }),
    },
  ]);
}
