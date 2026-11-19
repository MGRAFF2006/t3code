import { scrollbarOptions } from "./ui/scroll.ts";
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { createSignal, Show } from "solid-js";

import { theme } from "./theme/index.ts";
import { Dialog } from "./ui/dialog.tsx";

export interface FormProps {
  title: string;
  description?: string;
  initialValue: string;
  multiline?: boolean;
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}

export function Form(props: FormProps) {
  const dimensions = useTerminalDimensions();
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let input: TextareaRenderable | undefined;

  async function submit() {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(input?.plainText ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  useKeyboard((event) => {
    if (event.name === "escape" && !busy()) props.onCancel();
    else if (
      (event.ctrl && event.name === "s") ||
      event.name === "f2" ||
      (event.name === "return" && (event.ctrl || !props.multiline))
    )
      void submit();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  return (
    <Dialog
      title={props.title}
      width={100}
      onClose={() => {
        if (!busy()) props.onCancel();
      }}
    >
      <Show when={props.description}>
        <scrollbox
          scrollbarOptions={scrollbarOptions()}
          maxHeight={Math.max(2, Math.min(8, dimensions().height - 14))}
        >
          <text fg={theme.textMuted} wrapMode="word">
            {props.description}
          </text>
        </scrollbox>
      </Show>
      <textarea
        keyBindings={[{ name: "a", ctrl: true, action: "select-all" }]}
        ref={(element) => {
          input = element;
        }}
        focused={!busy()}
        initialValue={props.initialValue}
        height={props.multiline ? Math.max(2, Math.min(14, dimensions().height - 12)) : 1}
        backgroundColor={theme.backgroundElement}
        focusedBackgroundColor={theme.backgroundElement}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.primary}
      />
      <Show when={error()}>
        <text fg={theme.error} wrapMode="word">
          {error()}
        </text>
      </Show>
      <text marginTop={1} fg={theme.textMuted}>
        {busy() ? "Working…" : `${props.multiline ? "ctrl+s" : "enter"} apply · esc back`}
      </text>
    </Dialog>
  );
}

export function SecretForm(props: {
  title: string;
  description: string;
  onSubmit: (value: string | null) => void;
}) {
  const [secret, setSecret] = createSignal("");
  function finish(value: string | null) {
    setSecret("");
    props.onSubmit(value);
  }
  usePaste((event) => {
    setSecret((current) => current + new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, ""));
    event.preventDefault();
  });
  useKeyboard((event) => {
    if (event.name === "escape") finish(null);
    else if (event.name === "return") finish(secret());
    else if (event.name === "backspace")
      setSecret((value) => Array.from(value).slice(0, -1).join(""));
    else if (event.ctrl && event.name === "u") setSecret("");
    else if (!event.ctrl && !event.meta && !/[\x00-\x1f\x7f]/.test(event.sequence))
      setSecret((value) => value + event.sequence);
    event.preventDefault();
    event.stopPropagation();
  });
  return (
    <Dialog title={props.title} onClose={() => finish(null)}>
      <text fg={theme.textMuted} wrapMode="word">
        {props.description}
      </text>
      <text fg={theme.text} marginTop={1}>
        {"•".repeat(Math.min(64, Array.from(secret()).length)) || "Enter password"}
      </text>
      <text fg={theme.textMuted} marginTop={1}>
        enter continue · esc cancel · ctrl+u clear
      </text>
    </Dialog>
  );
}
