import { scrollbarOptions } from "./scroll.ts";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import * as fuzzysort from "fuzzysort";

import { theme } from "../theme/index.ts";
import { Dialog } from "./dialog.tsx";
import { moveSelection, reconcileSelection, revealSelectionOffset } from "./select-controller.ts";

export interface DialogSelectOption<T> {
  title: string;
  color?: string;
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
  const descriptionRows = () => (dimensions().height >= 24 ? 3 : 2);
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
  const limit = createMemo(() =>
    Math.max(
      1,
      Math.min(
        18,
        dimensions().height -
          (dimensions().height < 20 ? 8 : 10) -
          (filtered()[active()]?.description ? descriptionRows() + 1 : 0),
      ),
    ),
  );
  const start = createMemo(() =>
    revealSelectionOffset(offset(), {
      count: filtered().length,
      limit: limit(),
      selected: active(),
    }),
  );
  const visible = createMemo(() => filtered().slice(start(), start() + limit()));
  const range = (brief = false) => {
    const count = filtered().length;
    const end = start() + visible().length;
    if (visible().length === count) return `${count} item${count === 1 ? "" : "s"}`;
    if (brief)
      return `${start() > 0 ? "↑ " : ""}${start() + 1}–${end}/${count}${end < count ? " ↓" : ""}`;
    const more = [start() > 0 ? `↑${start()}` : "", end < count ? `↓${count - end}` : ""]
      .filter(Boolean)
      .join(" ");
    return `${start() + 1}–${end}/${count} · ${more} more`;
  };

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
        keyBindings={[{ name: "a", ctrl: true, action: "select-all" }]}
        flexShrink={0}
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
      <box marginTop={1} flexShrink={0}>
        <Show
          when={visible().length > 0}
          fallback={<text fg={theme.textMuted}>No matching items</text>}
        >
          <For each={visible()}>
            {(option, index) => (
              <box
                flexDirection="row"
                height={1}
                flexShrink={0}
                gap={1}
                backgroundColor={
                  start() + index() === active() ? theme.backgroundElement : theme.backgroundPanel
                }
                onMouseDown={() => props.onSelect(option)}
              >
                <text selectable={false} fg={theme.primary} width={1} flexShrink={0}>
                  {start() + index() === active() ? "┃" : " "}
                </text>
                <text
                  selectable={false}
                  fg={option.color ?? theme.text}
                  flexGrow={1}
                  minWidth={0}
                  truncate
                >
                  {option.title}
                </text>
                <Show when={option.category}>
                  <text
                    selectable={false}
                    fg={theme.textMuted}
                    maxWidth={Math.max(
                      1,
                      Math.floor((Math.min(80, dimensions().width - 2) - 4) / 3),
                    )}
                    truncate
                  >
                    {option.category}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </box>
      <Show when={filtered()[active()]?.description}>
        <scrollbox
          scrollbarOptions={scrollbarOptions()}
          marginTop={1}
          maxHeight={descriptionRows()}
          flexShrink={0}
        >
          <text fg={theme.textMuted} wrapMode="word">
            {filtered()[active()]?.description}
          </text>
        </scrollbox>
      </Show>
      <text marginTop={1} height={1} flexShrink={0} fg={theme.textMuted} truncate>
        {dimensions().width < 80
          ? `${range(dimensions().width < 60)} · Enter · Esc`
          : `↑↓ select · enter confirm · esc back · ${range()}`}
      </text>
    </Dialog>
  );
}
