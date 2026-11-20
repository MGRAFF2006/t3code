import type { MouseEvent } from "@opentui/core";
import { onBlur } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import { theme } from "../theme/index.ts";

export function PanelDivider(props: {
  side: "left" | "right";
  width: number;
  active?: boolean;
  onResize: (width: number) => void;
  onDragChange: (active: boolean) => void;
  onCommit: () => void;
  onConfigure: () => void;
}) {
  const [hovered, setHovered] = createSignal(false);
  const [drag, setDrag] = createSignal<{ x: number; width: number; moved: boolean }>();
  function move(event: MouseEvent) {
    const start = drag();
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.x !== start.x && !start.moved) setDrag({ ...start, moved: true });
    props.onResize(start.width + (event.x - start.x) * (props.side === "left" ? 1 : -1));
  }
  function finish() {
    const start = drag();
    if (!start) return;
    setDrag(undefined);
    props.onDragChange(false);
    if (start.moved && props.width !== start.width) props.onCommit();
  }
  onBlur(finish);
  onCleanup(() => {
    if (drag()) props.onDragChange(false);
  });
  return (
    <box
      id={`resize-${props.side}-panel`}
      width={1}
      height="100%"
      flexShrink={0}
      border={["left"]}
      borderColor={drag() || hovered() || props.active ? theme.primary : theme.border}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.button === 0) {
          setDrag({ x: event.x, width: props.width, moved: false });
          props.onDragChange(true);
        } else if (event.button === 2) props.onConfigure();
      }}
      onMouseDrag={move}
      onMouseUp={(event) => {
        move(event);
        finish();
      }}
      onMouseDragEnd={(event) => {
        move(event);
        finish();
      }}
    />
  );
}
