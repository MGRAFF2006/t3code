import { Connection, Connectivity, Wakeups } from "@t3tools/client-runtime/connection";
import { ClientCapabilities, PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import type * as SshAuth from "@t3tools/ssh/auth";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { createCloudAccount } from "../connections/cloud.ts";
import { layerSshGateway } from "../connections/ssh.ts";
import { createStorage } from "./storage.ts";

export async function createClientLayer(
  configDir: string,
  passwordPrompt: SshAuth.SshPasswordPrompt["Service"],
) {
  const storage = await createStorage(configDir);
  const cloud = await createCloudAccount(configDir);
  const http = layerRemoteHttpClient(globalThis.fetch);
  const platform = Layer.mergeAll(
    storage,
    http,
    Socket.layerWebSocketConstructorGlobal,
    SecureRandom.layerWebCrypto,
    Digest.layerWebCrypto,
    Connectivity.layer({ status: Effect.succeed("unknown"), changes: Stream.empty }),
    Wakeups.layer({ changes: Stream.empty }),
    Layer.succeed(PlatformConnectionSource.PlatformConnectionSource, {
      registrations: Stream.empty,
    }),
    Layer.succeed(ClientCapabilities.ClientPresentation, {
      metadata: { label: "T3 Code TUI", surface: "cli", deviceType: "desktop" },
    }),
    Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, { bearerToken: Effect.succeedNone }),
  );
  const capabilities = Layer.mergeAll(
    cloud.layer,
    layerSshGateway({ configDir, passwordPrompt }),
  ).pipe(Layer.provideMerge(platform));
  const relay = ManagedRelay.layer({ relayUrl: cloud.relayUrl, clientId: cloud.clientId }).pipe(
    Layer.provideMerge(capabilities),
  );
  const connected = Connection.layerWithOptions({
    usageLimitSources: true,
    usageLimitsCommand: true,
  }).pipe(Layer.provideMerge(relay));
  const layer = Layer.mergeAll(
    ShellSnapshotLoader.layer,
    BoundedThreadSnapshotLoader.layer,
    ThreadHistoryController.layer,
  ).pipe(Layer.provideMerge(connected));
  return { layer, cloud };
}
