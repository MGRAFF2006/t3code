// @effect-diagnostics nodeBuiltinImport:off -- Starts the terminal client against its own empty temporary state directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  EnvironmentRegistry,
  AVAILABLE_CONNECTION_STATE,
} from "@t3tools/client-runtime/connection";
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import type { SshPasswordPrompt } from "@t3tools/ssh/auth";
import * as ClientPlatform from "./platform.ts";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import * as ShellState from "@t3tools/client-runtime/state/shell";
import * as ServerState from "@t3tools/client-runtime/state/server";
import * as SessionState from "@t3tools/client-runtime/state/session";
import * as TerminalState from "@t3tools/client-runtime/state/terminal";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import type {
  AuthSessionState,
  OrchestrationV2ThreadShell,
  ServerConfig,
  EnvironmentId as EnvironmentIdType,
  TerminalSummary,
} from "@t3tools/contracts";
import * as ThreadState from "@t3tools/client-runtime/state/threads";
import type { StartThreadTurnInput, VisitThreadInput } from "@t3tools/client-runtime/operations";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import {
  v2Project,
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as RpcBridge from "../rpc/bridge.ts";
import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { createTuiClient, type TuiSnapshot } from "./client.ts";

describe("terminal client onboarding", () => {
  it.effect(
    "opens a disconnected client on first launch and prevents operations without a destination",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-client-"))),
        (configDir) =>
          Effect.acquireUseRelease(
            Effect.promise(() => createTuiClient({ configDir })),
            (client) =>
              Effect.promise(async () => {
                expect(client.snapshot()).toMatchObject({
                  environmentId: null,
                  connection: "disconnected",
                  shell: null,
                  thread: null,
                });
                expect(await client.environments()).toEqual([]);
                await expect(client.invoke(WS_METHODS.serverProbe, {})).rejects.toThrow(
                  "Connect to an environment first",
                );
                expect(() =>
                  client.stream(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {}, () => undefined),
                ).toThrow("Connect to an environment first");
                expect(() => client.selectThread("missing")).toThrow(
                  "Connect to an environment first",
                );
                expect(client.snapshot().selectedThreadId).toBeNull();
              }),
            (client) => Effect.sync(() => client.close()),
          ),
        (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
      ),
  );

  it.effect(
    "reuses a saved authenticated environment when reconnecting by URL without a token",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-reconnect-"))),
        (configDir) =>
          Effect.gen(function* () {
            using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
              const request = new Request(input, init);
              if (new URL(request.url).pathname === "/.well-known/t3/environment")
                return Response.json({
                  environmentId: "saved-environment",
                  label: "Saved server",
                  platform: { os: "linux", arch: "x64" },
                  serverVersion: "0.0.0-test",
                  orchestrationProtocolVersion: 0,
                  capabilities: {},
                });
              if (new URL(request.url).pathname === "/api/auth/session")
                return Response.json({
                  authenticated: request.headers.get("authorization") === "Bearer test-saved-token",
                  auth: {
                    policy: "remote-reachable",
                    bootstrapMethods: [],
                    sessionMethods: [],
                    sessionCookieName: "test-session",
                  },
                });
              return Response.json(
                {
                  _tag: "EnvironmentAuthInvalidError",
                  code: "auth_invalid",
                  reason: "invalid_credential",
                  traceId: "test-trace",
                },
                { status: 401 },
              );
            });
            const url = "http://saved-server.invalid";
            const first = yield* Effect.promise(() =>
              createTuiClient({ configDir, url, token: "test-saved-token" }),
            );
            yield* Effect.addFinalizer(() => Effect.sync(() => first.close()));
            const filename = NodePath.join(configDir, "connections.json");
            const saved = yield* Effect.promise(() => NodeFSP.readFile(filename, "utf8"));
            const second = yield* Effect.promise(() => createTuiClient({ configDir, url }));
            yield* Effect.addFinalizer(() => Effect.sync(() => second.close()));
            expect(second.snapshot().environmentId).toBe(first.snapshot().environmentId);
            expect(yield* Effect.promise(() => NodeFSP.readFile(filename, "utf8"))).toBe(saved);
            expect(JSON.parse(saved)).toMatchObject({
              credentials: [{ credential: { token: "test-saved-token" } }],
            });
            const invalidImport = yield* Effect.tryPromise({
              try: () => createTuiClient({ configDir, url, token: "invalid-test-token" }),
              catch: () => "unauthenticated-import" as const,
            }).pipe(Effect.result);
            if (invalidImport._tag === "Success") invalidImport.success.close();
            expect(yield* Effect.promise(() => NodeFSP.readFile(filename, "utf8"))).toBe(saved);
            expect(invalidImport._tag).toBe("Failure");
            const moved = yield* Effect.promise(() =>
              createTuiClient({ configDir, url: "http://moved-server.invalid" }),
            );
            yield* Effect.addFinalizer(() => Effect.sync(() => moved.close()));
            const updated = JSON.parse(
              yield* Effect.promise(() => NodeFSP.readFile(filename, "utf8")),
            );
            expect(updated.targets).toEqual(JSON.parse(saved).targets);
            expect(updated.credentials).toEqual(JSON.parse(saved).credentials);
            expect(updated.profiles).toMatchObject([
              { httpBaseUrl: "http://moved-server.invalid/" },
            ]);
          }),
        (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
      ),
  );

  it.effect.each([
    "new-thread",
    "preferred-new-thread",
    "configured-defaults",
    "send-switch",
    "compact-send-switch",
  ] as const)("keeps model selection with the intended destination for %s", (scenario) =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-model-"))),
      (configDir) =>
        Effect.gen(function* () {
          const provider = ProviderInstanceId.make("codex");
          const modelA = { instanceId: provider, model: "model-a" };
          const modelB = { instanceId: provider, model: "model-b" };
          const projectA = {
            ...v2Project,
            id: ProjectId.make("project-a"),
            defaultModelSelection: modelA,
          };
          const projectB = {
            ...v2Project,
            id: ProjectId.make("project-b"),
            defaultModelSelection: scenario === "configured-defaults" ? null : modelB,
          };
          const threadA = {
            ...v2Projection,
            thread: {
              ...v2Projection.thread,
              id: ThreadId.make("thread-a"),
              projectId: projectA.id,
              modelSelection: modelA,
              runtimeMode: "approval-required" as const,
            },
          };
          const threadB = {
            ...v2Projection,
            thread: {
              ...v2Projection.thread,
              id: ThreadId.make("thread-b"),
              projectId: projectB.id,
              modelSelection: modelB,
              runtimeMode: "full-access" as const,
              interactionMode: "plan" as const,
            },
          };
          const serverFactory = ServerState.createServerEnvironmentAtoms;
          using _server = vi
            .spyOn(ServerState, "createServerEnvironmentAtoms")
            .mockImplementation((...args) => ({
              ...serverFactory(...args),
              configValueAtom: () =>
                Atom.make(
                  scenario === "configured-defaults"
                    ? ({
                        providers: [],
                        environment: { label: "Configured server" },
                        settings: {
                          ...DEFAULT_SERVER_SETTINGS,
                          defaultModelSelection: modelB,
                          defaultRuntimeMode: "auto-accept-edits",
                          defaultThreadEnvMode: "local",
                        },
                      } as unknown as ServerConfig)
                    : null,
                ),
            }));
          const shellFactory = ShellState.createEnvironmentShellAtoms;
          const shellState = {
            ...ShellState.EMPTY_SHELL_STATE,
            snapshot: Option.some({ ...v2ShellSnapshot, projects: [projectA, projectB] }),
            status: "live" as const,
          };
          using _shell = vi
            .spyOn(ShellState, "createEnvironmentShellAtoms")
            .mockImplementation((runtime) => ({
              ...shellFactory(runtime),
              stateValueAtom: () => Atom.make(shellState),
              stateAtom: () => Atom.make(AsyncResult.success(shellState)),
            }));
          using _threads = vi
            .spyOn(ThreadState, "createEnvironmentThreadStateAtoms")
            .mockImplementation(() => ({
              stateAtom: (_environmentId, id) =>
                Atom.make(
                  AsyncResult.success({
                    ...ThreadState.EMPTY_ENVIRONMENT_THREAD_STATE,
                    data: Option.some(id === threadA.thread.id ? threadA : threadB),
                    status: "live" as const,
                  }),
                ),
            }));
          let launched: unknown;
          const bridgeFactory = RpcBridge.createRpcBridge;
          using _transport = vi
            .spyOn(RpcBridge, "createRpcBridge")
            .mockImplementation((...args) => {
              const bridge = bridgeFactory(...args);
              return {
                ...bridge,
                invoke: async (method, payload) => {
                  if (method !== ORCHESTRATION_V2_WS_METHODS.launchThread)
                    return bridge.invoke(method, payload);
                  launched = payload;
                  return { threadId: threadB.thread.id, projection: threadB, resumed: false };
                },
              };
            });
          let dispatched: StartThreadTurnInput | undefined;
          const dispatches: StartThreadTurnInput[] = [];
          const commandsFactory = ThreadState.createThreadEnvironmentAtoms;
          using _commands = vi
            .spyOn(ThreadState, "createThreadEnvironmentAtoms")
            .mockImplementation((...args) => {
              const original = commandsFactory(...args);
              return {
                ...original,
                startTurn: {
                  ...original.startTurn,
                  run: async (_registry, target) => {
                    dispatched = target.input;
                    dispatches.push(target.input);
                    return AsyncResult.success({ sequence: 1 });
                  },
                },
              };
            });
          using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
            Response.json({
              environmentId: "model-environment",
              label: "Model server",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.0.0-test",
              orchestrationProtocolVersion: 0,
              capabilities: {},
            }),
          );
          const client = yield* Effect.promise(() =>
            createTuiClient({ configDir, url: "http://model-server.invalid" }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));
          client.selectThread(threadA.thread.id);
          if (!scenario.endsWith("send-switch")) {
            const explicitModel = { ...modelA, model: "explicit-model" };
            if (scenario === "preferred-new-thread") {
              client.selectThread(null);
              yield* Effect.promise(() => client.setModel(explicitModel));
              client.selectThread(threadA.thread.id);
            }
            yield* Effect.promise(() => client.createThread(projectB.id));
            expect(client.snapshot().selectedThreadId).toBe(threadA.thread.id);
            expect(launched).toMatchObject({
              projectId: projectB.id,
              modelSelection: scenario === "preferred-new-thread" ? explicitModel : modelB,
              ...(scenario === "configured-defaults"
                ? { runtimeMode: "auto-accept-edits", workspaceStrategy: { type: "root" } }
                : {}),
            });
          } else {
            const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
            using _random = vi
              .spyOn(globalThis.crypto, "getRandomValues")
              .mockImplementation((array) => {
                client.selectThread(threadB.thread.id);
                return getRandomValues(array);
              });
            yield* Effect.promise(() =>
              client.send("Message for A", {
                dispatchMode: "queue",
                context: { version: 1, records: [] },
                freshContext: scenario === "send-switch",
                compactBeforeSend: true,
              }),
            );
            expect(dispatched).toMatchObject({
              threadId: threadA.thread.id,
              dispatchMode: "queue",
              ...(scenario === "send-switch" ? { freshContext: true } : {}),
              message: { text: "Message for A", context: { version: 1, records: [] } },
              modelSelection: modelA,
              runtimeMode: "approval-required",
              interactionMode: "default",
            });
            expect(dispatches).toHaveLength(scenario === "send-switch" ? 1 : 2);
            if (scenario === "compact-send-switch")
              expect(dispatches[0]).toMatchObject({
                threadId: threadA.thread.id,
                message: { text: "/compact", idleCompaction: "onReturn", attachments: [] },
                modelSelection: modelA,
              });
          }
        }),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
    ),
  );

  it.effect("waits for the UI password handler and cancels an outstanding prompt on close", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-password-"))),
      (configDir) =>
        Effect.gen(function* () {
          let prompt: SshPasswordPrompt["Service"] | undefined;
          const createLayer = ClientPlatform.createClientLayer;
          using _layer = vi
            .spyOn(ClientPlatform, "createClientLayer")
            .mockImplementation((directory, passwordPrompt) => {
              prompt = passwordPrompt;
              return createLayer(directory, passwordPrompt);
            });
          const client = yield* Effect.promise(() => createTuiClient({ configDir }));
          yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));
          if (!prompt) throw new Error("The client did not install its SSH prompt service.");
          const request = {
            destination: "test-host",
            username: "developer",
            prompt: "Password",
            attempt: 1,
          };
          const waiting = yield* prompt
            .request(request)
            .pipe(Effect.forkChild({ startImmediately: true }));
          client.setPasswordPrompt(async () => "test-password");
          expect(yield* Fiber.join(waiting)).toBe("test-password");
          client.setPasswordPrompt(() => new Promise(() => undefined));
          const active = yield* prompt
            .request(request)
            .pipe(Effect.forkChild({ startImmediately: true }));
          client.close();
          expect(yield* Fiber.join(active)).toBeNull();
        }),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
    ),
  );
});

