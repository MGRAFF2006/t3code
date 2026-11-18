// @effect-diagnostics nodeBuiltinImport:off -- Connection tests use disposable private credential files and verify the platform signature.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { createCloudAccount, type CloudAuthorizationPrompt } from "./cloud.ts";
import { loadProofKey } from "./dpop.ts";
import { preparePrivateDirectory } from "./files.ts";

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-connections-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);

it.effect(
  "persists one private relay key across launches and produces verifiable ES256 signatures",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory;
        yield* Effect.promise(() => preparePrivateDirectory(directory));
        const first = yield* loadProofKey(directory);
        const reopened = yield* loadProofKey(directory);
        expect(reopened.publicJwk).toEqual(first.publicJwk);
        const input = new TextEncoder().encode("relay proof signing input");
        const signature = yield* reopened.sign(input);
        const publicKey = NodeCrypto.createPublicKey({ key: first.publicJwk, format: "jwk" });
        expect(
          NodeCrypto.verify(
            "sha256",
            input,
            { key: publicKey, dsaEncoding: "ieee-p1363" },
            signature,
          ),
        ).toBe(true);
        const stat = yield* Effect.promise(() =>
          NodeFSP.stat(NodePath.join(directory, "relay-dpop-key.pem")),
        );
        if ((yield* HostProcess.Platform) !== "win32") expect(stat.mode & 0o777).toBe(0o600);
      }),
    ),
);

it.effect(
  "completes device authorization with slow-down, refreshes rotated credentials, and clears local sign-in",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory;
        const requests: URLSearchParams[] = [];
        let poll = 0;
        const idToken = `e30.${Base64Url.encode(JSON.stringify({ sub: "account-one" }))}.signature`;
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            const params = new URLSearchParams(
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
            );
            requests.push(params);
            let status = 200;
            let body: unknown;
            if (request.url.endsWith("/oauth/device_authorization")) {
              body = {
                device_code: "device-code",
                user_code: "ABCD-EFGH",
                verification_uri: "https://accounts.example.test/device",
                expires_in: 600,
                interval: 1,
              };
            } else if (params.get("grant_type") === "refresh_token") {
              body = {
                access_token: "refreshed-access",
                refresh_token: "rotated-refresh",
                expires_in: 3600,
              };
            } else {
              poll += 1;
              status = poll < 3 ? 400 : 200;
              body =
                poll === 1
                  ? { error: "authorization_pending" }
                  : poll === 2
                    ? { error: "slow_down" }
                    : {
                        access_token: "initial-access",
                        refresh_token: "initial-refresh",
                        id_token: idToken,
                        expires_in: 1,
                      };
            }
            return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
          }),
        );
        const config = {
          publishableKey: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
          clientId: "oauth-client-test",
        };
        const account = yield* Effect.promise(() => createCloudAccount(directory, config));
        const prompt = yield* Deferred.make<CloudAuthorizationPrompt>();
        const login = yield* account
          .login((value) => Deferred.succeed(prompt, value).pipe(Effect.asVoid))
          .pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.forkChild);
        expect((yield* Deferred.await(prompt)).userCode).toBe("ABCD-EFGH");
        yield* TestClock.adjust(Duration.seconds(8));
        expect(yield* Fiber.join(login)).toEqual({ accountId: "account-one" });
        const access = yield* ClientCapabilities.CloudSession.pipe(
          Effect.flatMap((session) => session.clerkToken),
          Effect.provide(
            account.layer.pipe(
              Layer.provide([Layer.succeed(HttpClient.HttpClient, http), NodeCryptoLayer.layer]),
            ),
          ),
        );
        expect(access).toBe("refreshed-access");
        expect(
          requests.filter(
            (params) => params.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code",
          ),
        ).toHaveLength(3);
        expect(requests.at(-1)?.get("refresh_token")).toBe("initial-refresh");
        const reopened = yield* Effect.promise(() => createCloudAccount(directory, config));
        expect(Option.getOrNull(yield* reopened.identity())).toEqual({ accountId: "account-one" });
        const saved = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory, "cloud-oauth.json"), "utf8"),
        );
        expect(JSON.parse(saved)).toMatchObject({ refreshToken: "rotated-refresh" });
        yield* reopened.logout();
        expect(Option.isNone(yield* reopened.identity())).toBe(true);
        const signedOut = yield* Effect.promise(() => createCloudAccount(directory, config));
        expect(Option.isNone(yield* signedOut.identity())).toBe(true);
      }),
    ),
);
