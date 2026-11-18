import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import * as fuzzysort from "fuzzysort";

import { theme } from "../theme/index.ts";
import { Dialog } from "./dialog.tsx";
import { moveSelection, reconcileSelection, revealSelectionOffset } from "./select-controller.ts";

export interface DialogSelectOption<T> {
  title: string;
  value: T;
  description?: string | undefined;
  category?: string | undefined;
  searchText?: string;
  disabled?: boolean;
}

export interface DialogSelectProps<T> {
  title: string;
  options: readonly DialogSelectOption<T>[];
  current?: T;
  placeholder?: string;
  onSelect: (option: DialogSelectOption<T>) => void;
  onCancel: () => void;
}

export function DialogSelect<T>(props: DialogSelectProps<T>) {
  const dimensions = useTerminalDimensions();
  const [filter, setFilter] = createSignal("");
  const [selected, setSelected] = createSignal(
    Math.max(
      0,
      props.options
        .filter((option) => !option.disabled)
        .findIndex((option) => option.value === props.current),
    ),
  );
  const [offset, setOffset] = createSignal(0);
  const limit = createMemo(() => Math.max(1, Math.min(18, dimensions().height - 10)));
  const filtered = createMemo(() => {
    const options = props.options.filter((option) => !option.disabled);
    const needle = filter().toLowerCase();
    if (!needle) return options;
    return fuzzysort
      .go(needle, options, {
        keys: ["title", "category", "searchText"],
        scoreFn: (result) =>
          (result[0]?.score ?? 0) * 2 + (result[1]?.score ?? 0) + (result[2]?.score ?? 0),
      })
      .map((result) => result.obj);
  });
  const active = createMemo(() => reconcileSelection(selected(), filtered().length));
  const start = createMemo(() =>
    revealSelectionOffset(offset(), {
      count: filtered().length,
      limit: limit(),
      selected: active(),
    }),
  );
  const visible = createMemo(() => filtered().slice(start(), start() + limit()));

  function move(delta: number) {
    setOffset(start());
    setSelected(moveSelection(active(), { count: filtered().length, delta, policy: "wrap" }));
  }

  function submit() {
    const option = filtered()[active()];
    if (option) props.onSelect(option);
  }

  useKeyboard((event) => {
    if (event.name === "escape") props.onCancel();
    else if (event.name === "up" || (event.ctrl && event.name === "p")) move(-1);
    else if (event.name === "down" || (event.ctrl && event.name === "n")) move(1);
    else if (event.name === "pageup") move(-limit());
    else if (event.name === "pagedown") move(limit());
    else if (event.name === "home" && event.ctrl) setSelected(0);
    else if (event.name === "end" && event.ctrl) setSelected(filtered().length - 1);
    else if (event.name === "return") submit();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  return (
    <Dialog title={props.title} onClose={props.onCancel}>
      <input
        focused
        value={filter()}
        placeholder={props.placeholder ?? "Search…"}
        backgroundColor={theme.backgroundElement}
        focusedBackgroundColor={theme.backgroundElement}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.primary}
        onInput={(value) => {
          setFilter(value);
          setSelected(0);
          setOffset(0);
        }}
      />
      <box marginTop={1}>
        <Show
          when={visible().length > 0}
          fallback={<text fg={theme.textMuted}>No matching items</text>}
        >
          <For each={visible()}>
            {(option, index) => (
              <box
                flexDirection="row"
                backgroundColor={
                  start() + index() === active() ? theme.backgroundElement : theme.backgroundPanel
                }
                onMouseDown={() => props.onSelect(option)}
              >
                <text fg={theme.primary} width={2} flexShrink={0}>
                  {start() + index() === active() ? "┃" : " "}
                </text>
                <text fg={theme.text} flexGrow={1} truncate>
                  {option.title}
                </text>
                <Show when={option.category}>
                  <text fg={theme.textMuted} flexShrink={0}>
                    {option.category}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </box>
      <Show when={filtered()[active()]?.description}>
        <text marginTop={1} fg={theme.textMuted} wrapMode="word">
          {filtered()[active()]?.description}
        </text>
      </Show>
      <text marginTop={1} fg={theme.textMuted}>
        ↑↓ select · enter confirm · esc back · {filtered().length} items
      </text>
    </Dialog>
  );
}
