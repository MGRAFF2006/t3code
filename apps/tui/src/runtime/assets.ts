import { type AssetImageDimensions, type AssetResource, WS_METHODS } from "@t3tools/contracts";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient, HttpClient } from "effect/http";

export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

export class AssetReadError extends Schema.TaggedError<AssetReadError>()("TuiAssetReadError", {
  message: Schema.String,
}) {}

const isAssetReadError = Schema.is(AssetReadError);

export interface AssetBytes {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly imageDimensions?: AssetImageDimensions;
}

export const fetchAssetBytes = Effect.fn("tui.fetchAssetBytes")(
  function* (url: string, imageDimensions?: AssetImageDimensions) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .get(url)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }));
    if (response.status < 200 || response.status >= 300)
      return yield* new AssetReadError({
        message: `Could not read this asset (HTTP ${response.status}).`,
      });
    const declaredSize = Number(response.headers["content-length"]);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_ASSET_BYTES)
      return yield* new AssetReadError({
        message: "This asset exceeds the terminal preview limit of 20 MiB.",
      });
    const chunks: Uint8Array[] = [];
    let length = 0;
    yield* Stream.runForEach(response.stream, (chunk) => {
      if (length + chunk.byteLength > MAX_ASSET_BYTES)
        return Effect.fail(
          new AssetReadError({
            message: "This asset exceeds the terminal preview limit of 20 MiB.",
          }),
        );
      return Effect.sync(() => {
        length += chunk.byteLength;
        chunks.push(chunk);
      });
    });
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      bytes,
      mimeType:
        response.headers["content-type"]?.split(";")[0]?.trim() ?? "application/octet-stream",
      ...(imageDimensions ? { imageDimensions } : {}),
    } satisfies AssetBytes;
  },
  Effect.mapError((error) =>
    isAssetReadError(error)
      ? error
      : new AssetReadError({
          message: "Could not read this asset. Reconnect or try a smaller file.",
        }),
  ),
  Effect.timeoutOrElse({
    duration: "20 seconds",
    orElse: () =>
      Effect.fail(
        new AssetReadError({
          message: "Reading this asset timed out. Try again after reconnecting.",
        }),
      ),
  }),
);

export const readAsset = Effect.fn("tui.readAsset")(function* (resource: AssetResource) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared))
    return yield* new AssetReadError({ message: "Connect to the asset's environment first." });
  const signed = yield* request(WS_METHODS.assetsCreateUrl, { resource });
  const url = resolveAssetUrl(prepared.value.httpBaseUrl, signed.relativeUrl);
  if (url === null)
    return yield* new AssetReadError({ message: "The environment returned an invalid asset URL." });
  return yield* fetchAssetBytes(url, signed.imageDimensions);
});
