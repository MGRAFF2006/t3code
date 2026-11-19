// @effect-diagnostics nodeBuiltinImport:off -- The terminal platform resolves its local credential directory and display names.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionOnboarding,
  ConnectionBlockedError,
  connectionRoutes,
  routeHttpBaseUrl,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  fetchRemoteEnvironmentDescriptor,
  deriveWsBaseUrl,
  normalizeHttpBaseUrl,
} from "@t3tools/client-runtime/environment";

import { Discovery } from "@t3tools/client-runtime/relay";
import { fetchRemoteSessionState } from "@t3tools/client-runtime/authorization";
import type { SshPasswordRequest } from "@t3tools/ssh/auth";
import { SshPasswordPromptError } from "@t3tools/ssh/errors";
import { createEnvironmentShellAtoms } from "@t3tools/client-runtime/state/shell";
import {
  createEnvironmentThreadStateAtoms,
  createEnvironmentThreadDetailAtoms,
  createThreadEnvironmentAtoms,
  createThreadFamilyAtoms,
  createOlderSettledThreadAtoms,
  unloadedOlderSettledCount,
} from "@t3tools/client-runtime/state/threads";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createThreadVisitTracker } from "@t3tools/client-runtime/state/thread-visits";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import {
  createCommandPermissions,
  createRuntimeCommand,
  type AtomCommand,
  environmentSessionGenerationAtom,
  executeConnectedEnvironmentHttpRequest,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  GuestMessageId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  RuntimeRequestId,
  RunId,
  NodeId,
  ThreadId,
  WS_METHODS,
  type DesktopSshEnvironmentTarget,
  type ModelSelection,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ProjectedTurnItem,
  type AssetResource,
  type PullRequestDiffInput,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type ChatAttachment,
  type CommandId,
  type ServerSelfUpdateInput,
  type RuntimeMode,
  type OrchestrationMessageContext,
  UserInputAttachments,
  type ServerConfig,
  type ScopedThreadRef,
  type AuthEnvironmentScope,
  sessionGrantsScope,
  type ProjectReadFileResult,
  type VcsStatusResult,
  type T3ProjectFile,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "@t3tools/contracts";
import {
  resolveProjectSettings,
  resolveNewThreadEnvMode,
  resolveSendEnvMode,
} from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { CloudAuthorizationPrompt } from "../connections/cloud.ts";
import { createClientLayer } from "./platform.ts";
import { createRpcBridge } from "../rpc/bridge.ts";
import { createAuthEnvironmentAtoms } from "@t3tools/client-runtime/state/auth";
import { createLocalAttachmentUploads, type LocalAttachment } from "./attachments.ts";
import { createPreferences } from "./preferences.ts";
import { readAsset } from "./assets.ts";
import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { PREVIEW_STREAM_BASE_PATH } from "@t3tools/client-runtime/preview/server-browser-stream";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { services } from "../rpc/catalog.ts";
const decodeQuestionAttachments = Schema.decodeUnknownSync(UserInputAttachments);

export interface TuiConnectionOptions {
  readonly url?: string;
  readonly pairingUrl?: string;
  readonly token?: string;
  readonly configDir?: string;
}

export interface ThreadLaunchOptions {
  readonly modelSelection?: ModelSelection;
  readonly context?: OrchestrationMessageContext;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly localAttachments?: ReadonlyArray<LocalAttachment>;
  readonly threadId?: ThreadId;
  readonly commandId?: CommandId;
  readonly messageId?: MessageId;
  readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy;
  readonly runtimeMode?: RuntimeMode;
}

export interface TuiSnapshot {
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
  readonly connection: string;
  readonly error: string | null;
  readonly config: ServerConfig | null;
  readonly shell: OrchestrationV2ShellSnapshot | null;
  readonly olderSettled?: {
    readonly remaining: number;
    readonly loading: boolean;
    readonly error: string | null;
  };
  readonly selectedThreadId: ThreadId | null;
  readonly thread: OrchestrationV2ThreadProjection | null;
  readonly hasMoreHistory: boolean;
  readonly workspaceMutationId: string | null;
}

type PasswordHandler = (request: SshPasswordRequest) => Promise<string | null>;

function createPasswordPrompt() {
  interface PendingRequest {
    readonly request: SshPasswordRequest;
    readonly resume: (effect: Effect.Effect<string | null, SshPasswordPromptError>) => void;
    dispatched: boolean;
  }
  let handler: PasswordHandler | undefined;
  let closed = false;
  const pending = new Set<PendingRequest>();
  const complete = (
    entry: PendingRequest,
    result: Effect.Effect<string | null, SshPasswordPromptError>,
  ) => {
    if (pending.delete(entry)) entry.resume(result);
  };
  const dispatch = (entry: PendingRequest) => {
    const currentHandler = handler;
    if (!currentHandler || entry.dispatched) return;
    entry.dispatched = true;
    void Promise.resolve()
      .then(() => currentHandler(entry.request))
      .then(
        (password) => complete(entry, Effect.succeed(password)),
        () =>
          complete(
            entry,
            Effect.fail(
              new SshPasswordPromptError({ message: "The SSH password prompt was closed." }),
            ),
          ),
      );
  };
  return {
    service: {
      isAvailable: true,
      request: Effect.fn("tui.ssh.requestPassword")((request: SshPasswordRequest) =>
        Effect.callback<string | null, SshPasswordPromptError>((resume) => {
          if (closed) {
            resume(Effect.succeed(null));
            return;
          }
          const entry = { request, resume, dispatched: false };
          pending.add(entry);
          dispatch(entry);
          return Effect.sync(() => {
            pending.delete(entry);
          });
        }),
      ),
    },
    setHandler: (next: PasswordHandler) => {
      if (closed) return;
      handler = next;
      for (const entry of pending) dispatch(entry);
    },
    close: () => {
      closed = true;
      handler = undefined;
      for (const entry of pending) complete(entry, Effect.succeed(null));
    },
  };
}

export async function createTuiClient(options: TuiConnectionOptions = {}) {
  const configDir =
    options.configDir ?? NodePath.join(NodeOS.homedir(), ".local", "state", "t3-tui");
  const preferences = await createPreferences(configDir);
  const passwords = createPasswordPrompt();
  const { layer, cloud } = await createClientLayer(configDir, passwords.service);
  const runtime = Atom.runtime(layer);
  const registry = AtomRegistry.make();
  const run = async <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => {
    const command = createRuntimeCommand(runtime, { label: "tui:runtime", execute: () => effect });
    const result = await command.run(registry, undefined);
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };
  const uuid = () => run(Effect.flatMap(SecureRandom.SecureRandom, (random) => random.uuidV4()));
  const shellAtoms = createEnvironmentShellAtoms(runtime);
  const threadAtoms = createEnvironmentThreadStateAtoms(runtime);
  const threadDetails = createEnvironmentThreadDetailAtoms(threadAtoms.stateAtom);
  const families = createThreadFamilyAtoms(runtime, shellAtoms.stateAtom);
  const olderSettled = createOlderSettledThreadAtoms(runtime, shellAtoms.stateAtom);
  const shellSnapshot = families.snapshotAtom;
  const threadCommands = createThreadEnvironmentAtoms(runtime, shellSnapshot);
  const sessions = createEnvironmentSessionAtoms(runtime);
  const localUploads = createLocalAttachmentUploads(runtime, registry);
  const auth = createAuthEnvironmentAtoms(runtime);
  const server = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: sessions.initialConfigValueAtom,
    usageLimitSources: true,
    usageLimitsCommand: true,
  });
  let environmentId: EnvironmentId | null = null;
  let label = "T3 Code";
  try {
    if (options.pairingUrl) {
      const pairingUrl = options.pairingUrl;
      environmentId = await run(
        ConnectionOnboarding.ConnectionOnboarding.pipe(
          Effect.flatMap((onboarding) => onboarding.registerPairing({ pairingUrl })),
        ),
      );
      label = "T3 Code";
    } else if (options.url) {
      const httpBaseUrl = normalizeHttpBaseUrl(options.url);
      const descriptor = await run(fetchRemoteEnvironmentDescriptor({ httpBaseUrl }));
      const targetId = descriptor.environmentId;
      environmentId = targetId;
      label = descriptor.label;
      await run(
        Effect.gen(function* () {
          const connections = yield* EnvironmentRegistry.EnvironmentRegistry;
          if (options.token) {
            const token = options.token;
            const session = yield* fetchRemoteSessionState({ httpBaseUrl, bearerToken: token });
            if (!session.authenticated)
              return yield* new ConnectionBlockedError({
                reason: "authentication",
                detail:
                  "The supplied token was not accepted. Saved connections were left unchanged.",
              });
            const connectionId = `bearer:${environmentId}:${new URL(httpBaseUrl).origin}`;
            yield* connections.register(
              new BearerConnectionRegistration({
                target: new BearerConnectionTarget({
                  environmentId: targetId,
                  label,
                  connectionId,
                }),
                profile: new BearerConnectionProfile({
                  connectionId,
                  environmentId: targetId,
                  label,
                  httpBaseUrl,
                  wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
                }),
                credential: new BearerConnectionCredential({ token }),
              }),
            );
          } else {
            const saved = (yield* SubscriptionRef.get(connections.entries)).get(targetId);
            if (saved) {
              const routes = connectionRoutes(saved);
              if (!routes.some((route) => routeHttpBaseUrl(route) === httpBaseUrl)) {
                if (!routes.some((route) => route.target._tag === "BearerConnectionTarget")) {
                  return yield* new ConnectionBlockedError({
                    reason: "configuration",
                    detail:
                      "A saved SSH or T3 Connect route already exists for this environment. Start without --connect to reuse it.",
                  });
                }
                const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
                yield* onboarding.updateBearer({
                  environmentId: targetId,
                  label: saved.target.label,
                  httpBaseUrl,
                });
              }
              if (!saved.enabled) yield* connections.setEnabled(targetId, true);
              label = saved.target.label;
            } else {
              yield* connections.reconcilePlatform([
                new PrimaryConnectionRegistration({
                  target: new PrimaryConnectionTarget({
                    environmentId: targetId,
                    label,
                    httpBaseUrl,
                    wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
                  }),
                }),
              ]);
            }
          }
        }),
      );
    } else {
      const entry = await run(
        EnvironmentRegistry.EnvironmentRegistry.pipe(
          Effect.flatMap((connections) =>
            Effect.map(SubscriptionRef.get(connections.entries), (entries) =>
              [...entries.values()].find((candidate) => candidate.enabled),
            ),
          ),
        ),
      );
      if (entry) {
        environmentId = entry.target.environmentId;
        label = entry.target.label;
      }
    }
  } catch (error) {
    passwords.close();
    registry.dispose();
    throw error;
  }
  let snapshot: TuiSnapshot = {
    environmentId,
    label,
    connection: environmentId === null ? "disconnected" : "connecting",
    error: null,
    config: null,
    shell: null,
    selectedThreadId: null,
    thread: null,
    hasMoreHistory: false,
    workspaceMutationId: null,
  };
  const listeners = new Set<(value: TuiSnapshot) => void>();
  const stops = new Set<() => void>();
  const transportStops = new Set<() => void>();
  let stopThread: (() => void) | undefined;
  let preferredModel: ModelSelection | null = null;
  let closed = false;
  const update = (patch: Partial<TuiSnapshot>) => {
    if (closed) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener(snapshot);
  };
  const observe = <A>(atom: Atom.Atom<A>, listener: (value: A) => void, owners = stops) => {
    const dispose = registry.subscribe(atom, listener, { immediate: true });
    owners.add(dispose);
    return () => {
      owners.delete(dispose);
      dispose();
    };
  };
  const requireEnvironment = () => {
    if (environmentId === null) throw new Error("Connect to an environment first.");
    return environmentId;
  };
  const observeAvailability = (atom: Atom.Atom<boolean>, onChange: (allowed: boolean) => void) => {
    if (closed) {
      onChange(false);
      return () => {};
    }
    let active = true;
    const dispose = registry.subscribe(atom, onChange, { immediate: true });
    const stop = () => {
      if (!active) return;
      active = false;
      stops.delete(stop);
      dispose();
      onChange(false);
    };
    stops.add(stop);
    return stop;
  };
  const localVisits = new Map<string, string>();
  const withLocalVisits = (
    destination: EnvironmentId,
    shell: OrchestrationV2ShellSnapshot | null,
  ) => {
    if (shell === null || localVisits.size === 0) return shell;
    const visited = (thread: OrchestrationV2ShellSnapshot["threads"][number]) => {
      if (thread.lastVisitedAt !== undefined) return thread;
      const value = localVisits.get(threadKey({ environmentId: destination, threadId: thread.id }));
      return value ? { ...thread, lastVisitedAt: DateTime.makeUnsafe(value) } : thread;
    };
    return {
      ...shell,
      threads: shell.threads.map(visited),
      archivedThreads: shell.archivedThreads.map(visited),
    };
  };
  const viewedThreadAtom = Atom.make<(ScopedThreadRef & { readonly wokeAt: string | null }) | null>(
    null,
  );
  const visitShells = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) => {
      const viewed = get(viewedThreadAtom);
      if (viewed?.environmentId !== ref.environmentId || viewed.threadId !== ref.threadId)
        return null;
      const shell = get(shellSnapshot(ref.environmentId));
      const source =
        shell?.threads.find((thread) => thread.id === ref.threadId) ??
        shell?.archivedThreads.find((thread) => thread.id === ref.threadId);
      return source
        ? { ...presentThreadShell(ref.environmentId, source), wokeAt: viewed.wokeAt }
        : null;
    });
  });
  const markLocalVisit = (ref: ScopedThreadRef, visitedAt: string) => {
    const key = threadKey(ref);
    const previous = localVisits.get(key);
    if (previous && Date.parse(previous) >= Date.parse(visitedAt)) return;
    localVisits.set(key, visitedAt);
    if (ref.environmentId === environmentId)
      update({
        shell: withLocalVisits(ref.environmentId, registry.get(shellSnapshot(ref.environmentId))),
      });
  };
  const visits = createThreadVisitTracker({
    threadShellAtom: (ref) => visitShells(threadKey(ref)),
    sessionGenerationAtom: (id) => environmentSessionGenerationAtom(runtime, id),
    visit: threadCommands.visit,
    markLocalVisit,
  });
  let stopVisits: (() => void) | undefined;
  const clearViewedThread = () => {
    if (closed) return;
    registry.set(viewedThreadAtom, null);
    stopVisits?.();
    stopVisits = undefined;
  };
  const setViewedThread = (id: string | null, wokeAt: string | null = null) => {
    if (closed) return;
    const threadId = id === null ? null : ThreadId.make(id);
    if (environmentId === null || threadId === null || snapshot.selectedThreadId !== threadId) {
      clearViewedThread();
      return;
    }
    const current = registry.get(viewedThreadAtom);
    if (current?.environmentId === environmentId && current.threadId === threadId) {
      if (current.wokeAt !== wokeAt) registry.set(viewedThreadAtom, { ...current, wokeAt });
      return;
    }
    clearViewedThread();
    const ref = { environmentId, threadId };
    registry.set(viewedThreadAtom, { ...ref, wokeAt });
    stopVisits = registry.mount(visits(ref));
  };
  let loadOlderSettled: () => void = () => {
    throw new Error("Connect to an environment first.");
  };
  const observeEnvironment = () => {
    if (environmentId === null) return;
    const currentEnvironmentId = environmentId;
    const connectionAtom = runtime.atom(
      Stream.unwrap(
        EnvironmentRegistry.EnvironmentRegistry.pipe(
          Effect.map((connections) => connections.stateChanges(currentEnvironmentId)),
        ),
      ),
    );
    observe(connectionAtom, (result) => {
      if (result._tag === "Success")
        update({
          connection: result.value.phase,
          error: result.value.lastFailure?.message ?? null,
        });
      else if (result._tag === "Failure") update({ error: Cause.pretty(result.cause) });
    });
    observe(shellAtoms.stateValueAtom(currentEnvironmentId), (state) => {
      if (Option.isSome(state.error)) update({ error: state.error.value });
    });
    observe(shellSnapshot(currentEnvironmentId), (shell) =>
      update({ shell: withLocalVisits(currentEnvironmentId, shell) }),
    );
    const scope = { environmentId: currentEnvironmentId, projectIds: null };
    let pageCount = 0;
    let releasePages: (() => void) | undefined;
    const mountPages = () => {
      const pages = pageCount;
      const releaseRows = families.mountRows(
        registry,
        currentEnvironmentId,
        olderSettled.rowsKey(scope, pages),
        olderSettled.pageRowsAtom(scope, pages),
      );
      const status = Atom.make((get) => {
        const shelf = get(olderSettled.pagesAtom(scope, pages));
        const older = get(olderSettled.olderSettledAtom(currentEnvironmentId));
        const shell = get(shellSnapshot(currentEnvironmentId));
        return {
          remaining: unloadedOlderSettledCount({
            scopes: [scope],
            olderSettled: () => older,
            threads: (shell?.threads ?? []).map((source) => ({
              environmentId: currentEnvironmentId,
              source,
            })),
          }),
          loading: shelf.status === "pending",
          error:
            shelf.status === "failed" ? "Could not load earlier settled threads. Retry." : null,
        };
      });
      const stop = observe(status, (olderSettled) => update({ olderSettled }));
      const previous = releasePages;
      releasePages = () => {
        stop();
        releaseRows();
      };
      previous?.();
    };
    mountPages();
    stops.add(() => releasePages?.());
    loadOlderSettled = () => {
      if (snapshot.olderSettled?.loading) return;
      if (snapshot.olderSettled?.error) olderSettled.retryPages(registry, scope, pageCount);
      else {
        pageCount += 1;
        mountPages();
      }
    };
    observe(server.configValueAtom(currentEnvironmentId), (config) =>
      update({ config, ...(config ? { label: config.environment.label } : {}) }),
    );
  };
  observeEnvironment();

  const accessCommand =
    <Input, Value, Failure>(
      command: AtomCommand<
        {
          readonly environmentId: EnvironmentId;
          readonly input: Input;
        },
        Value,
        Failure
      >,
    ) =>
    async (input: Input) => {
      const destination = requireEnvironment();
      const result = await command.run(registry, { environmentId: destination, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    };
  const { invoke, stream } = createRpcBridge(runtime, registry, requireEnvironment, observe);
  const requireThread = () => {
    if (snapshot.selectedThreadId === null) throw new Error("Select a thread first.");
    return snapshot.selectedThreadId;
  };
  const requireAvailableModel = (): ModelSelection => {
    const provider = snapshot.config?.providers.find(
      (candidate) => candidate.enabled && candidate.installed && candidate.models.length > 0,
    );
    const model = provider?.models.find((candidate) => candidate.isDefault) ?? provider?.models[0];
    if (!provider || !model)
      throw new Error(
        "No available provider model. Configure a provider or wait for the environment to connect.",
      );
    return { instanceId: provider.instanceId, model: model.slug };
  };
  const requireModel = () =>
    snapshot.thread?.thread.modelSelection ?? preferredModel ?? requireAvailableModel();
  const requireNewThreadModel = (projectId: ProjectId) => {
    const config = snapshot.config;
    const project = snapshot.shell?.projects.find((value) => value.id === projectId);
    const settings = config
      ? resolveProjectSettings(config.settings, projectId, project).settings
      : null;
    const selection =
      preferredModel ??
      settings?.defaultModelSelection ??
      project?.defaultModelSelection ??
      requireAvailableModel();
    if (!config) return selection;
    return (
      resolveNewThreadModelSelection({
        explicitSelection: preferredModel,
        defaultSelection: selection,
        fallbackSelection: settings?.fallbackModelSelection ?? null,
        providers: config.providers,
        settings: config.settings,
        projectId,
        now: DateTime.toEpochMillis(DateTime.nowUnsafe()),
      }).selection ?? selection
    );
  };
  const selectThread = (id: string | null) => {
    if (id !== null) requireEnvironment();
    if (snapshot.selectedThreadId !== id) clearViewedThread();
    stopThread?.();
    stopThread = undefined;
    update({
      selectedThreadId: id === null ? null : ThreadId.make(id),
      thread: null,
      hasMoreHistory: false,
      workspaceMutationId: null,
    });
    if (id === null) return;
    const stopState = observe(
      threadAtoms.stateAtom(requireEnvironment(), ThreadId.make(id)),
      (result) => {
        if (result._tag === "Success")
          update({
            thread: Option.getOrNull(result.value.data),
            hasMoreHistory: result.value.history.hasMoreHistory,
            ...(Option.isSome(result.value.error) ? { error: result.value.error.value } : {}),
          });
        else if (result._tag === "Failure") update({ error: Cause.pretty(result.cause) });
      },
    );
    const stopMutation = observe(
      threadDetails.workspaceMutationIdAtom({
        environmentId: requireEnvironment(),
        threadId: ThreadId.make(id),
      }),
      (workspaceMutationId) => update({ workspaceMutationId }),
    );
    stopThread = () => {
      stopState();
      stopMutation();
    };
  };
  const selectEnvironment = async (id: string) => {
    const targetId = EnvironmentId.make(id);
    const target = await run(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((connections) =>
          Effect.gen(function* () {
            let entry = (yield* SubscriptionRef.get(connections.entries)).get(targetId);
            if (!entry) {
              const discovery = yield* Discovery.RelayEnvironmentDiscovery;
              const environment = (yield* SubscriptionRef.get(discovery.state)).environments.get(
                targetId,
              )?.environment;
              if (!environment) throw new Error(`Unknown environment: ${id}`);
              yield* connections.register(
                new RelayConnectionRegistration({
                  target: new RelayConnectionTarget({
                    environmentId: targetId,
                    label: environment.label,
                  }),
                }),
              );
              entry = (yield* SubscriptionRef.get(connections.entries)).get(targetId);
            }
            if (!entry) throw new Error(`Could not register environment: ${id}`);
            yield* connections.setEnabled(targetId, true);
            return entry.target;
          }),
        ),
      ),
    );
    clearViewedThread();
    for (const stop of stops) stop();
    stops.clear();
    stopThread = undefined;
    environmentId = targetId;
    preferredModel = null;
    update({
      environmentId,
      label: target.label,
      connection: "connecting",
      error: null,
      shell: null,
      config: null,
      selectedThreadId: null,
      thread: null,
      hasMoreHistory: false,
      workspaceMutationId: null,
    });
    observeEnvironment();
  };
  const client = {
    localStateDirectory: configDir,
    setViewedThread,
    acknowledgeThread: async (id: string) => {
      if (closed || snapshot.selectedThreadId !== id) return;
      const destination = requireEnvironment();
      const threadId = ThreadId.make(id);
      const shell = registry.get(shellSnapshot(destination));
      const source =
        shell?.threads.find((thread) => thread.id === threadId) ??
        shell?.archivedThreads.find((thread) => thread.id === threadId);
      if (!source) return;
      const viewed = registry.get(viewedThreadAtom);
      const wokeAt =
        viewed?.environmentId === destination && viewed.threadId === threadId
          ? viewed.wokeAt
          : null;
      const updatedAt = DateTime.formatIso(source.updatedAt);
      const visitedAt = wokeAt && Date.parse(wokeAt) > Date.parse(updatedAt) ? wokeAt : updatedAt;
      if (source.lastVisitedAt === undefined) {
        markLocalVisit({ environmentId: destination, threadId }, visitedAt);
        return;
      }
      const result = await threadCommands.visit.run(registry, {
        environmentId: destination,
        input: { threadId, visitedAt, opened: false },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    observeScope: (scope: AuthEnvironmentScope, onChange: (allowed: boolean) => void) => {
      const destination = environmentId;
      return observeAvailability(
        Atom.make((get) => {
          if (destination === null) return false;
          const result = get(sessions.sessionStateAtom(destination));
          const session = get(sessions.sessionStateValueAtom(destination));
          return (
            result._tag !== "Failure" && session !== null && sessionGrantsScope(session, scope)
          );
        }),
        onChange,
      );
    },
    observePermission: (method: string, input: unknown, onChange: (allowed: boolean) => void) => {
      const destination = requireEnvironment();
      if (!services.some((service) => service.method === method))
        throw new Error(`Unknown service: ${method}`);
      return observeAvailability(
        createCommandPermissions(runtime, method).permissionAtom(destination, input),
        onChange,
      );
    },
    services,
    setPasswordPrompt: passwords.setHandler,
    cloudIdentity: () => run(cloud.identity()),
    updateServer: async (input: ServerSelfUpdateInput) => {
      const result = await server.updateServer.run(registry, {
        environmentId: requireEnvironment(),
        input,
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    login: async (showPrompt: (prompt: CloudAuthorizationPrompt) => void) => {
      await run(cloud.login((prompt) => Effect.sync(() => showPrompt(prompt))));
      await run(
        Effect.gen(function* () {
          const discovery = yield* Discovery.RelayEnvironmentDiscovery;
          yield* discovery.refresh;
          const state = yield* SubscriptionRef.get(discovery.state);
          if (Option.isSome(state.error)) return yield* state.error.value;
          const connections = yield* EnvironmentRegistry.EnvironmentRegistry;
          const entries = yield* SubscriptionRef.get(connections.entries);
          yield* Effect.forEach(entries.keys(), (id) => connections.retryNow(id), {
            discard: true,
          });
        }),
      );
    },
    logout: async () => {
      await run(cloud.logout());
      await run(
        EnvironmentRegistry.EnvironmentRegistry.pipe(
          Effect.flatMap((connections) => connections.removeRelayEnvironments()),
        ),
      );
      const selectedEnvironmentId = environmentId;
      if (selectedEnvironmentId !== null) {
        const exists = await run(
          EnvironmentRegistry.EnvironmentRegistry.pipe(
            Effect.flatMap((connections) =>
              Effect.map(SubscriptionRef.get(connections.entries), (entries) =>
                entries.has(selectedEnvironmentId),
              ),
            ),
          ),
        );
        if (!exists) {
          clearViewedThread();
          for (const stop of stops) stop();
          stops.clear();
          stopThread = undefined;
          environmentId = null;
          preferredModel = null;
          update({
            environmentId: null,
            connection: "disconnected",
            config: null,
            shell: null,
            thread: null,
            selectedThreadId: null,
            hasMoreHistory: false,
            workspaceMutationId: null,
          });
        }
      }
    },
    addSsh: async (target: DesktopSshEnvironmentTarget, name?: string) => {
      const id = await run(
        ConnectionOnboarding.ConnectionOnboarding.pipe(
          Effect.flatMap((onboarding) =>
            onboarding.registerSsh({ target, ...(name ? { label: name } : {}) }),
          ),
        ),
      );
      await selectEnvironment(id);
    },
    environments: () =>
      run(
        Effect.gen(function* () {
          const connections = yield* EnvironmentRegistry.EnvironmentRegistry;
          const saved = yield* SubscriptionRef.get(connections.entries);
          const discovery = yield* Discovery.RelayEnvironmentDiscovery;
          const discovered = yield* SubscriptionRef.get(discovery.state);
          return [
            ...[...saved.values()].map((entry) => ({
              environmentId: entry.target.environmentId,
              label: entry.target.label,
              enabled: entry.enabled,
            })),
            ...[...discovered.environments.values()]
              .filter((entry) => !saved.has(entry.environment.environmentId))
              .map((entry) => ({
                environmentId: entry.environment.environmentId,
                label: entry.environment.label,
                enabled: false,
              })),
          ];
        }),
      ),
    selectEnvironment,
    connect: async (pairingUrl: string) => {
      const id = await run(
        ConnectionOnboarding.ConnectionOnboarding.pipe(
          Effect.flatMap((onboarding) => onboarding.registerPairing({ pairingUrl })),
        ),
      );
      await selectEnvironment(id);
    },
    reconnect: () =>
      run(
        EnvironmentRegistry.EnvironmentRegistry.pipe(
          Effect.flatMap((connections) => connections.retryNow(requireEnvironment())),
        ),
      ),
    releaseLocalAttachments: localUploads.release,
    preferences: preferences.get,
    subscribePreferences: preferences.subscribe,
    updatePreferences: preferences.update,
    stopSession: accessCommand(threadCommands.stopSession),
    access: {
      createPairingCredential: accessCommand(auth.createPairingCredential),
      revokePairingLink: accessCommand(auth.revokePairingLink),
      revokeClient: accessCommand(auth.revokeClient),
      revokeOtherClients: () => accessCommand(auth.revokeOtherClients)(null),
      approveConnectDevice: accessCommand(auth.approveConnectDevice),
      revokeConnectDevice: accessCommand(auth.revokeConnectDevice),
    },
    readAsset: (resource: AssetResource) => {
      const destination = requireEnvironment();
      return run(
        Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (connections) =>
          connections.run(destination, readAsset(resource)),
        ),
      );
    },
    pullRequestDiff: (input: PullRequestDiffInput) => {
      const destination = requireEnvironment();
      return run(
        Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (connections) =>
          connections.run(
            destination,
            executeConnectedEnvironmentHttpRequest({
              group: "pullRequests",
              method: "POST",
              url: (urls) => urls.diff(),
              timeoutMs: 30_000,
              requestInit: { redirect: "error" },
              request: ({ client, headers }) => client.diff({ headers, payload: input }),
            }),
          ),
        ),
      );
    },
    snapshot: () => snapshot,
    subscribe: (listener: (value: TuiSnapshot) => void) => {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    selectThread,
    captureTransport: () => {
      const destination = requireEnvironment();
      return createRpcBridge(
        runtime,
        registry,
        () => destination,
        (atom, listener) => observe(atom, listener, transportStops),
      );
    },
    captureTransportFor: async (id: string) => {
      const destination = EnvironmentId.make(id);
      await run(
        EnvironmentRegistry.EnvironmentRegistry.pipe(
          Effect.flatMap((environments) => SubscriptionRef.get(environments.entries)),
          Effect.flatMap((entries) =>
            entries.has(destination)
              ? Effect.void
              : Effect.fail(
                  new ConnectionBlockedError({
                    reason: "configuration",
                    detail: "Pair this environment before using it for authentication.",
                  }),
                ),
          ),
        ),
      );
      return createRpcBridge(
        runtime,
        registry,
        () => destination,
        (atom, listener) => observe(atom, listener, transportStops),
      );
    },
    previewStreamAccess: async () => {
      const destination = requireEnvironment();
      return run(
        EnvironmentRegistry.EnvironmentRegistry.pipe(
          Effect.flatMap((environments) =>
            environments.run(
              destination,
              Effect.gen(function* () {
                const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
                const prepared = yield* SubscriptionRef.get(supervisor.prepared);
                if (Option.isNone(prepared))
                  return yield* new ConnectionBlockedError({
                    reason: "configuration",
                    detail: "Connect to the browser's environment first.",
                  });
                return yield* resolveDeviceHubAccess({
                  prepared: prepared.value,
                  hubBasePath: PREVIEW_STREAM_BASE_PATH,
                });
              }),
            ),
          ),
        ),
      );
    },
    invoke,
    stream,
    loadOlderSettled: async () => loadOlderSettled(),
    createProject: async (workspaceRoot: string, title = NodePath.basename(workspaceRoot)) => {
      const destination = requireEnvironment();
      const invokeAtDestination = createRpcBridge(
        runtime,
        registry,
        () => destination,
        observe,
      ).invoke;
      const projectId = ProjectId.make(await uuid());
      await invokeAtDestination(WS_METHODS.projectsMutate, {
        type: "project.create",
        commandId: await uuid(),
        projectId,
        title,
        workspaceRoot,
      });
      return projectId;
    },
    createThread: async (
      projectId: string,
      title = "New thread",
      message?: string,
      options?: ThreadLaunchOptions,
    ) => {
      const destination = requireEnvironment();
      const id = ProjectId.make(projectId);
      const modelSelection = options?.modelSelection ?? requireNewThreadModel(id);
      const locals = [...(options?.localAttachments ?? [])];
      const attachments = [...(options?.attachments ?? [])];
      const context = options?.context;
      const targetThreadId = options?.threadId;
      const launchCommandId = options?.commandId;
      const messageId = options?.messageId;
      const requestedWorkspace = options?.workspaceStrategy;
      const requestedRuntime = options?.runtimeMode;
      const config = snapshot.config;
      const project = snapshot.shell?.projects.find((value) => value.id === id);
      const projectHasThreads =
        snapshot.shell?.threads.some((value) => value.projectId === id) ?? false;
      const invokeAtDestination = createRpcBridge(
        runtime,
        registry,
        () => destination,
        observe,
      ).invoke;
      let projectFile: T3ProjectFile | null = null;
      if (
        config &&
        project &&
        resolveProjectSettings(config.settings, id, project).settings.defaultThreadEnvMode === null
      ) {
        const file = (await invokeAtDestination(WS_METHODS.projectsReadFile, {
          cwd: project.workspaceRoot,
          relativePath: "t3.json",
          allowMissing: true,
        })) as ProjectReadFileResult;
        if (file.truncated)
          throw new Error("The project configuration is too large to read safely.");
        if (file.exists !== false) projectFile = parseT3ProjectFile(file.contents);
      }
      const resolved = config
        ? resolveProjectSettings(config.settings, id, project, projectFile)
        : null;
      let workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy = requestedWorkspace ?? {
        type: "root",
      };
      if (resolved && project && requestedWorkspace === undefined) {
        const mode = resolveNewThreadEnvMode({
          projectSettings: resolved,
          workspaceRoot: project.workspaceRoot,
          newProjectsRoot: config?.newProjectsRoot,
          projectHasThreads,
        });
        if (mode === "worktree") {
          const status = (await invokeAtDestination(WS_METHODS.vcsRefreshStatus, {
            cwd: project.workspaceRoot,
          })) as VcsStatusResult;
          if (
            resolveSendEnvMode({ requestedEnvMode: mode, isGitRepo: status.isRepo }) === "worktree"
          )
            workspaceStrategy = { type: "worktree", baseRef: status.refName ?? "HEAD" };
        }
      }
      const uploaded = locals.length ? await run(localUploads.prepare(destination, locals)) : [];
      const result = await invokeAtDestination(ORCHESTRATION_V2_WS_METHODS.launchThread, {
        commandId: launchCommandId ?? (await uuid()),
        ...(targetThreadId ? { threadId: targetThreadId } : {}),
        projectId: id,
        title,
        modelSelection,
        runtimeMode:
          requestedRuntime ?? resolved?.settings.defaultRuntimeMode ?? "approval-required",
        interactionMode: "default",
        workspaceStrategy,
        ...(message !== undefined
          ? {
              initialMessage: {
                messageId: messageId ?? (await uuid()),
                text: message,
                attachments: [...attachments, ...uploaded],
                ...(context ? { context } : {}),
              },
            }
          : {}),
      });
      localUploads.complete(destination, locals);
      const launched = result as { readonly threadId: string };
      return launched.threadId;
    },
    send: async (
      text: string,
      options?: {
        dispatchMode?: StartThreadTurnInput["dispatchMode"];
        context?: StartThreadTurnInput["message"]["context"];
        attachments?: StartThreadTurnInput["message"]["attachments"];
        localAttachments?: ReadonlyArray<LocalAttachment>;
        freshContext?: boolean;
        compactBeforeSend?: boolean;
      },
    ) => {
      const destination = requireEnvironment();
      const threadId = requireThread();
      const thread = snapshot.thread?.thread;
      const modelSelection = requireModel();
      const runtimeMode = thread?.runtimeMode ?? "approval-required";
      const interactionMode = thread?.interactionMode ?? "default";
      const locals = [...(options?.localAttachments ?? [])];
      const attachments = [...(options?.attachments ?? [])];
      const context = options?.context;
      let dispatchMode = options?.dispatchMode;
      const freshContext = options?.freshContext;
      const compactBeforeSend = options?.compactBeforeSend;
      const messageId = MessageId.make(await uuid());
      const uploaded = locals.length ? await run(localUploads.prepare(destination, locals)) : [];
      if (compactBeforeSend && !freshContext) {
        const compacted = await threadCommands.startTurn.run(registry, {
          environmentId: destination,
          input: {
            threadId,
            message: {
              messageId: MessageId.make(await uuid()),
              role: "user",
              text: "/compact",
              attachments: [],
              idleCompaction: "onReturn",
            },
            dispatchMode: "queue",
            modelSelection,
            runtimeMode,
            interactionMode: "default",
          },
        });
        if (compacted._tag === "Failure") throw squashAtomCommandFailure(compacted);
        dispatchMode = "queue";
      }
      const result = await threadCommands.startTurn.run(registry, {
        environmentId: destination,
        input: {
          threadId,
          message: {
            messageId,
            role: "user",
            text,
            attachments: [...attachments, ...uploaded],
            ...(context ? { context } : {}),
          },
          ...(dispatchMode ? { dispatchMode } : {}),
          ...(freshContext ? { freshContext } : {}),
          modelSelection,
          runtimeMode,
          interactionMode,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      localUploads.complete(destination, locals);
    },
    interrupt: async () => {
      const result = await threadCommands.interruptTurn.run(registry, {
        environmentId: requireEnvironment(),
        input: { threadId: requireThread() },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    stopSubagent: async (threadId: string, subagentId: string) => {
      const result = await threadCommands.interruptTurn.run(registry, {
        environmentId: requireEnvironment(),
        input: { threadId: ThreadId.make(threadId), subagentId: NodeId.make(subagentId) },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    setModel: async (modelSelection: ModelSelection) => {
      requireEnvironment();
      if (snapshot.selectedThreadId === null) {
        preferredModel = modelSelection;
        return;
      }
      const result = await threadCommands.setModelSelection.run(registry, {
        environmentId: requireEnvironment(),
        input: { threadId: requireThread(), modelSelection },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    approve: async (requestId: string, decision: ProviderApprovalDecision, feedback?: string) => {
      const result = await threadCommands.respondToApproval.run(registry, {
        environmentId: requireEnvironment(),
        input: {
          threadId: requireThread(),
          requestId: RuntimeRequestId.make(requestId),
          decision,
          ...(feedback ? { feedback } : {}),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    answer: async (
      requestId: string,
      answers: ProviderUserInputAnswers,
      localAttachmentsByQuestionId?: Readonly<Record<string, ReadonlyArray<LocalAttachment>>>,
    ) => {
      const destination = requireEnvironment();
      const threadId = requireThread();
      const capturedAnswers = { ...answers };
      const locals = Object.entries(localAttachmentsByQuestionId ?? {}).map(
        ([question, values]) => [question, [...values]] as const,
      );
      const uploaded = await Promise.all(
        locals.map(
          async ([question, values]) =>
            [question, await run(localUploads.prepare(destination, values))] as const,
        ),
      );
      const attachmentsByQuestionId = decodeQuestionAttachments(Object.fromEntries(uploaded));
      const result = await threadCommands.respondToUserInput.run(registry, {
        environmentId: destination,
        input: {
          threadId,
          requestId: RuntimeRequestId.make(requestId),
          answers: capturedAnswers,
          ...(locals.length ? { attachmentsByQuestionId } : {}),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      for (const [, values] of locals) localUploads.complete(destination, values);
    },
    resolveGuestMessage: async (
      threadId: string,
      guestMessageId: string,
      decision: "send" | "dismiss",
    ) => {
      const result = await threadCommands.resolveGuestMessage.run(registry, {
        environmentId: requireEnvironment(),
        input: {
          threadId: ThreadId.make(threadId),
          guestMessageId: GuestMessageId.make(guestMessageId),
          decision,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    editQueuedMessage: async (
      threadId: string,
      runId: string,
      text: string,
      retained: ReadonlyArray<ChatAttachment>,
      localAttachments: ReadonlyArray<LocalAttachment>,
      context?: OrchestrationMessageContext,
    ) => {
      const destination = requireEnvironment();
      const locals = [...localAttachments];
      const attachments = [...retained];
      const target = ThreadId.make(threadId);
      const runIdAtStart = RunId.make(runId);
      const messageId =
        snapshot.thread?.thread.id === target
          ? snapshot.thread.runs.find((entry) => entry.id === runIdAtStart)?.userMessageId
          : undefined;
      if (!messageId)
        throw new Error("Return to the conversation containing this queued message to edit it.");
      const uploaded = locals.length ? await run(localUploads.prepare(destination, locals)) : [];
      const result = await threadCommands.editQueuedRun.run(registry, {
        environmentId: destination,
        input: {
          threadId: target,
          runId: runIdAtStart,
          text,
          edit: {
            messageId,
            attachments: [...attachments, ...uploaded],
            ...(context ? { context } : {}),
          },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      localUploads.complete(destination, locals);
    },
    loadEarlier: async (throughEntryId?: string) => {
      const result = await threadCommands.loadEarlierHistory.run(registry, {
        environmentId: requireEnvironment(),
        input: { threadId: requireThread(), ...(throughEntryId ? { throughEntryId } : {}) },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    loadWork: async (entry: OrchestrationV2ProjectedTurnItem) => {
      const environmentId = requireEnvironment();
      const threadId = requireThread();
      if (
        !snapshot.thread?.visibleTurnItems.some(
          (value) =>
            value.sourceThreadId === entry.sourceThreadId &&
            value.sourceItemId === entry.sourceItemId,
        )
      )
        throw new Error("Return to the thread containing this work to load it.");
      const result = await threadCommands.loadEarlierHistory.run(registry, {
        environmentId,
        input: { threadId, workAnchorId: entry.sourceItemId },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (result.value._tag === "error") throw new Error(result.value.message);
    },
    close: () => {
      clearViewedThread();
      closed = true;
      passwords.close();
      for (const stop of stops) stop();
      stops.clear();
      for (const stop of transportStops) stop();
      transportStops.clear();
      listeners.clear();
      registry.dispose();
    },
  };
  return client;
}

export type TuiClient = Awaited<ReturnType<typeof createTuiClient>>;