it.effect("keeps project creation on its original environment while UUID allocation waits", () =>
  Effect.acquireUseRelease(
    Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-project-destination-")),
    ),
    (configDir) =>
      Effect.gen(function* () {
        using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
          const request = new Request(input);
          if (new URL(request.url).pathname === "/api/auth/session")
            return Response.json({
              authenticated: true,
              auth: {
                policy: "remote-reachable",
                bootstrapMethods: [],
                sessionMethods: [],
                sessionCookieName: "test-session",
              },
            });
          return Response.json({
            environmentId: request.url.includes("other-server")
              ? "other-environment"
              : "original-environment",
            label: "Test server",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            orchestrationProtocolVersion: 0,
            capabilities: {},
          });
        });
        const other = yield* Effect.promise(() =>
          createTuiClient({
            configDir,
            url: "http://other-server.invalid",
            token: "test-other-token",
          }),
        );
        other.close();
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let pauseUuid = false;
        const secure = SecureRandom.make((size) =>
          globalThis.crypto.getRandomValues(new Uint8Array(size)),
        );
        const delayed = ((options?: { format?: "string" | "bytes" }) =>
          Effect.gen(function* () {
            if (pauseUuid) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
            }
            return yield* options?.format === "bytes"
              ? secure.uuidV4({ format: "bytes" })
              : secure.uuidV4();
          })) as typeof secure.uuidV4;
        const platformFactory = ClientPlatform.createClientLayer;
        using _platform = vi
          .spyOn(ClientPlatform, "createClientLayer")
          .mockImplementation(async (...args) => {
            const original = await platformFactory(...args);
            return {
              ...original,
              layer: Layer.merge(
                original.layer,
                Layer.succeed(SecureRandom.SecureRandom, { ...secure, uuidV4: delayed }),
              ),
            };
          });
        let createdIn: string | undefined;
        const heartbeat = Atom.make(0);
        let changeHeartbeat = (_value: number): void => {
          throw new Error("No captured transport.");
        };
        const bridgeFactory = RpcBridge.createRpcBridge;
        using _transport = vi.spyOn(RpcBridge, "createRpcBridge").mockImplementation((...args) => {
          const original = bridgeFactory(...args);
          return {
            ...original,
            invoke: async (method, payload) => {
              if (method !== WS_METHODS.projectsMutate) return original.invoke(method, payload);
              createdIn = args[2]();
              return {};
            },
            stream: (_method, _input, onValue) => {
              changeHeartbeat = (value) => args[1].set(heartbeat, value);
              return args[3](heartbeat, onValue);
            },
          };
        });
        const client = yield* Effect.promise(() =>
          createTuiClient({ configDir, url: "http://original-server.invalid" }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));
        const received: number[] = [];
        const detach = client
          .captureTransport()
          .stream(WS_METHODS.terminalAttach, {}, (value) => received.push(Number(value)));
        pauseUuid = true;
        const creating = yield* Effect.forkChild(
          Effect.promise(() => client.createProject("/workspace/original", "Original")),
        );
        yield* Deferred.await(entered);
        yield* Effect.promise(() => client.selectEnvironment("other-environment"));
        pauseUuid = false;
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(creating);
        expect(createdIn).toBe("original-environment");
        expect(client.snapshot().environmentId).toBe("other-environment");
        changeHeartbeat(1);
        expect(received).toEqual([0, 1]);
        detach();
        changeHeartbeat(2);
        expect(received).toEqual([0, 1]);
      }),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
  ),
);

