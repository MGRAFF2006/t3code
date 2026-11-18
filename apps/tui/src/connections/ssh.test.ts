import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  EnvironmentId,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeSshGateway } from "./ssh.ts";

const target: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: null,
};

function setup(options: { remoteEnvironmentId?: string; granted?: readonly string[] } = {}) {
  const requests: { path: string; authorization: string | undefined }[] = [];
  const issuedPairings: boolean[] = [];
  const manager = SshTunnel.SshEnvironmentManager.of({
    ensureEnvironment: (_target, input) =>
      Effect.sync(() => {
        issuedPairings.push(input?.issuePairingToken === true);
        return {
          target,
          httpBaseUrl: "http://127.0.0.1:3201/",
          wsBaseUrl: "ws://127.0.0.1:3201/",
          pairingToken: input?.issuePairingToken ? "bootstrap-token" : null,
        };
      }),
    disconnectEnvironment: () => Effect.void,
    closeAllTunnels: Effect.void,
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      requests.push({ path, authorization: request.headers.authorization });
      const body =
        path === "/.well-known/t3/environment"
          ? {
              environmentId: options.remoteEnvironmentId ?? "environment-ssh",
              label: "SSH environment",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.1.10",
              capabilities: { repositoryIdentity: true },
            }
          : path === "/api/auth/session"
            ? {
                authenticated: true,
                permissions: options.granted ?? AuthStandardClientScopes,
                auth: {
                  policy: "remote-reachable",
                  bootstrapMethods: ["one-time-token"],
                  sessionMethods: ["bearer-access-token"],
                  sessionCookieName: "t3_session",
                },
              }
            : {
                access_token: "new-access-token",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "Bearer",
                expires_in: 3600,
                scope: AuthStandardClientScopes.join(" "),
              };
      return HttpClientResponse.fromWeb(request, Response.json(body));
    }),
  );
  return {
    requests,
    issuedPairings,
    gateway: makeSshGateway.pipe(
      Effect.provide([
        Layer.succeed(SshTunnel.SshEnvironmentManager, manager),
        Layer.succeed(HttpClient.HttpClient, http),
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        SshAuth.SshPasswordPrompt.disabledLayer,
      ]),
    ),
  };
}

it.effect(
  "checks SSH environment identity before transmitting a saved token or spending a pairing credential",
  () =>
    Effect.gen(function* () {
      const fixture = setup({ remoteEnvironmentId: "another-environment" });
      const gateway = yield* fixture.gateway;
      const failed = yield* gateway
        .prepare({
          connectionId: "ssh:test",
          expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
          target,
          bearerToken: "saved-token",
        })
        .pipe(Effect.flip);
      expect(failed).toMatchObject({ reason: "configuration" });
      expect(fixture.issuedPairings).toEqual([false]);
      expect(fixture.requests).toEqual([
        { path: "/.well-known/t3/environment", authorization: undefined },
      ]);
    }),
);

it.effect(
  "reuses a fully scoped SSH credential and re-pairs when standard permissions are missing",
  () =>
    Effect.gen(function* () {
      const fixture = setup();
      const gateway = yield* fixture.gateway;
      const input = {
        connectionId: "ssh:test",
        expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
        target,
        bearerToken: "saved-token",
      };
      expect((yield* gateway.prepare(input)).bearerToken).toBe("saved-token");
      expect(fixture.issuedPairings).toEqual([false]);
      expect(fixture.requests.map((request) => request.path)).toEqual([
        "/.well-known/t3/environment",
        "/api/auth/session",
      ]);

      const missing = setup({ granted: ["orchestration:read"] });
      const missingGateway = yield* missing.gateway;
      expect((yield* missingGateway.prepare(input)).bearerToken).toBe("new-access-token");
      expect(missing.issuedPairings).toEqual([false, true]);
      expect(missing.requests.map((request) => request.path)).toEqual([
        "/.well-known/t3/environment",
        "/api/auth/session",
        "/.well-known/t3/environment",
        "/oauth/token",
      ]);
    }),
);
