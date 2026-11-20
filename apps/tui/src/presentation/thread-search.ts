import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import { nextShownOrder, type ShownOrder } from "@t3tools/client-runtime/state/thread-search";
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { request } from "../rpc/request.ts";
import type { TuiClient, TuiSnapshot } from "../runtime/client.ts";
import {
  createThreadSearchLoader,
  rankThreadSearch,
  threadSearchQuery,
  threadSearchRequest,
  type ThreadSearchRemoteState,
  type ThreadSearchRow,
} from "./thread-search.logic.ts";

export type { ThreadSearchRow } from "./thread-search.logic.ts";

export function createThreadSearch(options: {
  readonly client: Accessor<
    (Pick<TuiClient, "invoke"> & Partial<Pick<TuiClient, "mountSearchRows">>) | null
  >;
  readonly state: Accessor<TuiSnapshot | null>;
  readonly query: Accessor<string>;
  readonly picks?: boolean;
}) {
  const [remote, setRemote] = createSignal<ThreadSearchRemoteState>({
    key: "",
    loading: false,
    error: null,
  });
  const shell = createMemo(() => options.state()?.shell);
  const threads = createMemo(() => [
    ...(shell()?.threads ?? []),
    ...(shell()?.archivedThreads ?? []),
  ]);
  const projects = createMemo(() => shell()?.projects);
  const scope = createMemo(
    () => {
      const state = options.state();
      const query = threadSearchQuery(options.query());
      const before = state?.config?.shellOlderSettled
        ? state.shell?.olderSettled?.before
        : undefined;
      const input = threadSearchRequest({ query, before, environmentLabel: state?.label });
      return {
        environmentId: state?.environmentId ?? null,
        client: options.client(),
        query,
        input,
        key: JSON.stringify([state?.environmentId ?? null, state?.connection, query, input]),
      };
    },
    undefined,
    { equals: (left, right) => left.key === right.key && left.client === right.client },
  );
  const loader = createThreadSearchLoader(setRemote);
  createEffect(() => {
    const current = scope();
    const execute = loader.update(
      current.key,
      current.environmentId && current.client && current.input
        ? () => {
            if (
              options.state()?.environmentId !== current.environmentId ||
              scope().key !== current.key ||
              options.client() !== current.client
            )
              return Promise.reject(new Error("The search environment changed."));
            return request(
              current.client!,
              ORCHESTRATION_V2_WS_METHODS.searchThreads,
              current.input!,
            );
          }
        : null,
    );
    const debounce = Effect.runFork(Effect.sleep(150).pipe(Effect.andThen(Effect.sync(execute))));
    onCleanup(() => {
      Effect.runFork(Fiber.interrupt(debounce));
    });
  });
  onCleanup(() => loader.close());
  createEffect(() => {
    const current = scope();
    const result = remote();
    if (result.key !== current.key || !result.result || !current.environmentId) return;
    const release = current.client?.mountSearchRows?.(current.environmentId, result.result);
    onCleanup(() => release?.());
  });
  let shownOrder: ShownOrder | null = null;
  return createMemo(() => {
    const current = scope();
    const result = remote();
    const visible = result.key === current.key ? result : null;
    const ranked = current.environmentId
      ? rankThreadSearch({
          environmentId: current.environmentId,
          threads: threads() ?? [],
          projects: projects() ?? [],
          query: current.query,
          result:
            current.client?.mountSearchRows && visible?.result
              ? { ...visible.result, threads: [] }
              : visible?.result,
          picks: options.picks,
          now: DateTime.toEpochMillis(DateTime.nowUnsafe()),
        })
      : [];
    const messages = new Map<string, ThreadSearchRow>(
      ranked.filter((row) => row.source === "message").map((row) => [row.thread.id, row]),
    );
    shownOrder = nextShownOrder(shownOrder, current.key, [...messages.keys()], Infinity);
    return {
      rows: [
        ...ranked.filter((row) => row.source === "metadata"),
        ...shownOrder.keys.flatMap((id) => {
          const row = messages.get(id);
          return row ? [row] : [];
        }),
      ],
      loading:
        current.environmentId !== null &&
        current.client !== null &&
        current.input !== null &&
        (visible?.loading ?? true),
      error: visible?.error ?? null,
    };
  });
}
