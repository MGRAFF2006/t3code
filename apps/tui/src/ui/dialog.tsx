import { RGBA } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import type { ParentProps } from "solid-js";

import { theme } from "../theme/index.ts";

export function Dialog(
  props: ParentProps<{
    title: string;
    onClose: () => void;
    width?: number;
  }>,
) {
  const dimensions = useTerminalDimensions();
  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      justifyContent="center"
      position="absolute"
      zIndex={3000}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
      onMouseDown={props.onClose}
    >
      <box
        onMouseDown={(event) => event.stopPropagation()}
        width={Math.max(1, Math.min(props.width ?? 80, dimensions().width - 2))}
        maxHeight={Math.max(1, dimensions().height - 2)}
        backgroundColor={theme.backgroundPanel}
        padding={1}
      >
        <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <text fg={theme.text}>{props.title}</text>
          <text fg={theme.textMuted} flexShrink={0} onMouseDown={props.onClose}>
            esc
          </text>
        </box>
        {props.children}
      </box>
    </box>
  );
}
