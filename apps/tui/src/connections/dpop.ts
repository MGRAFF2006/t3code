// @effect-diagnostics nodeBuiltinImport:off -- Bun signs relay proofs with the client-owned persistent P-256 key.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { DpopProof } from "@t3tools/client-runtime/relay";
import { DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { createPrivateFile, readPrivateFile } from "./files.ts";

const decodePublicJwk = Schema.decodeUnknownSync(DpopPublicJwk);

export const loadProofKey = (configDir: string) =>
  Effect.tryPromise({
    try: async () => {
      const filename = NodePath.join(configDir, "relay-dpop-key.pem");
      let pem = await readPrivateFile(filename);
      if (pem === null) {
        const pair = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        pem = await createPrivateFile(
          filename,
          pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        );
      }
      const key = NodeCrypto.createPrivateKey(pem);
      const publicJwk = decodePublicJwk(NodeCrypto.createPublicKey(key).export({ format: "jwk" }));
      return {
        publicJwk,
        sign: (input: Uint8Array) =>
          Effect.try({
            try: () =>
              new Uint8Array(NodeCrypto.sign("sha256", input, { key, dsaEncoding: "ieee-p1363" })),
            catch: (cause) =>
              new DpopProof.DpopProofError({ message: "Could not sign the relay request.", cause }),
          }),
      } satisfies DpopProof.DpopProofKey;
    },
    catch: (cause) =>
      new DpopProof.DpopProofError({
        message: "Could not load the terminal client's relay key.",
        cause,
      }),
  });

export const layerDpopSigner = (configDir: string) =>
  DpopProof.layerSigner({ keyStore: "file", loadOrCreateKey: loadProofKey(configDir) });
