import { useRenderer } from "@opentui/solid";
import { onCleanup, Show } from "solid-js";
import { MarkdownMessage } from "../transcript.tsx";
import { createSyntax } from "../theme/syntax.ts";
import { theme } from "../theme/index.ts";

export function DetailText(props: { content: string; language?: string | undefined }) {
  const syntax = createSyntax(useRenderer().nativeScene);
  onCleanup(() => syntax.destroy());
  return (
    <Show
      when={props.language === "markdown"}
      fallback={
        <Show
          when={props.language === "diff"}
          fallback={
            <text fg={theme.text} wrapMode="word">
              {props.content}
            </text>
          }
        >
          <workspace_diff
            diff={props.content}
            view="unified"
            syntaxStyle={syntax}
            fg={theme.text}
            wrapMode="none"
            showLineNumbers
            addedBg={theme.diffAddedBg}
            removedBg={theme.diffRemovedBg}
            contextBg={theme.background}
          />
        </Show>
      }
    >
      <MarkdownMessage content={props.content} streaming={false} syntax={syntax} />
    </Show>
  );
}
