// @effect-diagnostics nodeBuiltinImport:off -- The terminal OAuth adapter stores its own credentials in a private client state file.
import * as NodePath from "node:path";

import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import { CONNECT_OAUTH_SCOPES } from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

import { layerDpopSigner } from "./dpop.ts";
import {
  preparePrivateDirectory,
  readPrivateFile,
  removePrivateFile,
  writePrivateFile,
} from "./files.ts";

const Token = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
  accountId: Schema.String,
});
type Token = typeof Token.Type;
const TokenJson = Schema.fromJsonString(Token);
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
});
const AuthorizationResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Number),
});
const OAuthFailure = Schema.Struct({ error: Schema.String });
const IdentityClaims = Schema.fromJsonString(Schema.Struct({ sub: Schema.String }));
const decodeIdentityClaims = Schema.decodeUnknownOption(IdentityClaims);
const decodeTokenJson = Schema.decodeUnknownSync(TokenJson);
const encodeTokenJson = Schema.encodeSync(TokenJson);
const decodeOAuthFailure = Schema.decodeUnknownOption(OAuthFailure);
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const decodeAuthorizationResponse = Schema.decodeUnknownEffect(AuthorizationResponse);

export class CloudOAuthError extends Schema.TaggedError<CloudOAuthError>()("TuiCloudOAuthError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.String),
}) {}

export interface CloudAuthorizationPrompt {
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly userCode: string;
  readonly expiresInSeconds: number;
}

export interface CloudAccountOptions {
  readonly publishableKey?: string;
  readonly clientId?: string;
  readonly relayUrl?: string;
}

const isConnectionBlockedError = Schema.is(ConnectionBlockedError);
const isConnectionTransientError = Schema.is(ConnectionTransientError);
const isCloudOAuthError = Schema.is(CloudOAuthError);

const connectionError = (cause: unknown) =>
  isConnectionBlockedError(cause) || isConnectionTransientError(cause)
    ? cause
    : isCloudOAuthError(cause) &&
        (cause.code === "invalid_grant" ||
          cause.code === "access_denied" ||
          cause.code === "expired_token")
      ? new ConnectionBlockedError({
          reason: "authentication",
          detail: "T3 Connect authorization expired or was denied. Sign in again.",
        })
      : new ConnectionTransientError({
          reason: "network",
          detail: isCloudOAuthError(cause)
            ? cause.message
            : "Could not complete T3 Connect authorization.",
        });

function accountSubject(value: string | undefined) {
  const encoded = value?.split(".")[1];
  if (!encoded) return null;
  const decoded = Base64Url.decodeString(encoded);
  if (decoded._tag !== "Success") return null;
  return Option.getOrNull(decodeIdentityClaims(decoded.success))?.sub ?? null;
}

