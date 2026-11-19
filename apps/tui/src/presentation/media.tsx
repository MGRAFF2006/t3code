import { type ImageRenderProtocol, type TerminalCapabilities } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createResource, createSignal, Show } from "solid-js";
import type { AssetBytes } from "../runtime/assets.ts";
import { createTerminalCapabilities } from "./terminal.ts";
import { theme } from "../theme/index.ts";

export function terminalGraphicsSummary(capabilities: TerminalCapabilities | null): string {
  if (!capabilities) return "Detecting terminal graphics…";
  const protocol = capabilities.image_protocol;
  if (protocol === "kitty" || (!protocol && capabilities.kitty_graphics)) return "Kitty graphics";
  if (protocol === "sixel" || (!protocol && capabilities.sixel)) return "Sixel graphics";
  return "Terminal block preview";
}

export function NativeImagePreview(props: {
  load: () => Promise<AssetBytes>;
  label: string;
  protocol?: ImageRenderProtocol;
  maxHeight?: number;
  maxWidth?: number;
}) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const capabilities = createTerminalCapabilities(renderer);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [asset, { refetch }] = createResource(props.load);
  const width = () => Math.max(1, Math.min(props.maxWidth ?? 88, dimensions().width - 8));
  const height = () => Math.max(1, Math.min(props.maxHeight ?? 24, dimensions().height - 10));
  return (
    <box gap={1}>
      <text fg={theme.text}>{props.label}</text>
      <Show when={!asset.loading} fallback={<text fg={theme.textMuted}>Loading image…</text>}>
        <Show
          when={!asset.error && !failure()}
          fallback={
            <box>
              <text fg={theme.error} wrapMode="word">
                {failure() ??
                  (asset.error instanceof Error
                    ? asset.error.message
                    : "This image could not be loaded.")}
              </text>
              <text
                selectable={false}
                fg={theme.primary}
                onMouseDown={() => {
                  setFailure(null);
                  void refetch();
                }}
              >
                Retry image
              </text>
            </box>
          }
        >
          <Show when={asset()}>
            {(value) => (
              <image
                source={value().bytes}
                width={width()}
                height={height()}
                fit="fit"
                protocol={props.protocol ?? "auto"}
                onError={(error) =>
                  setFailure(
                    error instanceof Error
                      ? error.message
                      : "This image format cannot be displayed in the terminal.",
                  )
                }
              />
            )}
          </Show>
        </Show>
      </Show>
      <text fg={theme.textMuted}>{terminalGraphicsSummary(capabilities())}</text>
    </box>
  );
}
