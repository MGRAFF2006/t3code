import { Show } from "solid-js";
import { terminalActivityLabel } from "../presentation/terminal-activity.ts";
import { theme } from "../theme/index.ts";

export function TerminalActivity(props: { count: number; onOpen: () => void }) {
  return (
    <Show when={props.count > 0}>
      <text
        selectable={false}
        height={1}
        flexShrink={0}
        fg={theme.error}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          props.onOpen();
        }}
      >
        {terminalActivityLabel(props.count)}
      </text>
    </Show>
  );
}
