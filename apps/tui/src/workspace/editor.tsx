import { getTreeSitterClient, pathToFiletype, type TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createSignal, onCleanup, onMount, untrack } from "solid-js";
import { createSyntax } from "../theme/syntax.ts";
import { theme } from "../theme/index.ts";

export function FileEditor(props: {
  path: string;
  contents: string;
  focused: boolean;
  wrap: boolean;
  onChange: (contents: string) => void;
  onFocus: () => void;
  onHighlightError: (message: string) => void;
}) {
  const syntax = createSyntax(useRenderer().nativeScene);
  const [cursor, setCursor] = createSignal({ line: 0, visualColumn: 0 });
  const language = pathToFiletype(props.path);
  const initialValue = untrack(() => props.contents);
  let editor: TextareaRenderable | undefined;
  let active = true;
  let highlighting = false;
  let warned = false;

  async function highlight() {
    if (!editor || !language || highlighting || !active) return;
    const target = editor;
    const contents = target.plainText;
    highlighting = true;
    try {
      const result = await getTreeSitterClient().highlightOnce(contents, language);
      if (!active || contents !== target.plainText) return;
      target.clearAllHighlights();
      for (const [start, end, name] of result.highlights ?? []) {
        const styleId = syntax.resolveStyleId(name);
        if (styleId !== null) target.addHighlightByCharRange({ start, end, styleId });
      }
    } catch (cause) {
      if (active && !warned) {
        warned = true;
        props.onHighlightError(`Syntax highlighting unavailable: ${String(cause)}`);
      }
    } finally {
      highlighting = false;
      if (active && target.plainText !== contents) void highlight();
    }
  }

  onMount(() => void highlight());
  onCleanup(() => {
    active = false;
    syntax.destroy();
  });

  return (
    <box flexGrow={1} minHeight={0}>
      <textarea
        keyBindings={[{ name: "a", ctrl: true, action: "select-all" }]}
        ref={(value) => {
          editor = value;
        }}
        initialValue={initialValue}
        focused={props.focused}
        flexGrow={1}
        wrapMode={props.wrap ? "word" : "none"}
        syntaxStyle={syntax}
        backgroundColor={theme.background}
        focusedBackgroundColor={theme.background}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.primary}
        onMouseDown={props.onFocus}
        onCursorChange={setCursor}
        onContentChange={() => {
          if (!editor) return;
          props.onChange(editor.plainText);
          void highlight();
        }}
      />
      <text fg={theme.textMuted} flexShrink={0}>
        {`${language ?? "text"}  Ln ${cursor().line + 1}, Col ${cursor().visualColumn + 1}   ctrl+s save · esc close editor`}
      </text>
    </box>
  );
}
