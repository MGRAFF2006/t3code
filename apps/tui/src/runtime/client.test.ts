// @effect-diagnostics nodeBuiltinImport:off -- Starts the terminal client against its own empty temporary state directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { SshPasswordPrompt } from "@t3tools/ssh/auth";
import * as ClientPlatform from "./platform.ts";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import * as ShellState from "@t3tools/client-runtime/state/shell";
import * as ThreadState from "@t3tools/client-runtime/state/threads";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  v2Project,
  v2Projection,
  v2ShellSnapshot,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as RpcBridge from "../rpc/bridge.ts";
import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { createTuiClient } from "./client.ts";

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

  it.effect.each(["new-thread", "preferred-new-thread", "send-switch"] as const)(
    "keeps model selection with the intended destination for %s",
    (scenario) =>
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
              defaultModelSelection: modelB,
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
            const shellFactory = ShellState.createEnvironmentShellAtoms;
            using _shell = vi
              .spyOn(ShellState, "createEnvironmentShellAtoms")
              .mockImplementation((runtime) => ({
                ...shellFactory(runtime),
                stateValueAtom: () =>
                  Atom.make({
                    ...ShellState.EMPTY_SHELL_STATE,
                    snapshot: Option.some({ ...v2ShellSnapshot, projects: [projectA, projectB] }),
                    status: "live" as const,
                  }),
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
            if (scenario !== "send-switch") {
              const explicitModel = { ...modelA, model: "explicit-model" };
              if (scenario === "preferred-new-thread") {
                client.selectThread(null);
                yield* Effect.promise(() => client.setModel(explicitModel));
                client.selectThread(threadA.thread.id);
              }
              yield* Effect.promise(() => client.createThread(projectB.id));
              expect(launched).toMatchObject({
                projectId: projectB.id,
                modelSelection: scenario === "preferred-new-thread" ? explicitModel : modelB,
              });
            } else {
              const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
              using _random = vi
                .spyOn(globalThis.crypto, "getRandomValues")
                .mockImplementation((array) => {
                  client.selectThread(threadB.thread.id);
                  return getRandomValues(array);
                });
              yield* Effect.promise(() => client.send("Message for A"));
              expect(dispatched).toMatchObject({
                threadId: threadA.thread.id,
                modelSelection: modelA,
                runtimeMode: "approval-required",
                interactionMode: "default",
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
