// @effect-diagnostics nodeBuiltinImport:off -- The terminal SSH adapter owns its persistent local launcher identity.
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@t3tools/client-runtime/authorization";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  mapRemoteEnvironmentError,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import {
  AuthStandardClientScopes,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import { SshPasswordPromptError } from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import serverPackage from "../../../server/package.json" with { type: "json" };
import { createPrivateFile, preparePrivateDirectory } from "./files.ts";

export interface SshGatewayOptions {
  readonly configDir: string;
  readonly passwordPrompt?: SshAuth.SshPasswordPrompt["Service"];
  readonly runner?: SshTunnel.RemoteT3RunnerOptions;
}

const isPasswordPromptError = Schema.is(SshPasswordPromptError);

const preparationError = (cause: unknown) =>
  isPasswordPromptError(cause)
    ? new ConnectionBlockedError({ reason: "authentication", detail: cause.message })
    : new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: `Could not prepare the SSH environment: ${cause instanceof Error ? cause.message : String(cause)}`,
      });

const readLauncherId = (configDir: string) =>
  Effect.tryPromise({
    try: async () => {
      await preparePrivateDirectory(configDir);
      const filename = NodePath.join(configDir, "ssh-launcher-id");
      const stored = (
        await createPrivateFile(filename, `${NodeCrypto.randomUUID().replaceAll("-", "")}\n`)
      ).trim();
      if (!/^[0-9a-f]{32}$/u.test(stored)) throw new Error("Invalid SSH launcher identity.");
      return stored;
    },
    catch: preparationError,
  }).pipe(Effect.orElseSucceed(() => null));

export const makeSshGateway = Effect.gen(function* () {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const http = yield* HttpClient.HttpClient;
  const services =
    yield* Effect.context<Effect.Services<ReturnType<typeof manager.ensureEnvironment>>>();

  const ensure = (target: DesktopSshEnvironmentTarget, issuePairingToken: boolean) =>
    manager
      .ensureEnvironment(target, { issuePairingToken })
      .pipe(Effect.provideContext(services), Effect.mapError(preparationError));

  const descriptor = (bootstrap: DesktopSshEnvironmentBootstrap, expected?: EnvironmentId) =>
    fetchRemoteEnvironmentDescriptor({ httpBaseUrl: bootstrap.httpBaseUrl }).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.mapError(mapRemoteEnvironmentError),
      Effect.filterOrFail(
        (value) => expected === undefined || value.environmentId === expected,
        (value) =>
          new ConnectionBlockedError({
            reason: "configuration",
            detail: `That SSH host reaches ${value.label}, a different environment. Add it separately.`,
          }),
      ),
    );

  const provision = Effect.fn("tui.ssh.provision")(function* (
    target: DesktopSshEnvironmentTarget,
    expectedEnvironmentId?: EnvironmentId,
  ) {
    const bootstrap = yield* ensure(target, true);
    const remote = yield* descriptor(bootstrap, expectedEnvironmentId);
    if (bootstrap.pairingToken === null) {
      return yield* new ConnectionBlockedError({
        reason: "authentication",
        detail: "The SSH environment did not issue a pairing credential.",
      });
    }
    const access = yield* bootstrapRemoteBearerSession({
      httpBaseUrl: bootstrap.httpBaseUrl,
      credential: bootstrap.pairingToken,
      scopes: AuthStandardClientScopes,
      clientMetadata: { label: "T3 Code TUI", surface: "cli", deviceType: "desktop" },
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.mapError(mapRemoteEnvironmentError),
    );
    return {
      environmentId: remote.environmentId,
      label: remote.label,
      bootstrap,
      bearerToken: access.access_token,
    };
  });

  return ClientCapabilities.SshEnvironmentGateway.of({
    provision,
    prepare: Effect.fn("tui.ssh.prepare")(function* (input) {
      if (input.bearerToken !== undefined) {
        const bootstrap = yield* ensure(input.target, false);
        yield* descriptor(bootstrap, input.expectedEnvironmentId);
        const session = yield* fetchRemoteSessionState({
          httpBaseUrl: bootstrap.httpBaseUrl,
          bearerToken: input.bearerToken,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.mapError(mapRemoteEnvironmentError),
        );
        const granted = session.permissions ?? session.scopes ?? [];
        if (
          session.authenticated &&
          AuthStandardClientScopes.every((scope) => granted.includes(scope))
        ) {
          return { bootstrap, bearerToken: input.bearerToken };
        }
      }
      const result = yield* provision(input.target, input.expectedEnvironmentId);
      return { bootstrap: result.bootstrap, bearerToken: result.bearerToken };
    }),
    disconnect: Effect.fn("tui.ssh.disconnect")((target) =>
      manager
        .disconnectEnvironment(target)
        .pipe(Effect.provideContext(services), Effect.mapError(preparationError)),
    ),
  });
});

export const layerSshGateway = (options: SshGatewayOptions) => {
  const prompt =
    options.passwordPrompt ??
    SshAuth.SshPasswordPrompt.of({
      isAvailable: true,
      request: Effect.fn("tui.ssh.passwordPrompt")(() =>
        Effect.fail(
          new SshPasswordPromptError({
            message:
              "SSH authentication needs a password. Configure a TUI password prompt or load your key into ssh-agent.",
          }),
        ),
      ),
    });
  return Layer.effect(ClientCapabilities.SshEnvironmentGateway, makeSshGateway).pipe(
    Layer.provide(
      SshTunnel.SshEnvironmentManager.layer({
        resolveLauncherId: readLauncherId(options.configDir),
        resolveCliRunner: Effect.succeed(
          options.runner ?? {
            archiveVersion: serverPackage.version,
            ...(process.env.T3CODE_CLI_RELEASE_BASE_URL
              ? { releaseBaseUrl: process.env.T3CODE_CLI_RELEASE_BASE_URL }
              : {}),
          },
        ),
      }),
    ),
    Layer.provide(Layer.succeed(SshAuth.SshPasswordPrompt, prompt)),
    Layer.provide(NodeServices.layer),
    Layer.provide(NetService.layer),
  );
};