it.effect(
  "tracks only the viewed destination and revokes captured permission observers on environment changes",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-views-"))),
      (configDir) =>
        Effect.gen(function* () {
          const firstEnvironment = EnvironmentId.make("viewed-environment");
          const secondEnvironment = EnvironmentId.make("other-viewed-environment");
          const threadId = ThreadId.make("viewed-thread");
          const legacyThreadId = ThreadId.make("legacy-viewed-thread");
          const at = (minute: number) => DateTime.makeUnsafe(`2026-06-20T00:0${minute}:00Z`);
          const row: OrchestrationV2ThreadShell = {
            ...v2ThreadShell,
            id: threadId,
            latestRunId: RunId.make("viewed-run"),
            status: "running" as const,
            lastVisitedAt: at(0),
            updatedAt: at(1),
          };
          const initialState = {
            ...ShellState.EMPTY_SHELL_STATE,
            snapshot: Option.some({ ...v2ShellSnapshot, threads: [row] }),
            status: "live" as const,
          };
          const shellValues = Atom.family((_id: EnvironmentIdType) => Atom.make(initialState));
          let registry: import("effect/reactivity/AtomRegistry").AtomRegistry | undefined;
          const shellStates = Atom.family((id: EnvironmentIdType) =>
            Atom.make((get) => {
              registry = get.registry;
              return get(shellValues(id));
            }),
          );
          const shellFactory = ShellState.createEnvironmentShellAtoms;
          using _shell = vi
            .spyOn(ShellState, "createEnvironmentShellAtoms")
            .mockImplementation((runtime) => ({
              ...shellFactory(runtime),
              stateValueAtom: shellStates,
              stateAtom: (id) => Atom.make((get) => AsyncResult.success(get(shellStates(id)))),
            }));
          using _threads = vi
            .spyOn(ThreadState, "createEnvironmentThreadStateAtoms")
            .mockImplementation(() => ({
              stateAtom: (_id, selected) =>
                Atom.make(
                  AsyncResult.success({
                    ...ThreadState.EMPTY_ENVIRONMENT_THREAD_STATE,
                    data: Option.some({
                      ...v2Projection,
                      thread: { ...v2Projection.thread, id: selected },
                    }),
                    status: "live" as const,
                  }),
                ),
            }));
          const grant = (scopes: NonNullable<AuthSessionState["scopes"]>): AuthSessionState => ({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "view-test",
            },
            scopes,
            permissions: scopes,
          });
          const sessionValues = Atom.family((_id: EnvironmentIdType) =>
            Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(
              AsyncResult.success(grant([AuthOrchestrationReadScope])),
            ),
          );
          const sessionFactory = SessionState.createEnvironmentSessionAtoms;
          using _sessions = vi
            .spyOn(SessionState, "createEnvironmentSessionAtoms")
            .mockImplementation((...args) => ({
              ...sessionFactory(...args),
              sessionStateAtom: sessionValues,
              sessionStateValueAtom: (id) =>
                Atom.make((get) => AsyncResult.getOrElse(get(sessionValues(id)), () => null)),
            }));
          const visits: Array<{ environmentId: EnvironmentIdType; input: VisitThreadInput }> = [];
          const commandsFactory = ThreadState.createThreadEnvironmentAtoms;
          using _commands = vi
            .spyOn(ThreadState, "createThreadEnvironmentAtoms")
            .mockImplementation((...args) => {
              const original = commandsFactory(...args);
              return {
                ...original,
                visit: {
                  ...original.visit,
                  run: async (_registry, target) => {
                    visits.push(target);
                    return AsyncResult.success({ sequence: visits.length });
                  },
                },
              };
            });
          using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const url = new URL(
              typeof input === "string" || input instanceof URL ? input : input.url,
            );
            if (url.pathname === "/api/auth/session")
              return Response.json(grant([AuthOrchestrationReadScope]));
            return Response.json({
              environmentId: url.hostname.startsWith("other")
                ? secondEnvironment
                : firstEnvironment,
              label: "Visit fixture",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.0.0-test",
              orchestrationProtocolVersion: 0,
              capabilities: {},
            });
          });
          const other = yield* Effect.promise(() =>
            createTuiClient({
              configDir,
              url: "http://other-view.invalid",
              token: "test-other-view",
            }),
          );
          other.close();
          const client = yield* Effect.promise(() =>
            createTuiClient({
              configDir,
              url: "http://first-view.invalid",
              token: "test-first-view",
            }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));
          if (!registry) throw new Error("View fixture did not mount its shell");
          const updateShell = (
            id: EnvironmentIdType,
            patch: Partial<OrchestrationV2ThreadShell>,
          ) => {
            const state = registry!.get(shellValues(id));
            registry!.set(shellValues(id), {
              ...state,
              snapshot: Option.some({ ...v2ShellSnapshot, threads: [{ ...row, ...patch }] }),
            });
          };
          client.selectThread(threadId);
          expect(visits).toEqual([]);
          client.setViewedThread(threadId);
          client.setViewedThread(threadId);
          expect(visits).toEqual([
            {
              environmentId: firstEnvironment,
              input: { threadId, visitedAt: DateTime.formatIso(at(1)), opened: true },
            },
          ]);
          updateShell(firstEnvironment, {
            status: "completed",
            updatedAt: at(2),
            latestRunCompletedAt: at(2),
          });
          expect(visits.at(-1)).toEqual({
            environmentId: firstEnvironment,
            input: { threadId, visitedAt: DateTime.formatIso(at(2)) },
          });
          client.setViewedThread(threadId, DateTime.formatIso(at(3)));
          expect(visits.at(-1)?.input).toEqual({ threadId, visitedAt: DateTime.formatIso(at(3)) });
          yield* Effect.promise(() => client.acknowledgeThread(threadId));
          expect(visits.at(-1)).toEqual({
            environmentId: firstEnvironment,
            input: { threadId, visitedAt: DateTime.formatIso(at(3)), opened: false },
          });
          const beforeHidden = visits.length;
          client.setViewedThread(null);
          updateShell(firstEnvironment, {
            status: "completed",
            updatedAt: at(4),
            latestRunCompletedAt: at(4),
          });
          expect(visits).toHaveLength(beforeHidden);
          client.setViewedThread(threadId);
          expect(visits.filter((visit) => visit.input.opened)).toHaveLength(1);
          const readPermissions: boolean[] = [];
          const operatePermissions: boolean[] = [];
          const operateScopes: boolean[] = [];
          const manageScopes: boolean[] = [];
          const stopOperate = client.observeScope(AuthOrchestrationOperateScope, (allowed) =>
            operateScopes.push(allowed),
          );
          client.observeScope(AuthProvidersManageScope, (allowed) => manageScopes.push(allowed));
          const stopRead = client.observePermission(
            WS_METHODS.serverRefreshProviders,
            undefined,
            (allowed) => readPermissions.push(allowed),
          );
          client.observePermission(
            WS_METHODS.gitPreparePullRequestThread,
            { cwd: "/repo", reference: "123", mode: "worktree", threadId },
            (allowed) => operatePermissions.push(allowed),
          );
          expect(readPermissions.at(-1)).toBe(true);
          expect(operatePermissions.at(-1)).toBe(false);
          expect(operateScopes.at(-1)).toBe(false);
          expect(manageScopes.at(-1)).toBe(false);
          registry.set(
            sessionValues(firstEnvironment),
            AsyncResult.success(grant([AuthOrchestrationReadScope, AuthProvidersManageScope])),
          );
          expect(manageScopes.at(-1)).toBe(true);
          expect(operateScopes.at(-1)).toBe(false);
          registry.set(
            sessionValues(firstEnvironment),
            AsyncResult.success(
              grant([
                AuthOrchestrationReadScope,
                AuthSourceControlWriteScope,
                AuthOrchestrationOperateScope,
              ]),
            ),
          );
          expect(operatePermissions.at(-1)).toBe(true);
          expect(operateScopes.at(-1)).toBe(true);
          expect(manageScopes.at(-1)).toBe(false);
          registry.set(sessionValues(firstEnvironment), AsyncResult.initial());
          expect(operateScopes.at(-1)).toBe(false);
          registry.set(
            sessionValues(firstEnvironment),
            AsyncResult.success(grant([AuthOrchestrationOperateScope])),
          );
          expect(operateScopes.at(-1)).toBe(true);
          registry.set(
            sessionValues(firstEnvironment),
            AsyncResult.failure(Cause.fail("Session lookup failed")),
          );
          expect(operateScopes.at(-1)).toBe(false);
          registry.set(
            sessionValues(firstEnvironment),
            AsyncResult.success(grant([AuthOrchestrationOperateScope])),
          );
          yield* Effect.promise(() => client.selectEnvironment(secondEnvironment));
          expect(readPermissions.at(-1)).toBe(false);
          expect(operatePermissions.at(-1)).toBe(false);
          expect(operateScopes.at(-1)).toBe(false);
          const stoppedPermissions = operatePermissions.length;
          const stoppedScopes = operateScopes.length;
          registry.set(sessionValues(firstEnvironment), AsyncResult.success(grant([])));
          expect(operatePermissions).toHaveLength(stoppedPermissions);
          expect(operateScopes).toHaveLength(stoppedScopes);
          stopRead();
          stopOperate();
          const beforeOtherView = visits.length;
          client.setViewedThread(threadId);
          updateShell(firstEnvironment, { updatedAt: at(5), latestRunCompletedAt: at(5) });
          expect(visits).toHaveLength(beforeOtherView);
          client.selectThread(threadId);
          client.setViewedThread(threadId);
          expect(visits.at(-1)).toEqual({
            environmentId: secondEnvironment,
            input: { threadId, visitedAt: DateTime.formatIso(at(1)), opened: true },
          });
          const beforeLegacy = visits.length;
          updateShell(secondEnvironment, { id: legacyThreadId, lastVisitedAt: undefined });
          client.selectThread(legacyThreadId);
          client.setViewedThread(legacyThreadId);
          expect(visits).toHaveLength(beforeLegacy);
          expect(client.snapshot().shell?.threads[0]?.lastVisitedAt).toEqual(at(1));
          yield* Effect.promise(() => client.acknowledgeThread(legacyThreadId));
          expect(visits).toHaveLength(beforeLegacy);
          expect(client.snapshot().shell?.threads[0]?.lastVisitedAt).toEqual(at(1));
          const searchRow = { ...row, id: ThreadId.make("older-search-row") };
          const read = { matches: [], threads: [searchRow], snapshotSequence: 10 };
          const releaseSearch = client.mountSearchRows(secondEnvironment, read);
          expect(
            client.snapshot().shell?.threads.some((thread) => thread.id === searchRow.id),
          ).toBe(true);
          const authoritative = registry.get(shellValues(secondEnvironment));
          registry.set(shellValues(secondEnvironment), {
            ...authoritative,
            removedAt: new Map([...authoritative.removedAt, [searchRow.id, 11]]),
          });
          expect(
            client.snapshot().shell?.threads.some((thread) => thread.id === searchRow.id),
          ).toBe(false);
          releaseSearch();
          const releaseStale = client.mountSearchRows(secondEnvironment, read);
          expect(
            client.snapshot().shell?.threads.some((thread) => thread.id === searchRow.id),
          ).toBe(false);
          releaseStale();
          const releaseForeign = client.mountSearchRows(firstEnvironment, {
            ...read,
            threads: [{ ...searchRow, id: ThreadId.make("foreign-search-row") }],
          });
          expect(
            client.snapshot().shell?.threads.some((thread) => thread.id === "foreign-search-row"),
          ).toBe(false);
          releaseForeign();
          client.close();
          expect(() => client.setViewedThread(legacyThreadId)).not.toThrow();
        }),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
    ),
);

