import { describe, expect, it } from "@effect/vitest";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import { AssetReadError, fetchAssetBytes, MAX_ASSET_BYTES } from "./assets.ts";

const signedUrl = "https://environment.test/api/assets/private-signed-token/image.png";
const responseLayer = (make: () => Response) =>
  layerRemoteHttpClient(
    Object.assign(async () => make(), { preconnect: globalThis.fetch.preconnect }),
  );

describe("terminal asset reads", () => {
  it.effect(
    "reads signed image bytes and metadata, while refusing oversized declared and streamed bodies",
    () =>
      Effect.gen(function* () {
        const image = new Uint8Array([137, 80, 78, 71]);
        const asset = yield* fetchAssetBytes(signedUrl, { width: 2, height: 3 }).pipe(
          Effect.provide(
            responseLayer(
              () =>
                new Response(image, { headers: { "content-type": "image/png; charset=binary" } }),
            ),
          ),
        );
        expect(asset).toEqual({
          bytes: image,
          mimeType: "image/png",
          imageDimensions: { width: 2, height: 3 },
        });
        const declared = yield* fetchAssetBytes(signedUrl).pipe(
          Effect.provide(
            responseLayer(
              () =>
                new Response(null, { headers: { "content-length": String(MAX_ASSET_BYTES + 1) } }),
            ),
          ),
          Effect.flip,
        );
        expect(declared.message).toContain("20 MiB");
        const streamed = yield* fetchAssetBytes(signedUrl).pipe(
          Effect.provide(responseLayer(() => new Response(new Uint8Array(MAX_ASSET_BYTES + 1)))),
          Effect.flip,
        );
        expect(streamed).toBeInstanceOf(AssetReadError);
        expect(streamed.message).not.toContain("private-signed-token");
      }),
  );
  it.effect("reports HTTP failures without exposing the signed URL", () =>
    Effect.gen(function* () {
      const error = yield* fetchAssetBytes(signedUrl).pipe(
        Effect.provide(responseLayer(() => new Response(null, { status: 403 }))),
        Effect.flip,
      );
      expect(error.message).toContain("HTTP 403");
      expect(error.message).not.toContain("private-signed-token");
    }),
  );
});
