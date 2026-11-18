import { filePreviewDelimiter, parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { createMemo, For, Show } from "solid-js";
import { theme } from "../theme/index.ts";

export function DelimitedPreview(props: { name: string; contents: string }) {
  const table = createMemo(() =>
    parseDelimitedPreview(props.contents, filePreviewDelimiter(props) ?? ","),
  );
  const widths = createMemo(() => {
    const columns = Math.max(0, ...table().rows.map((row) => row.length));
    return Array.from(
      { length: columns },
      (_, column) =>
        Math.min(
          26,
          Math.max(
            4,
            ...table().rows.map((row) => (row[column] ?? "").replaceAll(/[\r\n\t]/g, " ").length),
          ),
        ) + 2,
    );
  });
  return (
    <box>
      <For each={table().rows}>
        {(row, index) => (
          <box flexDirection="row" height={1} flexShrink={0}>
            <For each={widths()}>
              {(width, column) => (
                <text
                  width={width}
                  flexShrink={0}
                  truncate
                  fg={index() === 0 ? theme.primary : theme.text}
                >
                  {(row[column()] ?? "").replaceAll(/\r?\n|\r/g, " ↵ ").replaceAll("\t", " ")}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
      <Show when={table().truncated}>
        <text fg={theme.warning}>
          Table preview truncated. Show source or open the external viewer for the complete file.
        </text>
      </Show>
    </box>
  );
}