export async function createCloudAccount(configDir: string, options: CloudAccountOptions = {}) {
  await preparePrivateDirectory(configDir);
  const filename = NodePath.join(configDir, "cloud-oauth.json");
  const saved = await readPrivateFile(filename);
  let token: Token | null = null;
  if (saved !== null) {
    try {
      token = decodeTokenJson(saved);
    } catch {
      throw new Error(
        `Could not read saved T3 Connect credentials at ${filename}. The file was left unchanged.`,
      );
    }
  }
  // Public production OAuth settings match the repository's shipped .env.example.
  const publishableKey =
    options.publishableKey ??
    process.env.T3CODE_CLERK_PUBLISHABLE_KEY ??
    "pk_live_Y2xlcmsudDMuY29kZXMk";
  const clientId =
    options.clientId ?? process.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID ?? "hzxSgY2cH10sDU2r";
  const relayUrl = normalizeSecureRelayUrl(
    options.relayUrl ?? process.env.T3CODE_RELAY_URL ?? "https://relay.t3.codes",
  );
  if (relayUrl === null) throw new Error("T3CODE_RELAY_URL must be an HTTPS relay origin.");
  const lock = Semaphore.makeUnsafe(1);

  const metadata = Effect.try({
    try: () => {
      if (!publishableKey || !clientId) {
        throw new Error(
          "Set T3CODE_CLERK_PUBLISHABLE_KEY and T3CODE_CLERK_CLI_OAUTH_CLIENT_ID to the T3 Connect public OAuth configuration before signing in.",
        );
      }
      return { origin: clerkFrontendApiUrlFromPublishableKey(publishableKey), clientId };
    },
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "Invalid T3 Connect OAuth configuration.",
      }),
  });

  const persist = (next: Token) =>
    Effect.tryPromise({
      try: async () => {
        await writePrivateFile(filename, encodeTokenJson(next));
        token = next;
        return next;
      },
      catch: () =>
        new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: "Could not save the T3 Connect credential.",
        }),
    });

  const request = Effect.fn("tui.cloud.request")(function* (
    path: string,
    params: Record<string, string>,
  ) {
    const config = yield* metadata;
    const http = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(`${config.origin}${path}`).pipe(
      HttpClientRequest.bodyUrlParams({ ...params, client_id: config.clientId }),
      http.execute,
      Effect.timeout("10 seconds"),
    );
    const body = yield* response.json.pipe(Effect.timeout("10 seconds"));
    if (response.status < 200 || response.status >= 300) {
      const error = decodeOAuthFailure(body);
      return yield* new CloudOAuthError({
        message: `T3 Connect authorization request failed (HTTP ${response.status}).`,
        status: response.status,
        ...(Option.isSome(error) ? { code: error.value.error } : {}),
      });
    }
    return body;
  });

  const readToken = Effect.fn("tui.cloud.readToken")(function* (body: unknown, previous?: Token) {
    const value = yield* decodeTokenResponse(body);
    const accountId =
      accountSubject(value.id_token) ?? accountSubject(value.access_token) ?? previous?.accountId;
    const refreshToken = value.refresh_token ?? previous?.refreshToken;
    if (
      !accountId ||
      !refreshToken ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0
    ) {
      return yield* new CloudOAuthError({
        message: "T3 Connect returned an incomplete OAuth credential.",
      });
    }
    if (previous !== undefined && previous.accountId !== accountId) {
      return yield* new CloudOAuthError({
        message: "The refreshed T3 Connect credential belongs to another account.",
      });
    }
    return {
      accessToken: value.access_token,
      refreshToken,
      accountId,
      expiresAtEpochMs: (yield* Clock.currentTimeMillis) + value.expires_in * 1_000,
    };
  });

  const clerkToken = lock.withPermits(1)(
    Effect.gen(function* () {
      const current = token;
      if (current === null) {
        return yield* new ConnectionBlockedError({
          reason: "authentication",
          detail: "Sign in to T3 Connect first.",
        });
      }
      if (current.expiresAtEpochMs - 60_000 > (yield* Clock.currentTimeMillis))
        return current.accessToken;
      const refreshed = yield* request("/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      }).pipe(
        Effect.flatMap((body) => readToken(body, current)),
        Effect.flatMap(persist),
        Effect.uninterruptible,
        Effect.mapError(connectionError),
      );
      return refreshed.accessToken;
    }),
  );

  const identity = () =>
    Effect.sync(() =>
      token === null ? Option.none() : Option.some({ accountId: token.accountId }),
    );

  const login = <E, R>(
    showPrompt: (prompt: CloudAuthorizationPrompt) => Effect.Effect<void, E, R>,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const authorization = yield* request("/oauth/device_authorization", {
          scope: CONNECT_OAUTH_SCOPES.join(" "),
        }).pipe(Effect.flatMap(decodeAuthorizationResponse), Effect.mapError(connectionError));
        if (!Number.isFinite(authorization.expires_in) || authorization.expires_in <= 0) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: "T3 Connect returned an expired device authorization.",
          });
        }
        yield* showPrompt({
          verificationUri: authorization.verification_uri,
          ...(authorization.verification_uri_complete
            ? { verificationUriComplete: authorization.verification_uri_complete }
            : {}),
          userCode: authorization.user_code,
          expiresInSeconds: authorization.expires_in,
        });
        let interval = Math.max(1, authorization.interval ?? 5);
        const poll = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Duration.seconds(interval));
            const response = yield* request("/oauth/token", {
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: authorization.device_code,
            }).pipe(Effect.result);
            if (response._tag === "Success") {
              return yield* readToken(response.success).pipe(
                Effect.flatMap(persist),
                Effect.uninterruptible,
              );
            }
            const error = response.failure;
            if (isCloudOAuthError(error) && error.code === "authorization_pending") continue;
            if (
              (isCloudOAuthError(error) &&
                (error.code === "slow_down" || (error.status ?? 0) >= 500)) ||
              (HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError")
            ) {
              interval += 5;
              continue;
            }
            return yield* error;
          }
        });
        const next = yield* poll.pipe(
          Effect.timeout(Duration.seconds(authorization.expires_in)),
          Effect.mapError(connectionError),
        );
        return { accountId: next.accountId };
      }),
    );

  const logout = () =>
    lock.withPermits(1)(
      Effect.tryPromise({
        try: async () => {
          await removePrivateFile(filename);
          token = null;
        },
        catch: () =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: "Could not remove the T3 Connect credential.",
          }),
      }),
    );

  const layer = Layer.mergeAll(
    Layer.effect(
      ClientCapabilities.CloudSession,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        return ClientCapabilities.CloudSession.of({
          identity: identity(),
          clerkToken: clerkToken.pipe(Effect.provideService(HttpClient.HttpClient, http)),
        });
      }),
    ),
    Layer.succeed(ClientCapabilities.RelayDeviceIdentity, { deviceId: Effect.succeedNone }),
    layerDpopSigner(configDir),
  );

  return { layer, login, logout, identity, relayUrl, clientId: "t3-web" as const };
}
