import type {
  AssetResource,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestrationV2CommandOutputFrame,
} from "@t3tools/contracts";
import {
  CodeRenderable,
  TextBufferRenderable,
  type MarkdownRenderable,
  type Renderable,
  type SyntaxStyle,
  type MouseEvent,
} from "@opentui/core";
import {
  toolCallLines,
  turnItemOutputImages,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import { useRenderer } from "@opentui/solid";
import * as DateTime from "effect/DateTime";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
  type Accessor,
} from "solid-js";

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
import {
  applyCommandOutputFrame,
  EMPTY_COMMAND_OUTPUT,
  type CommandOutputView,
} from "@t3tools/client-runtime/state/command-output";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { icon } from "./presentation/icons.ts";
import { messageLinks } from "./presentation/links.ts";
import {
  groupTranscriptItems,
  summarizeTranscriptWork,
  transcriptItemKey,
  transcriptEntryMatches,
  type TranscriptRow,
} from "./transcript.logic.ts";

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

function RowTimestamp(props: {
  item: OrchestrationV2TurnItem;
  format: TimestampFormat | undefined;
}) {
  const label = () => {
    const date = DateTime.toDateUtc(props.item.startedAt ?? props.item.updatedAt);
    const time = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(props.format && props.format !== "locale" ? { hour12: props.format === "12-hour" } : {}),
    }).format(date);
    const today = DateTime.toDateUtc(DateTime.nowUnsafe());
    if (date.toDateString() === today.toDateString()) return time;
    const day = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
    return `${day} ${time}`;
  };
  return <text selectable={false} flexShrink={0} fg={theme.textMuted}>{` ${label()} `}</text>;
}

