// @effect-diagnostics nodeBuiltinImport:off -- The Bun platform owns atomic files and their Unix credential permissions.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CredentialStore,
  ProfileStore,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  Persistence,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
  setRoutesInCatalog,
  replaceCatalogValue,
  putRemoteDpopTokenInCatalog,
} from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const CatalogJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeCatalog = Schema.decodeSync(CatalogJson);
const encodeCatalog = Schema.encodeSync(CatalogJson);

export async function createStorage(configDir: string) {
  const filename = NodePath.join(configDir, "connections.json");
  await NodeFSP.mkdir(configDir, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(configDir, 0o700);
  await NodeFSP.writeFile(NodePath.join(configDir, ".gitignore"), "*\n!.gitignore\n", {
    mode: 0o600,
  });
  let document: ConnectionCatalogDocument;
  try {
    document = decodeCatalog(await NodeFSP.readFile(filename, "utf8"));
    await NodeFSP.chmod(filename, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      // oxlint-disable-next-line preserve-caught-error -- Decoder errors can contain credential values.
      throw new Error(
        `Could not read saved TUI connections at ${filename}. The document was left unchanged.`,
      );
    }
    document = EMPTY_CONNECTION_CATALOG_DOCUMENT;
  }
  let temporaryOrdinal = 0;
  let pending: Promise<void> = Promise.resolve();
  const update = (transform: (current: ConnectionCatalogDocument) => ConnectionCatalogDocument) =>
    Effect.tryPromise({
      try: () => {
        const next = pending.then(async () => {
          const lockPath = `${filename}.lock`;
          const lock = await NodeFSP.open(lockPath, "wx", 0o600);
          try {
            let current = EMPTY_CONNECTION_CATALOG_DOCUMENT;
            try {
              current = decodeCatalog(await NodeFSP.readFile(filename, "utf8"));
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                throw error;
            }
            const changed = transform(current);
            const temporary = `${filename}.${process.pid}.${temporaryOrdinal++}.tmp`;
            try {
              await NodeFSP.writeFile(temporary, encodeCatalog(changed), {
                mode: 0o600,
                flag: "wx",
              });
              await NodeFSP.rename(temporary, filename);
              document = changed;
            } finally {
              await NodeFSP.rm(temporary, { force: true });
            }
          } finally {
            await lock.close();
            await NodeFSP.rm(lockPath);
          }
        });
        pending = next.catch(() => undefined);
        return next;
      },
      catch: (error) =>
        new ConnectionTransientError({
          reason: "remote-unavailable",
          detail:
            error instanceof Error && "code" in error && error.code === "EEXIST"
              ? `Saved TUI connections are locked. Retry after other TUI writes finish. If no TUI is running, remove ${filename}.lock.`
              : `Could not save TUI connections at ${filename}. Check its permissions and available disk space.`,
        }),
    });
  const persist = (
    operation: Persistence.ConnectionPersistenceError["operation"],
    transform: (current: ConnectionCatalogDocument) => ConnectionCatalogDocument,
  ) =>
    update(transform).pipe(
      Effect.mapError(
        (error) =>
          new Persistence.ConnectionPersistenceError({ operation, message: error.message }),
      ),
    );
  const connectionLayers = Layer.mergeAll(
    Layer.succeed(Persistence.ConnectionTargetStore, {
      list: Effect.sync(() => document.targets),
      listDisabled: Effect.sync(() => document.disabledEnvironmentIds),
    }),
    Layer.succeed(Persistence.ConnectionRegistrationStore, {
      register: Effect.fn("TuiConnectionStorage.register")((registration, routes) =>
        persist("register-connection", (value) =>
          registerConnectionInCatalog(value, registration, routes),
        ),
      ),
      setRoutes: Effect.fn("TuiConnectionStorage.setRoutes")((environmentId, routes) =>
        persist("set-connection-routes", (value) =>
          setRoutesInCatalog(value, environmentId, routes),
        ),
      ),
      remove: Effect.fn("TuiConnectionStorage.remove")((environmentId) =>
        persist("remove-connection", (value) => removeConnectionFromCatalog(value, environmentId)),
      ),
      setEnabled: Effect.fn("TuiConnectionStorage.setEnabled")((environmentId, enabled) =>
        persist("set-connection-enabled", (value) =>
          setConnectionEnabledInCatalog(value, environmentId, enabled),
        ),
      ),
    }),
    Layer.succeed(CredentialStore.ConnectionCredentialStore, {
      get: Effect.fn("TuiCredentialStorage.get")((connectionId) =>
        Effect.sync(() =>
          Option.fromUndefinedOr(
            document.credentials.find((value) => value.connectionId === connectionId)?.credential,
          ),
        ),
      ),
      put: Effect.fn("TuiCredentialStorage.put")((connectionId, credential) =>
        update((value) => ({
          ...value,
          credentials: replaceCatalogValue(value.credentials, (item) => item.connectionId, {
            connectionId,
            credential,
          }),
        })),
      ),
      remove: Effect.fn("TuiCredentialStorage.remove")((connectionId) =>
        update((value) => ({
          ...value,
          credentials: value.credentials.filter((item) => item.connectionId !== connectionId),
        })),
      ),
    }),
    Layer.succeed(ProfileStore.ConnectionProfileStore, {
      get: Effect.fn("TuiProfileStorage.get")((connectionId) =>
        Effect.sync(() =>
          Option.fromUndefinedOr(
            document.profiles.find((value) => value.connectionId === connectionId),
          ),
        ),
      ),
      put: Effect.fn("TuiProfileStorage.put")((profile) =>
        update((value) => ({
          ...value,
          profiles: replaceCatalogValue(value.profiles, (item) => item.connectionId, profile),
        })),
      ),
      remove: Effect.fn("TuiProfileStorage.remove")((connectionId) =>
        update((value) => ({
          ...value,
          profiles: value.profiles.filter((item) => item.connectionId !== connectionId),
        })),
      ),
    }),
    Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, {
      get: Effect.fn("TuiDpopTokenStorage.get")((environmentId) =>
        Effect.sync(() =>
          Option.fromUndefinedOr(
            document.remoteDpopTokens.find((value) => value.environmentId === environmentId),
          ),
        ),
      ),
      put: Effect.fn("TuiDpopTokenStorage.put")((token) =>
        update((value) => putRemoteDpopTokenInCatalog(value, token)),
      ),
      remove: Effect.fn("TuiDpopTokenStorage.remove")((environmentId) =>
        update((value) => ({
          ...value,
          remoteDpopTokens: value.remoteDpopTokens.filter(
            (item) => item.environmentId !== environmentId,
          ),
        })),
      ),
    }),
  );
  const cache: Persistence.EnvironmentCacheStore["Service"] = {
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  };
  return Layer.merge(connectionLayers, Layer.succeed(Persistence.EnvironmentCacheStore, cache));
}