it.effect(
  "keeps terminal activity scoped to readable connected environments and clears stale metadata",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-terminals-"))),
      (configDir) =>
        Effect.gen(function* () {
          const firstId = EnvironmentId.make("terminal-first");
          const secondId = EnvironmentId.make("terminal-second");
          const firstConnection = yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          });
          const secondConnection = yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          });
          const platformFactory = ClientPlatform.createClientLayer;
          using _platform = vi
            .spyOn(ClientPlatform, "createClientLayer")
            .mockImplementation(async (...args) => {
              const original = await platformFactory(...args);
              const registry = Layer.effect(
                EnvironmentRegistry.EnvironmentRegistry,
                Effect.gen(function* () {
                  const service = yield* EnvironmentRegistry.EnvironmentRegistry;
                  return {
                    ...service,
                    stateChanges: (id: EnvironmentIdType) =>
                      id === firstId
                        ? SubscriptionRef.changes(firstConnection)
                        : id === secondId
                          ? SubscriptionRef.changes(secondConnection)
                          : service.stateChanges(id),
                  };
                }),
              ).pipe(Layer.provide(original.layer));
              return { ...original, layer: Layer.merge(original.layer, registry) };
            });
          let atomRegistry: import("effect/reactivity/AtomRegistry").AtomRegistry | undefined;
          const shellFactory = ShellState.createEnvironmentShellAtoms;
          const shell = Atom.make((get) => {
            atomRegistry = get.registry;
            return {
              ...ShellState.EMPTY_SHELL_STATE,
              snapshot: Option.some(v2ShellSnapshot),
              status: "live" as const,
            };
          });
          using _shell = vi
            .spyOn(ShellState, "createEnvironmentShellAtoms")
            .mockImplementation((runtime) => ({
              ...shellFactory(runtime),
              stateValueAtom: () => shell,
              stateAtom: () => Atom.make((get) => AsyncResult.success(get(shell))),
            }));
          const grant = (allowed: boolean): AuthSessionState => ({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "terminal-test",
            },
            scopes: allowed ? [AuthTerminalReadScope] : [],
            permissions: allowed ? [AuthTerminalReadScope] : [],
          });
          const sessionValues = Atom.family((_id: EnvironmentIdType) =>
            Atom.make(AsyncResult.success(grant(false))),
          );
          const sessionFactory = SessionState.createEnvironmentSessionAtoms;
          using _sessions = vi
            .spyOn(SessionState, "createEnvironmentSessionAtoms")
            .mockImplementation((...args) => ({
              ...sessionFactory(...args),
              sessionStateAtom: sessionValues,
              sessionStateValueAtom: (id) =>
                Atom.make((get) => AsyncResult.getOrElse(get(sessionValues(id)), () => null)),
            }));
          const metadataValues = Atom.family((_id: EnvironmentIdType) =>
            Atom.make<AsyncResult.AsyncResult<readonly TerminalSummary[], string>>(
              AsyncResult.initial(),
            ),
          );
          const metadataAtoms = Atom.family((id: EnvironmentIdType) =>
            Atom.make((get) => get(metadataValues(id))),
          );
          const terminalFactory = TerminalState.createTerminalEnvironmentAtoms;
          using _terminals = vi
            .spyOn(TerminalState, "createTerminalEnvironmentAtoms")
            .mockImplementation((...args) => ({
              ...terminalFactory(...args),
              metadata: ({ environmentId }) => metadataAtoms(environmentId),
            }));
          using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const url = new URL(
              typeof input === "string" || input instanceof URL ? input : input.url,
            );
            if (url.pathname === "/api/auth/session") return Response.json(grant(false));
            return Response.json({
              environmentId: url.hostname.startsWith("second") ? secondId : firstId,
              label: "Terminal fixture",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.0.0-test",
              orchestrationProtocolVersion: 0,
              capabilities: {},
            });
          });
          const other = yield* Effect.promise(() =>
            createTuiClient({
              configDir,
              url: "http://second-terminal.invalid",
              token: "test-second-terminal",
            }),
          );
          other.close();
          const client = yield* Effect.promise(() =>
            createTuiClient({
              configDir,
              url: "http://first-terminal.invalid",
              token: "test-first-terminal",
            }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));
          const awaitSnapshot = (predicate: (snapshot: TuiSnapshot) => boolean) =>
            Effect.callback<void>((resume) => {
              const stop = client.subscribe((value) => {
                if (predicate(value)) resume(Effect.void);
              });
              return Effect.sync(stop);
            });
          yield* awaitSnapshot(
            (value) =>
              value.connection === "connected" &&
              value.terminalMetadata?.error !== null &&
              value.terminalMetadata?.error !== undefined,
          );
          if (!atomRegistry) throw new Error("Terminal fixture did not mount its shell");
          const running: TerminalSummary = {
            threadId: v2ThreadShell.id,
            terminalId: "command",
            cwd: "/repo",
            worktreePath: null,
            status: "running",
            pid: 100,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: true,
            label: "Command",
            updatedAt: "2026-06-20T00:00:00.000Z",
          };
          atomRegistry.set(metadataValues(firstId), AsyncResult.success([running]));
          expect(client.snapshot().terminalMetadata?.terminals).toEqual([]);
          atomRegistry.set(sessionValues(firstId), AsyncResult.success(grant(true)));
          expect(client.snapshot().terminalMetadata).toEqual({
            terminals: [running],
            loading: false,
            error: null,
          });
          atomRegistry.set(
            metadataValues(firstId),
            AsyncResult.waiting(AsyncResult.success([running])),
          );
          expect(client.snapshot().terminalMetadata).toEqual({
            terminals: [running],
            loading: false,
            error: null,
          });
          atomRegistry.set(metadataValues(firstId), AsyncResult.success([running]));
          atomRegistry.set(
            sessionValues(firstId),
            AsyncResult.waiting(AsyncResult.success(grant(true))),
          );
          expect(client.snapshot().terminalMetadata).toEqual({
            terminals: [running],
            loading: false,
            error: null,
          });
          atomRegistry.set(sessionValues(firstId), AsyncResult.success(grant(true)));
          atomRegistry.set(
            metadataValues(firstId),
            AsyncResult.success([{ ...running, hasRunningSubprocess: false }]),
          );
          expect(client.snapshot().terminalMetadata?.terminals[0]?.hasRunningSubprocess).toBe(
            false,
          );
          atomRegistry.set(metadataValues(firstId), AsyncResult.success([]));
          expect(client.snapshot().terminalMetadata).toEqual({
            terminals: [],
            loading: false,
            error: null,
          });
          atomRegistry.set(
            metadataValues(firstId),
            AsyncResult.failure(Cause.fail("Metadata stream failed")),
          );
          expect(client.snapshot().terminalMetadata?.error).toContain("Metadata stream failed");
          expect(client.snapshot().terminalMetadata?.terminals).toEqual([]);
          atomRegistry.set(metadataValues(firstId), AsyncResult.success([running]));
          expect(client.snapshot().terminalMetadata?.terminals).toEqual([running]);
          yield* SubscriptionRef.set(firstConnection, {
            ...AVAILABLE_CONNECTION_STATE,
            phase: "backoff" as const,
          });
          yield* awaitSnapshot(
            (value) =>
              value.connection === "backoff" &&
              value.terminalMetadata?.loading === false &&
              value.terminalMetadata.terminals.length === 0,
          );
          atomRegistry.set(metadataValues(firstId), AsyncResult.initial());
          yield* SubscriptionRef.set(firstConnection, {
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected" as const,
            generation: 2,
          });
          yield* awaitSnapshot(
            (value) => value.connection === "connected" && value.terminalMetadata?.loading === true,
          );
          atomRegistry.set(metadataValues(firstId), AsyncResult.success([running]));
          expect(client.snapshot().terminalMetadata?.terminals).toEqual([running]);
          atomRegistry.set(sessionValues(firstId), AsyncResult.success(grant(false)));
          expect(client.snapshot().terminalMetadata?.terminals).toEqual([]);
          expect(client.snapshot().terminalMetadata?.error).not.toBeNull();
          atomRegistry.set(sessionValues(firstId), AsyncResult.success(grant(true)));
          expect(client.snapshot().terminalMetadata?.terminals).toEqual([running]);
          yield* Effect.promise(() => client.selectEnvironment(secondId));
          yield* awaitSnapshot(
            (value) =>
              value.environmentId === secondId &&
              value.connection === "connected" &&
              !!value.terminalMetadata?.error,
          );
          expect(client.snapshot().terminalMetadata?.terminals).toEqual([]);
          atomRegistry.set(
            metadataValues(firstId),
            AsyncResult.success([{ ...running, label: "Wrong environment" }]),
          );
          expect(client.snapshot().terminalMetadata?.terminals).toEqual([]);
          atomRegistry.set(sessionValues(secondId), AsyncResult.success(grant(true)));
          atomRegistry.set(
            metadataValues(secondId),
            AsyncResult.success([{ ...running, terminalId: "second" }]),
          );
          expect(client.snapshot().terminalMetadata?.terminals[0]?.terminalId).toBe("second");
        }),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
    ),
);
