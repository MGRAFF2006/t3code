import type { SyntaxStyle } from "@opentui/core";
import { createMemo, For, Show } from "solid-js";
import { MarkdownMessage } from "../transcript.tsx";
import { NativeImagePreview } from "../presentation/media.tsx";
import { theme } from "../theme/index.ts";
import { notebookImageBytes, notebookPreview } from "./file-preview.logic.ts";

export function NotebookPreview(props: {
  contents: string;
  syntax: SyntaxStyle;
  wrap: boolean;
  truncated: boolean;
  images: boolean;
  toggleImages: () => void;
}) {
  const notebook = createMemo(() => {
    if (props.truncated)
      return {
        value: null,
        error:
          "The notebook source was truncated. Open an external viewer for the complete document.",
      };
    try {
      return { value: notebookPreview(props.contents), error: "" };
    } catch (cause) {
      return {
        value: null,
        error: cause instanceof Error ? cause.message : "Could not read this notebook.",
      };
    }
  });
  return (
    <box>
      <Show when={notebook().error}>
        <text fg={theme.warning} wrapMode="word">
          {notebook().error}
        </text>
      </Show>
      <For each={notebook().value?.cells}>
        {(cell, index) => (
          <box marginBottom={1}>
            <text
              fg={theme.textMuted}
            >{`${cell.kind === "code" ? "Code" : cell.kind === "markdown" ? "Markdown" : "Raw"} cell ${index() + 1}`}</text>
            <Show
              when={cell.kind === "markdown"}
              fallback={
                <code
                  content={cell.source}
                  filetype={cell.kind === "code" ? (notebook().value?.language ?? "text") : "text"}
                  syntaxStyle={props.syntax}
                  drawUnstyledText
                  wrapMode={props.wrap ? "word" : "none"}
                />
              }
            >
              <MarkdownMessage
                content={cell.source}
                streaming={false}
                syntax={props.syntax}
                wordWrap={props.wrap}
              />
            </Show>
            <For each={cell.outputs}>
              {(output) => {
                return (
                  <Show
                    when={output.kind === "image"}
                    fallback={
                      <text fg={theme.textMuted} wrapMode={props.wrap ? "word" : "none"}>
                        {output.kind === "text" ? output.text : ""}
                      </text>
                    }
                  >
                    <text
                      selectable={false}
                      fg={theme.primary}
                      onMouseDown={props.toggleImages}
                    >{`${props.images ? "Hide" : "Show"} cached output images`}</text>
                    <Show when={props.images && output.kind === "image" ? output : null}>
                      {(image) => (
                        <NativeImagePreview
                          label="Notebook output"
                          load={async () => ({
                            bytes: notebookImageBytes(image().base64),
                            mimeType: image().mimeType,
                          })}
                          maxHeight={18}
                          maxWidth={72}
                        />
                      )}
                    </Show>
                  </Show>
                );
              }}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}
