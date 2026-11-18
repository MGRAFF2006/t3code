import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { CodeRenderable, type Renderable, type SyntaxStyle } from "@opentui/core";
import { toolCallLines, turnItemOutputText } from "@t3tools/client-runtime/work-log/item-detail";
import { useRenderer } from "@opentui/solid";
import { createMemo, For, onCleanup, Show } from "solid-js";

import { theme } from "./theme/index.ts";
import { createSyntax } from "./theme/syntax.ts";

function showPendingCode(node: Renderable) {
  if (node instanceof CodeRenderable) node.drawUnstyledText = true;
  for (const child of node.getChildren()) showPendingCode(child);
}

function MarkdownMessage(props: { content: string; streaming: boolean; syntax: SyntaxStyle }) {
  return (
    <markdown
      ref={(node) => {
        const nativePass = node.onLifecyclePass;
        node.onLifecyclePass = () => {
          nativePass?.();
          // OpenTUI hides markdown and streaming code until asynchronous highlighting finishes.
          showPendingCode(node);
        };
      }}
      content={props.content}
      streaming={props.streaming}
      syntaxStyle={props.syntax}
      fg={theme.text}
    />
  );
}

function previewToolText(text: string) {
  const lines = text.split("\n");
  const preview = lines.slice(0, 16).join("\n").slice(0, 2000);
  return preview.length < text.length
    ? `${preview}\nOpen item details for the full output.`
    : preview;
}

function Item(props: { item: OrchestrationV2TurnItem; syntax: SyntaxStyle; onOpen: () => void }) {
  const item = () => props.item;
  const streaming = () => {
    const value = item();
    return "streaming" in value && value.streaming;
  };
  const content = createMemo(() => {
    const value = item();
    switch (value.type) {
      case "user_message":
      case "assistant_message":
        return value.text;
      case "reasoning":
        return value.text;
      case "proposed_plan":
        return value.markdown;
      case "todo_list":
        return value.steps
          .map((step) => `[${step.status === "completed" ? "x" : " "}] ${step.text}`)
          .join("\n");
      case "command_execution":
        return `$ ${value.input}\n${value.output ?? (value.outputOmitted ? "Open item details to load command output." : "")}`;
      case "file_change":
        return `${value.fileName}\n${value.diffStr ?? value.newStr ?? ""}`;
      case "approval_request":
        return [value.prompt, value.reason, "Approval required. Press Ctrl+A."]
          .filter(Boolean)
          .join("\n");
      case "user_input_request":
        return value.questions
          .map((question) => `${question.header}: ${question.question}`)
          .join("\n");
      case "system_notice":
      case "run_interrupt_request":
      case "run_interrupt_result":
        return value.message;
      case "error":
        return value.failure.message;
      case "checkpoint":
        return value.files.map((file) => file.path).join("\n");
      case "compaction":
        return value.summary ?? "Context compacted";
      case "file_search":
        return [
          value.pattern,
          ...(value.results?.map(
            (result) =>
              `${result.fileName}${result.line ? `:${result.line}` : ""} ${result.preview ?? ""}`,
          ) ?? []),
        ]
          .filter(Boolean)
          .join("\n");
      case "web_search":
        return (
          value.results?.map((result) => `${result.title ?? ""}\n${result.url ?? ""}`).join("\n") ??
          value.patterns?.join("\n") ??
          ""
        );
      case "dynamic_tool": {
        const input = toolCallLines({ args: value.input });
        const call =
          input.command ??
          input.args?.map(([name, argument]) => `${name}: ${argument}`).join("\n") ??
          input.argsText;
        return previewToolText(
          [
            call,
            turnItemOutputText(value),
            value.outputOmitted ? "Open item details to load tool output." : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      case "notification":
        return [value.summary, value.detail].filter(Boolean).join("\n");
      case "subagent":
        return previewToolText(
          [value.prompt, value.progress, value.result].filter(Boolean).join("\n"),
        );
      case "handoff":
        return value.summary ?? `Context handed to ${value.toModel ?? value.toProviderInstanceId}`;
      case "thread_created":
        return `Created a thread with ${value.targetModel}`;
      case "fork":
        return "Conversation fork created. Open threads to switch to it.";
      case "secret_request":
        return [value.label, value.reason, value.secretStatus].join("\n");
      case "link_request":
        return [value.reason, value.linkedLabel ?? value.hint, value.linkStatus, value.failure]
          .filter(Boolean)
          .join("\n");
      default:
        return "";
    }
  });
  const label = () => {
    const value = item();
    if (value.type === "user_message") return "You";
    if (value.type === "assistant_message") return "Agent";
    if (value.type === "dynamic_tool") return value.toolName ?? value.title ?? "Tool";
    return value.title ?? value.type.replaceAll("_", " ");
  };
  return (
    <box
      paddingLeft={1}
      marginBottom={1}
      border={["left"]}
      borderColor={item().type === "user_message" ? theme.primary : theme.borderSubtle}
    >
      <text
        fg={item().type === "user_message" ? theme.primary : theme.textMuted}
        onMouseDown={props.onOpen}
      >
        {label()}
      </text>
      <Show when={content()}>
        <Show
          when={item().type === "assistant_message" || item().type === "proposed_plan"}
          fallback={
            <text fg={item().type === "reasoning" ? theme.textMuted : theme.text} wrapMode="word">
              {content()}
            </text>
          }
        >
          <MarkdownMessage
            syntax={props.syntax}
            content={content()}
            streaming={Boolean(streaming())}
          />
        </Show>
      </Show>
    </box>
  );
}

export function Transcript(props: {
  projection: OrchestrationV2ThreadProjection;
  onOpenItem?: (item: OrchestrationV2ProjectedTurnItem) => void;
}) {
  const renderer = useRenderer();
  const syntax = createSyntax(renderer.nativeScene);
  onCleanup(() => syntax.destroy());
  const items = createMemo(() => props.projection.visibleTurnItems);
  return (
    <Show
      when={items().length > 0}
      fallback={
        <For each={props.projection.messages}>
          {(message) => (
            <box marginBottom={1}>
              <text fg={message.role === "user" ? theme.primary : theme.textMuted}>
                {message.role === "user" ? "You" : "Agent"}
              </text>
              <text fg={theme.text} wrapMode="word">
                {message.text}
              </text>
            </box>
          )}
        </For>
      }
    >
      <For each={items()}>
        {(entry) => (
          <Item item={entry.item} syntax={syntax} onOpen={() => props.onOpenItem?.(entry)} />
        )}
      </For>
    </Show>
  );
}
