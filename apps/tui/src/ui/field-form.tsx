import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createSignal, For, Show } from "solid-js";
import { theme } from "../theme/index.ts";
import { Dialog } from "./dialog.tsx";
import type { Field, FieldFormOptions } from "./controller.ts";

export function FieldForm(props: { options: FieldFormOptions; onClose: () => void }) {
  const dimensions = useTerminalDimensions();
  const [values, setValues] = createSignal<Record<string, string>>(
    Object.fromEntries(props.options.fields.map((field) => [field.name, field.value ?? ""])),
  );
  const [active, setActive] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let editor: TextareaRenderable | undefined;
  let fields: ScrollBoxRenderable | undefined;
  // Focused fields need revealing in the native scroll viewport after layout.
  createEffect(() => {
    const index = active();
    const viewport = fields;
    viewport?.afterLayout(() => {
      if (!viewport.isDestroyed) viewport.scrollChildIntoView(`form-field-${index}`);
    });
  });
  function update(field: Field, value: string) {
    setValues((current) => ({ ...current, [field.name]: value }));
  }
  function flush() {
    const field = props.options.fields[active()];
    if (field && editor) update(field, editor.plainText);
  }
  function move(delta: number) {
    if (props.options.fields.length === 0) return;
    flush();
    editor = undefined;
    setActive(
      (index) => (index + delta + props.options.fields.length) % props.options.fields.length,
    );
  }
  function cycle(field: Field, delta: number) {
    const options =
      field.type === "toggle"
        ? [
            { label: "Off", value: "false" },
            { label: "On", value: "true" },
          ]
        : (field.options ?? []);
    if (!options.length) return;
    const index = options.findIndex((option) => option.value === values()[field.name]);
    update(field, options[(index + delta + options.length) % options.length]!.value);
  }
  async function submit() {
    if (busy()) return;
    flush();
    for (const field of props.options.fields) {
      const value = values()[field.name] ?? "";
      if (field.required && !value.trim()) {
        setError(`${field.label} is required.`);
        return;
      }
      if (field.type === "number" && value && !Number.isFinite(Number(value))) {
        setError(`${field.label} must be a number.`);
        return;
      }
    }
    setError(null);
    setBusy(true);
    try {
      await props.options.onSubmit(values());
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  usePaste((event) => {
    const field = props.options.fields[active()];
    if (field?.type !== "secret" || busy()) return;
    update(
      field,
      (values()[field.name] ?? "") + new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, ""),
    );
    event.preventDefault();
  });
  useKeyboard((event) => {
    if (busy()) return;
    const field = props.options.fields[active()];
    if (event.name === "escape") props.onClose();
    else if (event.name === "tab") move(event.shift ? -1 : 1);
    else if ((event.ctrl && event.name === "s") || event.name === "f2") void submit();
    else if (
      field &&
      ["select", "toggle"].includes(field.type ?? "") &&
      ["left", "right", "space", "return"].includes(event.name)
    )
      cycle(field, event.name === "left" ? -1 : 1);
    else if (event.name === "return" && field?.type !== "multiline") {
      if (active() === props.options.fields.length - 1) void submit();
      else move(1);
    } else if (field?.type === "secret") {
      if (event.name === "backspace")
        update(
          field,
          Array.from(values()[field.name] ?? "")
            .slice(0, -1)
            .join(""),
        );
      else if (event.ctrl && event.name === "u") update(field, "");
      else if (!event.ctrl && !event.meta && !/[\x00-\x1f\x7f]/.test(event.sequence))
        update(field, (values()[field.name] ?? "") + event.sequence);
      else return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });
  return (
    <Dialog title={props.options.title} width={88} onClose={() => !busy() && props.onClose()}>
      <Show when={props.options.description}>
        <text fg={theme.textMuted} wrapMode="word" marginBottom={1}>
          {props.options.description}
        </text>
      </Show>
      <scrollbox
        ref={(element) => {
          fields = element;
        }}
        maxHeight={Math.max(3, dimensions().height - 12)}
      >
        <For each={props.options.fields}>
          {(field, index) => (
            <box
              id={`form-field-${index()}`}
              marginBottom={1}
              onMouseDown={() => {
                if (busy() || active() === index()) return;
                flush();
                editor = undefined;
                setActive(index());
              }}
            >
              <text selectable={false} fg={active() === index() ? theme.primary : theme.text}>
                {active() === index() ? "› " : "  "}
                {field.label}
                {field.required ? " *" : ""}
              </text>
              <Show when={field.description}>
                <text fg={theme.textMuted} wrapMode="word">
                  {" "}
                  {field.description}
                </text>
              </Show>
              <Show
                when={field.type === "select" || field.type === "toggle"}
                fallback={
                  <Show
                    when={active() === index() && field.type !== "secret"}
                    fallback={
                      <text selectable={false} fg={theme.textMuted} truncate>
                        {" "}
                        {field.type === "secret"
                          ? "•".repeat((values()[field.name] ?? "").length)
                          : values()[field.name] || "…"}
                      </text>
                    }
                  >
                    <textarea
                      ref={(element) => {
                        editor = element;
                      }}
                      focused={!busy()}
                      initialValue={values()[field.name] ?? ""}
                      height={field.type === "multiline" ? 4 : 1}
                      backgroundColor={theme.backgroundElement}
                      focusedBackgroundColor={theme.backgroundElement}
                      textColor={theme.text}
                      focusedTextColor={theme.text}
                      cursorColor={theme.primary}
                    />
                  </Show>
                }
              >
                <text selectable={false} fg={theme.text}>
                  {"  ‹ "}
                  {field.type === "toggle"
                    ? values()[field.name] === "true"
                      ? "On"
                      : "Off"
                    : (field.options?.find((option) => option.value === values()[field.name])
                        ?.label ?? "Choose…")}
                  {" ›"}
                </text>
              </Show>
            </box>
          )}
        </For>
      </scrollbox>
      <Show when={error()}>
        <text fg={theme.error} wrapMode="word">
          {error()}
        </text>
      </Show>
      <text selectable={false} fg={theme.primary} marginTop={1} onMouseDown={() => void submit()}>
        {busy() ? "Working…" : (props.options.submitLabel ?? "Save")}
      </text>
      <text fg={theme.textMuted}>tab next field · ←→ choose · ctrl+s / F2 save · esc cancel</text>
    </Dialog>
  );
}