function pointerLeftRow(event: MouseEvent) {
  const row = event.currentTarget;
  return (
    !row ||
    event.x < row.x ||
    event.x >= row.x + row.width ||
    event.y < row.y ||
    event.y >= row.y + row.height
  );
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
  expanded: boolean;
  onToggle: () => void;
  highlighted?: boolean | undefined;
  timestampFormat?: TimestampFormat | undefined;
  onOpenLinks?: (() => void) | undefined;
  cwd?: string | undefined;
  subscribeOutput?:
    | ((
        onFrame: (frame: OrchestrationV2CommandOutputFrame) => void,
        onError: (error: Error) => void,
      ) => () => void)
    | undefined;
  onOpenHtml?: ((html: string, title?: string) => void) | undefined;
  onPreviewAsset?: ((resource: AssetResource, label: string) => void) | undefined;
  loadAsset?: ((resource: AssetResource) => Promise<AssetBytes>) | undefined;
  onCopy?: ((text: string) => void) | undefined;
  onSecretRequest?: ((item: SecretRequestItem) => void) | undefined;
  onOpenOriginal?: (() => void) | undefined;
}) {
  const [hovered, setHovered] = createSignal(false);
  const visibility = () => props.visibility ?? "local";
  const secret = createMemo(() => (props.item.type === "secret_request" ? props.item : null));
  const secretDisplay = createMemo(() => {
    const value = secret();
    return value ? secretRequestDisplay(value, visibility()) : null;
  });
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
  const links = createMemo(() => {
    const item = props.item;
    return item.type === "user_message" || item.type === "assistant_message"
      ? messageLinks(item.text, props.cwd)
      : [];
  });
  const isMessage = () =>
    props.item.type === "user_message" || props.item.type === "assistant_message";
  const isPlan = () => props.item.type === "proposed_plan" || props.item.type === "todo_list";
  const showBody = () =>
    isMessage() ||
    isPlan() ||
    props.item.type === "error" ||
    props.item.type === "system_notice" ||
    props.item.type === "notification" ||
    secretDisplay()?.kind === "pending" ||
    props.expanded ||
    props.expandAll ||
    props.highlighted;
  const [commandOutput, setCommandOutput] = createSignal<CommandOutputView | null>(null);
  const [outputError, setOutputError] = createSignal<string | null>(null);
  const [outputRevision, setOutputRevision] = createSignal(0);
  const outputKey = createMemo(() =>
    props.item.type === "command_execution" ? props.item.id : null,
  );
  const bodyVisible = createMemo(showBody);
  // Expanded command rows own their bounded live output subscription.
  createEffect(() => {
    outputRevision();
    if (!bodyVisible() || !outputKey() || !props.subscribeOutput) {
      setCommandOutput(null);
      return;
    }
    setOutputError(null);
    const stop = untrack(() =>
      props.subscribeOutput!(
        (frame) =>
          setCommandOutput((previous) =>
            applyCommandOutputFrame(previous ?? EMPTY_COMMAND_OUTPUT, frame),
          ),
        (error) => setOutputError(error.message),
      ),
    );
    onCleanup(stop);
  });
  const toggle = () => {
    props.onFocus?.();
    props.onToggle();
  };
  const item = () => props.item;
  const streaming = () => {
    const value = item();
    return "streaming" in value ? value.streaming : isOrchestrationV2WorkActive(value.status);
  };
  const content = createMemo(() => {
    const value = item();
    const live = commandOutput();
    return value.type === "command_execution" && live
      ? `$ ${value.input}\n${live.output.truncated ? "Earlier output not shown\n" : ""}${Bun.stripANSI(live.output.text)}`
      : turnItemText(value, true);
  });
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
    const mark = value.status === "failed" ? icon("warning") : streaming() ? "…" : icon("success");
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
  // OpenTUI infers a full border from borderColor with false; an empty side list stays borderless.
  return (
    <box
      ref={(node) => props.rowRef?.(node)}
      paddingLeft={1}
      marginBottom={isMessage() || isPlan() ? 1 : 0}
      border={isMessage() || isPlan() || props.highlighted ? ["left"] : []}
      borderColor={
        item().type === "user_message" || props.highlighted
          ? theme.borderActive
          : theme.borderSubtle
      }
      backgroundColor={
        props.highlighted
          ? theme.backgroundElement
          : item().type === "user_message"
            ? theme.backgroundPanel
            : theme.background
      }
    >
      <box
        flexDirection="row"
        flexWrap="wrap"
        minHeight={1}
        onMouseOver={() => setHovered(true)}
        onMouseOut={(event) => {
          if (pointerLeftRow(event)) setHovered(false);
        }}
      >
        <text
          selectable={false}
          flexGrow={1}
          flexBasis={0}
          minWidth={8}
          height={1}
          flexShrink={1}
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
        >{`${isMessage() || isPlan() ? "" : `${icon(showBody() ? "collapse" : "expand")} `}${summary()}`}</text>
        <Show when={showBody() && !isMessage()}>
          <text
            selectable={false}
            flexShrink={0}
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
            selectable={false}
            flexShrink={0}
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
        <Show when={links().length && props.onOpenLinks}>
          <text
            selectable={false}
            flexShrink={0}
            fg={theme.textMuted}
            onMouseDown={() => props.onOpenLinks?.()}
          >
            {" "}
            Links{" "}
          </text>
        </Show>
        <Show when={item().type === "file_change"}>
          <text
            selectable={false}
            flexShrink={0}
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
        <Show when={hovered()}>
          <RowTimestamp item={item()} format={props.timestampFormat} />
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
      <Show when={showBody() && outputError()}>
        <text
          selectable={false}
          fg={theme.error}
          onMouseDown={() => setOutputRevision((value) => value + 1)}
        >
          {outputError()} · Retry output
        </text>
      </Show>
      <Show when={secret()}>
        {(value) => (
          <Show
            when={secretDisplay()?.kind === "pending"}
            fallback={
              <text
                selectable={false}
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
              selectable={false}
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
              selectable={false}
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
                  selectable={false}
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
                    selectable={false}
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

function WorkGroup(props: {
  row: TranscriptRow;
  grouped: boolean;
  expanded: boolean;
  timestampFormat?: TimestampFormat | undefined;
  onToggle: () => void;
  onFocus?: (() => void) | undefined;
  rowRef?: ((entry: OrchestrationV2ProjectedTurnItem, node: Renderable) => void) | undefined;
  onLoadWork?: ((entry: OrchestrationV2ProjectedTurnItem) => Promise<void>) | undefined;
  renderItem: (entry: Accessor<OrchestrationV2ProjectedTurnItem>) => ReturnType<typeof Item>;
}) {
  const [hovered, setHovered] = createSignal(false);
  const summary = createMemo(() => summarizeTranscriptWork(props.row.entries));
  const entries = createMemo(
    () => new Map(props.row.entries.map((entry) => [transcriptItemKey(entry), entry])),
  );
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let group: Renderable | undefined;
  let disposed = false;
  let requestedCursor: string | undefined;
  onCleanup(() => {
    disposed = true;
  });
  // Expanding a native work group hydrates the server's deferred history pages.
  createEffect(() => {
    const anchors = props.row.entries.filter((entry) => entry.item.deferredWork);
    if (!props.expanded) {
      requestedCursor = undefined;
      return;
    }
    const cursor = anchors
      .map((entry) => `${transcriptItemKey(entry)}:${entry.item.deferredWork!.cursor}`)
      .join("\n");
    if (!anchors.length || loading() || error() || !props.onLoadWork || requestedCursor === cursor)
      return;
    requestedCursor = cursor;
    setLoading(true);
    void Promise.all(anchors.map((entry) => props.onLoadWork!(entry)))
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
  });
  createEffect(() => {
    if (group && props.grouped && !props.expanded) {
      for (const entry of props.row.entries) props.rowRef?.(entry, group);
    }
  });
  return (
    <box
      ref={(node) => {
        group = node;
        props.rowRef?.(props.row.entries[0]!, node);
      }}
    >
      <Show when={props.grouped}>
        <box
          flexDirection="row"
          height={1}
          onMouseOver={() => setHovered(true)}
          onMouseOut={(event) => {
            if (pointerLeftRow(event)) setHovered(false);
          }}
        >
          <text
            selectable={false}
            paddingLeft={1}
            height={1}
            flexGrow={1}
            minWidth={0}
            truncate
            fg={summary().hasFailure ? theme.warning : theme.textMuted}
            onMouseDown={() => {
              props.onFocus?.();
              if (error()) {
                requestedCursor = undefined;
                setError(null);
              } else props.onToggle();
            }}
          >
            {`${icon(props.expanded ? "collapse" : "expand")} ${summary().label}${summary().active ? ` · ${summary().active} running` : ""}${summary().hasFailure ? " · failed work" : ""}`}
          </text>
          <Show when={hovered()}>
            <RowTimestamp item={props.row.entries[0]!.item} format={props.timestampFormat} />
          </Show>
        </box>
      </Show>
      <Show when={!props.grouped || props.expanded}>
        <box paddingLeft={props.grouped ? 1 : 0}>
          <For each={[...entries().keys()]}>
            {(key) => props.renderItem(() => entries().get(key)!)}
          </For>
          <Show when={loading()}>
            <text fg={theme.textMuted}>Loading earlier work…</text>
          </Show>
          <Show when={error()}>
            <text
              selectable={false}
              fg={theme.error}
              onMouseDown={() => {
                requestedCursor = undefined;
                setError(null);
              }}
            >
              {error()} · Retry
            </text>
          </Show>
        </box>
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
  timestampFormat?: TimestampFormat | undefined;
  onOpenHtml?: ((html: string, title?: string) => void) | undefined;
  onPreviewAsset?: ((resource: AssetResource, label: string) => void) | undefined;
  loadAsset?: ((resource: AssetResource) => Promise<AssetBytes>) | undefined;
  onCopy?: ((text: string) => void) | undefined;
  onSecretRequest?: ((item: SecretRequestItem) => void) | undefined;
  onLoadWork?: ((entry: OrchestrationV2ProjectedTurnItem) => Promise<void>) | undefined;
  highlightedEntryId?: string | undefined;
  onCommandOutput?:
    | ((
        entry: OrchestrationV2ProjectedTurnItem,
        onFrame: (frame: OrchestrationV2CommandOutputFrame) => void,
        onError: (error: Error) => void,
      ) => () => void)
    | undefined;
  onOpenLinks?: ((entry: OrchestrationV2ProjectedTurnItem) => void) | undefined;
  cwd?: string | undefined;
}) {
  const renderer = useRenderer();
  const syntax = createSyntax(renderer.nativeScene);
  onCleanup(() => syntax.destroy());
  const [expandedGroups, setExpandedGroups] = createSignal<ReadonlySet<string>>(new Set());
  const [expandedItems, setExpandedItems] = createSignal<ReadonlySet<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = createSignal<ReadonlySet<string>>(new Set());
  let previouslyExpanded = Boolean(props.expandAll);
  createEffect(() => {
    const expanded = Boolean(props.expandAll);
    if (previouslyExpanded !== expanded) {
      setExpandedGroups(new Set<string>());
      setExpandedItems(new Set<string>());
      setCollapsedGroups(new Set<string>());
    }
    previouslyExpanded = expanded;
  });
  const grouped = createMemo(
    () =>
      new Map(groupTranscriptItems(props.projection.visibleTurnItems).map((row) => [row.key, row])),
  );
  const keys = createMemo(() => [...grouped().keys()]);
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
  const visibleKeys = createMemo(() => new Set(items().map(transcriptItemKey)));
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
      <For each={keys()}>
        {(key) => {
          const row = () => grouped().get(key)!;
          const visible = () => visibleKeys().has(key);
          const isGroup = () =>
            row().entries.length > 1 || Boolean(row().entries[0]?.item.deferredWork);
          const expanded = () =>
            row().entries.some((entry) =>
              transcriptEntryMatches(entry, props.highlightedEntryId),
            ) ||
            (!row().entries.some((entry) => collapsedGroups().has(transcriptItemKey(entry))) &&
              (Boolean(props.expandAll) ||
                row().entries.some((entry) => expandedGroups().has(transcriptItemKey(entry)))));
          const renderItem = (entry: Accessor<OrchestrationV2ProjectedTurnItem>) => (
            <Item
              item={entry().item}
              visibility={entry().visibility}
              onOpenOriginal={() => props.onOpenThread?.(entry().sourceThreadId)}
              syntax={syntax}
              wordWrap={props.wordWrap}
              timestampFormat={props.timestampFormat}
              onOpen={() => props.onOpenItem?.(entry())}
              onOpenFile={props.onOpenFile}
              onFocus={props.onFocus}
              expandAll={props.expandAll}
              expanded={expandedItems().has(transcriptItemKey(entry()))}
              onToggle={() => {
                const itemKey = transcriptItemKey(entry());
                const open = !expandedItems().has(itemKey);
                setExpandedItems((current) => {
                  const next = new Set(current);
                  if (open) next.add(itemKey);
                  else next.delete(itemKey);
                  return next;
                });
                if (!isGroup())
                  setExpandedGroups((current) => {
                    const next = new Set(current);
                    if (open) next.add(itemKey);
                    else next.delete(itemKey);
                    return next;
                  });
              }}
              highlighted={transcriptEntryMatches(entry(), props.highlightedEntryId)}
              cwd={props.cwd}
              onOpenLinks={props.onOpenLinks ? () => props.onOpenLinks!(entry()) : undefined}
              subscribeOutput={
                props.onCommandOutput
                  ? (onFrame, onError) => props.onCommandOutput!(entry(), onFrame, onError)
                  : undefined
              }
              onOpenHtml={props.onOpenHtml}
              onPreviewAsset={props.onPreviewAsset}
              loadAsset={props.loadAsset}
              onCopy={props.onCopyItem ? () => props.onCopyItem?.(entry()) : props.onCopy}
              onSecretRequest={props.onSecretRequest}
              rowRef={(node) => props.rowRef?.(entry(), node)}
            />
          );
          return (
            <Show when={visible()}>
              <WorkGroup
                row={row()}
                grouped={isGroup()}
                expanded={expanded()}
                timestampFormat={props.timestampFormat}
                onToggle={() => {
                  const close = expanded();
                  const keys = row().entries.map(transcriptItemKey);
                  setExpandedGroups((current) => {
                    const next = new Set(current);
                    if (close) for (const key of keys) next.delete(key);
                    else next.add(key);
                    return next;
                  });
                  setCollapsedGroups((current) => {
                    const next = new Set(current);
                    if (close) next.add(key);
                    else for (const key of keys) next.delete(key);
                    return next;
                  });
                }}
                onLoadWork={props.onLoadWork}
                onFocus={props.onFocus}
                rowRef={props.rowRef}
                renderItem={renderItem}
              />
            </Show>
          );
        }}
      </For>
    </Show>
  );
}
