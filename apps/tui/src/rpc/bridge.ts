import {
  type EnvironmentRpcInput,
  type EnvironmentRpcStreamFailure,
  type EnvironmentStreamRpcTag,
  EnvironmentRpcUnavailableError,
  type EnvironmentUnaryRpcTag,
  type EnvironmentSubscriptionRpcTag,
  type EnvironmentStreamCommandRpcTag,
  RpcPermissionGuard,
  subscribe,
  subscribeDynamic,
  runStreamGuarded,
} from "@t3tools/client-runtime/rpc";
import {
  type EnvironmentId,
  type EnvironmentAuthorizationError,
  WS_METHODS,
} from "@t3tools/contracts";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  createCommandPermissions,
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";
import { decodeServiceInput } from "./catalog.ts";

const streamCommands: ReadonlySet<string> = new Set([
  WS_METHODS.chatGptHandoffSubscribe,
  WS_METHODS.cloudInstallRelayClient,
  WS_METHODS.serverUpdateServerWithProgress,
  WS_METHODS.gitRunStackedAction,
]);

function subscriptionSource(method: string, payload: unknown) {
  if (method === WS_METHODS.terminalAttach) {
    const input = payload as EnvironmentRpcInput<typeof WS_METHODS.terminalAttach>;
    let replied = false;
    return subscribeDynamic(WS_METHODS.terminalAttach, () =>
      Effect.sync(() => ({ ...input, ...(replied ? { resume: true } : {}) })),
    ).pipe(
      Stream.onFirst(() =>
        Effect.sync(() => {
          replied = true;
        }),
      ),
    );
  }
  return subscribe(
    method as EnvironmentSubscriptionRpcTag,
    payload as EnvironmentRpcInput<EnvironmentSubscriptionRpcTag>,
  );
}

export function createRpcBridge<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  registry: AtomRegistry.AtomRegistry,
  requireEnvironment: () => EnvironmentId,
  observe: <A>(atom: Atom.Atom<A>, listener: (value: A) => void) => () => void,
) {
  return {
    invoke: async (method: string, payload: unknown) => {
      const environmentId = requireEnvironment();
      const decoded = decodeServiceInput(method, payload);
      if (decoded.stream) throw new Error(`${method} is a stream. Use stream() to subscribe.`);
      const tag = method as EnvironmentUnaryRpcTag;
      const command = createEnvironmentRpcCommand(runtime, { label: `tui:${method}`, tag });
      const result = await command.run(registry, {
        environmentId,
        input: decoded.input as EnvironmentRpcInput<typeof tag>,
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    },
    stream: (
      method: string,
      payload: unknown,
      onValue: (value: unknown) => void,
      onError?: (error: Error) => void,
    ) => {
      const environmentId = requireEnvironment();
      const decoded = decodeServiceInput(method, payload);
      if (!decoded.stream) throw new Error(`${method} is unary. Use invoke() to call it.`);
      const permissions = createCommandPermissions(runtime, method);
      const source: Stream.Stream<
        unknown,
        | EnvironmentRpcStreamFailure<EnvironmentStreamRpcTag>
        | EnvironmentRpcUnavailableError
        | EnvironmentAuthorizationError,
        EnvironmentSupervisor.EnvironmentSupervisor
      > = streamCommands.has(method)
        ? runStreamGuarded(
            method as EnvironmentStreamCommandRpcTag,
            decoded.input as EnvironmentRpcInput<EnvironmentStreamCommandRpcTag>,
          )
        : subscriptionSource(method, decoded.input);
      const atom = runtime
        .atom(
          Stream.unwrap(
            Effect.gen(function* () {
              yield* permissions.authorize(registry, environmentId, decoded.input);
              const connections = yield* EnvironmentRegistry.EnvironmentRegistry;
              return connections.runStream(environmentId, source).pipe(
                Stream.provideService(RpcPermissionGuard, {
                  authorize: (id, tag, input) =>
                    createCommandPermissions(runtime, tag).authorize(registry, id, input),
                }),
              );
            }),
          ),
        )
        .pipe(Atom.setIdleTTL(0));
      return observe(atom, (result) => {
        if (result._tag === "Success") onValue(result.value);
        else if (result._tag === "Failure") onError?.(new Error(Cause.pretty(result.cause)));
      });
    },
  };
}
