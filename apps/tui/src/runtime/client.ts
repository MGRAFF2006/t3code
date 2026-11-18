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
} from "@t3tools/client-runtime/state/threads";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import {
  createRuntimeCommand,
  type AtomCommand,
  executeConnectedEnvironmentHttpRequest,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  WS_METHODS,
  type DesktopSshEnvironmentTarget,
  type ModelSelection,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type AssetResource,
  type PullRequestDiffInput,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type ServerConfig,
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
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { CloudAuthorizationPrompt } from "../connections/cloud.ts";
import { createClientLayer } from "./platform.ts";
import { createRpcBridge } from "../rpc/bridge.ts";
import { createAuthEnvironmentAtoms } from "@t3tools/client-runtime/state/auth";
import { createLocalAttachmentUploads, type LocalAttachment } from "./attachments.ts";
import { createPreferences } from "./preferences.ts";
import { readAsset } from "./assets.ts";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { services } from "../rpc/catalog.ts";

export interface TuiConnectionOptions {
  readonly url?: string;
  readonly pairingUrl?: string;
  readonly token?: string;
  readonly configDir?: string;
}

export interface TuiSnapshot {
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
  readonly connection: string;
  readonly error: string | null;
  readonly config: ServerConfig | null;
  readonly shell: OrchestrationV2ShellSnapshot | null;
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
  const shellSnapshot = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => Option.getOrNull(get(shellAtoms.stateValueAtom(environmentId)).snapshot)),
  );
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
    observe(shellAtoms.stateValueAtom(currentEnvironmentId), (state) =>
      update({
        shell: Option.getOrNull(state.snapshot),
        ...(Option.isSome(state.error) ? { error: state.error.value } : {}),
      }),
    );
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
    services,
    setPasswordPrompt: passwords.setHandler,
    cloudIdentity: () => run(cloud.identity()),
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
    invoke,
    stream,
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
    createThread: async (projectId: string, title = "New thread", message?: string) => {
      const destination = requireEnvironment();
      const id = ProjectId.make(projectId);
      const modelSelection = requireNewThreadModel(id);
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
      let workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy = { type: "root" };
      if (resolved && project) {
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
      const result = await invokeAtDestination(ORCHESTRATION_V2_WS_METHODS.launchThread, {
        commandId: await uuid(),
        projectId: id,
        title,
        modelSelection,
        runtimeMode: resolved?.settings.defaultRuntimeMode ?? "approval-required",
        interactionMode: "default",
        workspaceStrategy,
        ...(message
          ? { initialMessage: { messageId: await uuid(), text: message, attachments: [] } }
          : {}),
      });
      const launched = result as { readonly threadId: string };
      if (environmentId === destination) selectThread(launched.threadId);
      return launched.threadId;
    },
    send: async (
      text: string,
      options?: {
        dispatchMode?: StartThreadTurnInput["dispatchMode"];
        context?: StartThreadTurnInput["message"]["context"];
        attachments?: StartThreadTurnInput["message"]["attachments"];
        localAttachments?: ReadonlyArray<LocalAttachment>;
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
      const dispatchMode = options?.dispatchMode;
      const messageId = MessageId.make(await uuid());
      const uploaded = locals.length ? await run(localUploads.prepare(destination, locals)) : [];
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
    answer: async (requestId: string, answers: ProviderUserInputAnswers) => {
      const result = await threadCommands.respondToUserInput.run(registry, {
        environmentId: requireEnvironment(),
        input: { threadId: requireThread(), requestId: RuntimeRequestId.make(requestId), answers },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    loadEarlier: async () => {
      const result = await threadCommands.loadEarlierHistory.run(registry, {
        environmentId: requireEnvironment(),
        input: { threadId: requireThread() },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    close: () => {
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
