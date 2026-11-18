import type {
  AssetResource,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  CodeRenderable,
  TextBufferRenderable,
  type MarkdownRenderable,
  type Renderable,
  type SyntaxStyle,
} from "@opentui/core";
import {
  toolCallLines,
  turnItemOutputImages,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import { useRenderer } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import { theme } from "./theme/index.ts";
import { createSyntax } from "./theme/syntax.ts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  secretRequestDisplay,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import { htmlArtifacts } from "./presentation/html.ts";
import { NativeImagePreview } from "./presentation/media.tsx";
import type { AssetBytes } from "./runtime/assets.ts";

function showPendingCode(node: Renderable, wordWrap = true) {
  if (node instanceof TextBufferRenderable) node.wrapMode = wordWrap ? "word" : "none";
  if (node instanceof CodeRenderable) node.drawUnstyledText = true;
  for (const child of node.getChildren()) showPendingCode(child, wordWrap);
}

export function MarkdownMessage(props: {
  content: string;
  streaming: boolean;
  syntax: SyntaxStyle;
  wordWrap?: boolean | undefined;
}) {
  let markdown: MarkdownRenderable | undefined;
  // Native markdown owns its text children, so wrapping changes must reach those renderables.
  createEffect(() => {
    const wordWrap = props.wordWrap !== false;
    if (markdown && !markdown.isDestroyed) showPendingCode(markdown, wordWrap);
  });
  return (
    <markdown
      ref={(node) => {
        markdown = node;
        const nativePass = node.onLifecyclePass;
        node.onLifecyclePass = () => {
          nativePass?.();
          // OpenTUI hides markdown and streaming code until asynchronous highlighting finishes.
          showPendingCode(node, props.wordWrap !== false);
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

export function turnItemText(value: OrchestrationV2TurnItem, preview = false) {
  const output = (text: string) => (preview ? previewToolText(text) : text);
  switch (value.type) {
    case "user_message":
      return replaceComposerContextReferences(value.text, (reference) => `@${reference.label}`);
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
      return output(
        `$ ${value.input}\n${value.output ?? (value.outputOmitted ? "Open item details to load command output." : "")}`,
      );
    case "file_change":
      return `${value.fileName}\n${value.diffStr ?? value.newStr ?? ""}`;
    case "approval_request":
      return [value.prompt, value.reason, "Approval required. Respond below or press Ctrl+A."]
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
      return output(
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
      return output([value.prompt, value.progress, value.result].filter(Boolean).join("\n"));
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
}

function Item(props: {
  item: OrchestrationV2TurnItem;
  visibility?: OrchestrationV2ProjectedTurnItem["visibility"];
  syntax: SyntaxStyle;
  wordWrap?: boolean | undefined;
  onOpen: () => void;
  onOpenFile?: ((path: string) => void) | undefined;
  onFocus?: (() => void) | undefined;
  rowRef?: ((node: Renderable) => void) | undefined;
  expandAll?: boolean | undefined;
  onOpenHtml?: ((html: string, title?: string) => void) | undefined;
  onPreviewAsset?: ((resource: AssetResource, label: string) => void) | undefined;
  loadAsset?: ((resource: AssetResource) => Promise<AssetBytes>) | undefined;
  onCopy?: ((text: string) => void) | undefined;
  onSecretRequest?: ((item: SecretRequestItem) => void) | undefined;
  onOpenOriginal?: (() => void) | undefined;
}) {
  const visibility = () => props.visibility ?? "local";
  const secret = createMemo(() => (props.item.type === "secret_request" ? props.item : null));
  const secretDisplay = createMemo(() => {
    const value = secret();
    return value ? secretRequestDisplay(value, visibility()) : null;
  });
  const [expanded, setExpanded] = createSignal(false);
  const [visibleImages, setVisibleImages] = createSignal<ReadonlySet<number>>(new Set());
  const images = createMemo(() => {
    const value = props.item;
    const result: Array<{ resource: AssetResource; label: string }> = [];
    if (value.type === "user_message" || value.type === "assistant_message") {
      for (const attachment of value.attachments ?? [])
        if (attachment.type === "image")
          result.push({
            resource: {
              _tag: "attachment",
              attachmentId: attachment.id,
              mimeType: attachment.mimeType,
              fileName: attachment.name,
              disposition: "inline",
            },
            label: attachment.name,
          });
    }
    for (const resource of turnItemOutputImages(value))
      result.push({ resource, label: `Tool image ${resource.index + 1}` });
    if (value.type === "dynamic_tool" && value.viewedImagePath)
      result.push({
        resource: { _tag: "media-file", threadId: value.threadId, path: value.viewedImagePath },
        label: value.viewedImagePath,
      });
    return result;
  });
  const html = createMemo(() =>
    props.item.type === "assistant_message" ? htmlArtifacts(props.item.text) : [],
  );
  const isMessage = () =>
    props.item.type === "user_message" || props.item.type === "assistant_message";
  const isPlan = () => props.item.type === "proposed_plan" || props.item.type === "todo_list";
  const showBody = () =>
    isMessage() ||
    isPlan() ||
    props.item.type === "error" ||
    secretDisplay()?.kind === "pending" ||
    expanded() ||
    props.expandAll;
  const toggle = () => {
    props.onFocus?.();
    setExpanded((value) => !value);
  };
  const item = () => props.item;
  const streaming = () => {
    const value = item();
    return "streaming" in value && value.streaming;
  };
  const content = createMemo(() => turnItemText(item(), true));
  const label = () => {
    const value = item();
    if (value.type === "user_message") return "You";
    if (value.type === "assistant_message") return "Agent";
    if (value.type === "dynamic_tool") return value.toolName ?? value.title ?? "Tool";
    return value.title ?? value.type.replaceAll("_", " ");
  };
  const patch = () => {
    const value = item();
    return value.type === "file_change" ? value.diffStr : null;
  };
  const summary = () => {
    const value = item();
    const mark = value.status === "failed" ? "!" : streaming() ? "…" : "✓";
    if (value.type === "command_execution") return `${mark} $ ${value.input.replaceAll("\n", " ")}`;
    if (value.type === "file_change") return `${mark} ${value.fileName}`;
    if (value.type === "reasoning") return streaming() ? "Thinking…" : "Thought process";
    if (value.type === "dynamic_tool") return `${mark} ${label()}`;
    if (value.type === "secret_request") {
      const display = secretDisplay();
      return `${value.label} · ${display?.kind === "pending" ? "Secret needed" : display && "label" in display ? display.label : value.secretStatus}`;
    }
    if (value.type === "user_message" && value.attachments.length > 0)
      return `You  ·  ${value.attachments.length} attachment${value.attachments.length === 1 ? "" : "s"}`;
    return label();
  };
  return (
    <box
      ref={(node) => props.rowRef?.(node)}
      paddingLeft={1}
      marginBottom={isMessage() || isPlan() ? 1 : 0}
      border={isMessage() || isPlan() ? ["left"] : false}
      borderColor={item().type === "user_message" ? theme.borderActive : theme.borderSubtle}
      backgroundColor={item().type === "user_message" ? theme.backgroundPanel : theme.background}
    >
      <box flexDirection="row" height={1}>
        <text
          flexGrow={1}
          truncate
          fg={item().type === "error" ? theme.error : isMessage() ? theme.text : theme.textMuted}
          onMouseDown={
            isMessage()
              ? () => {
                  props.onFocus?.();
                  props.onOpen();
                }
              : toggle
          }
        >{`${isMessage() || isPlan() ? "" : showBody() ? "▾ " : "▸ "}${summary()}`}</text>
        <Show when={showBody() && !isMessage()}>
          <text
            fg={theme.textMuted}
            onMouseDown={() => {
              props.onFocus?.();
              props.onOpen();
            }}
          >
            {" "}
            Details{" "}
          </text>
        </Show>
        <Show when={props.onCopy && (isMessage() || showBody())}>
          <text
            fg={theme.textMuted}
            onMouseDown={() => {
              props.onFocus?.();
              props.onCopy?.(turnItemText(item()));
            }}
          >
            {" "}
            Copy{" "}
          </text>
        </Show>
        <Show when={item().type === "file_change"}>
          <text
            fg={theme.primary}
            onMouseDown={() => {
              const value = item();
              props.onFocus?.();
              if (value.type === "file_change") props.onOpenFile?.(value.fileName);
            }}
          >
            {" "}
            Open file{" "}
          </text>
        </Show>
      </box>
      <Show when={showBody() && content()}>
        <Show
          when={item().type === "assistant_message" || item().type === "proposed_plan"}
          fallback={
            <Show
              when={patch()}
              fallback={
                <text
                  fg={item().type === "reasoning" ? theme.textMuted : theme.text}
                  wrapMode={props.wordWrap === false ? "none" : "word"}
                >
                  {content()}
                </text>
              }
            >
              {(value) => (
                <diff
                  diff={value()}
                  view="unified"
                  syntaxStyle={props.syntax}
                  fg={theme.text}
                  showLineNumbers
                  wrapMode={props.wordWrap === false ? "none" : "word"}
                />
              )}
            </Show>
          }
        >
          <MarkdownMessage
            wordWrap={props.wordWrap}
            syntax={props.syntax}
            content={content()}
            streaming={Boolean(streaming())}
          />
        </Show>
      </Show>
      <Show when={secret()}>
        {(value) => (
          <Show
            when={secretDisplay()?.kind === "pending"}
            fallback={
              <text
                fg={theme.textMuted}
                onMouseDown={() => {
                  props.onFocus?.();
                  if (secretDisplay()?.kind === "pending-elsewhere") props.onOpenOriginal?.();
                }}
              >
                {secretDisplay()?.kind === "pending-elsewhere"
                  ? "Waiting for an answer in the original thread"
                  : ""}
              </text>
            }
          >
            <text
              fg={theme.warning}
              onMouseDown={() => {
                props.onFocus?.();
                props.onSecretRequest?.(value());
              }}
            >
              Provide secret…
            </text>
          </Show>
        )}
      </Show>
      <Show when={isMessage() || showBody()}>
        <For each={html()}>
          {(artifact) => (
            <text
              fg={theme.primary}
              onMouseDown={() => {
                props.onFocus?.();
                props.onOpenHtml?.(artifact.html, artifact.title);
              }}
            >
              Open HTML in browser
            </text>
          )}
        </For>
        <For each={images()}>
          {(image, index) => (
            <box>
              <box flexDirection="row" gap={2}>
                <text
                  fg={theme.primary}
                  truncate
                  onMouseDown={() => {
                    props.onFocus?.();
                    setVisibleImages((value) => {
                      const next = new Set(value);
                      if (next.has(index())) next.delete(index());
                      else next.add(index());
                      return next;
                    });
                  }}
                >{`${visibleImages().has(index()) ? "▾ Hide" : "▸ Show"} image: ${image.label}`}</text>
                <Show when={props.onPreviewAsset}>
                  <text
                    fg={theme.textMuted}
                    onMouseDown={() => {
                      props.onFocus?.();
                      props.onPreviewAsset?.(image.resource, image.label);
                    }}
                  >
                    Expand image
                  </text>
                </Show>
              </box>
              <Show when={visibleImages().has(index()) && props.loadAsset}>
                {(load) => (
                  <NativeImagePreview
                    label={image.label}
                    load={() => load()(image.resource)}
                    maxHeight={18}
                    maxWidth={72}
                  />
                )}
              </Show>
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}

export function Transcript(props: {
  projection: OrchestrationV2ThreadProjection;
  onOpenItem?: (item: OrchestrationV2ProjectedTurnItem) => void;
  onCopyItem?: (item: OrchestrationV2ProjectedTurnItem) => void;
  onOpenThread?: (id: string) => void;
  onOpenFile?: (path: string) => void;
  onFocus?: () => void;
  rowRef?: (item: OrchestrationV2ProjectedTurnItem, node: Renderable) => void;
  expandAll?: boolean;
  hidePendingRequests?: boolean;
  wordWrap?: boolean | undefined;
  onOpenHtml?: ((html: string, title?: string) => void) | undefined;
  onPreviewAsset?: ((resource: AssetResource, label: string) => void) | undefined;
  loadAsset?: ((resource: AssetResource) => Promise<AssetBytes>) | undefined;
  onCopy?: ((text: string) => void) | undefined;
  onSecretRequest?: ((item: SecretRequestItem) => void) | undefined;
}) {
  const renderer = useRenderer();
  const syntax = createSyntax(renderer.nativeScene);
  onCleanup(() => syntax.destroy());
  const items = createMemo(() =>
    props.projection.visibleTurnItems.filter((entry) => {
      if (!props.hidePendingRequests) return true;
      const item = entry.item;
      return !(
        (item.type === "approval_request" || item.type === "user_input_request") &&
        props.projection.runtimeRequests.some(
          (request) => request.id === item.requestId && request.status === "pending",
        )
      );
    }),
  );
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
              <text fg={theme.text} wrapMode={props.wordWrap === false ? "none" : "word"}>
                {message.text}
              </text>
            </box>
          )}
        </For>
      }
    >
      <For each={items()}>
        {(entry) => (
          <Item
            item={entry.item}
            visibility={entry.visibility}
            onOpenOriginal={() => props.onOpenThread?.(entry.sourceThreadId)}
            syntax={syntax}
            wordWrap={props.wordWrap}
            onOpen={() => props.onOpenItem?.(entry)}
            onOpenFile={props.onOpenFile}
            onFocus={props.onFocus}
            expandAll={props.expandAll}
            onOpenHtml={props.onOpenHtml}
            onPreviewAsset={props.onPreviewAsset}
            loadAsset={props.loadAsset}
            onCopy={props.onCopyItem ? () => props.onCopyItem?.(entry) : props.onCopy}
            onSecretRequest={props.onSecretRequest}
            rowRef={(node) => props.rowRef?.(entry, node)}
          />
        )}
      </For>
    </Show>
  );
}
