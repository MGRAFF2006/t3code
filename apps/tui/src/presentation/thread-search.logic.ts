import {
  isListedThreadLineage,
  THREAD_SEARCH_QUERY_MAX_LENGTH,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationThreadSearchMatch,
  type OrchestrationV2SearchThreadsInput,
  type OrchestrationV2SearchThreadsResult,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadSearchSubject } from "@t3tools/client-runtime/state/thread-search";
import {
  foldSearchQuery,
  messageSearchTokens,
  rankMessageMatches,
  rankSearchItems,
  scoreThreadSearch,
  threadRecentUse,
} from "@t3tools/shared/paletteSearch";

export interface ThreadSearchRow {
  readonly thread: OrchestrationV2ThreadShell;
  readonly source: "metadata" | "message";
  readonly hint?: string;
  readonly message?: OrchestrationThreadSearchMatch;
}

export function threadSearchQuery(query: string) {
  return query.trim().slice(0, THREAD_SEARCH_QUERY_MAX_LENGTH);
}

const presented = new WeakMap<OrchestrationV2ThreadShell, ReturnType<typeof presentThreadShell>>();

export function rankThreadSearch(options: {
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly query: string;
  readonly result?: OrchestrationV2SearchThreadsResult | undefined;
  readonly picks?: boolean | undefined;
  readonly now: number;
}): ThreadSearchRow[] {
  const projects = new Map(options.projects.map((project) => [project.id, project.title]));
  const threads = [
    ...new Map(
      [...(options.result?.threads ?? []), ...options.threads].map((thread) => [thread.id, thread]),
    ).values(),
  ].filter(
    (thread) => !thread.archivedAt && !thread.deletedAt && isListedThreadLineage(thread.lineage),
  );
  const subjectOf = (thread: OrchestrationV2ThreadShell) => {
    let shell = presented.get(thread);
    if (!shell || shell.environmentId !== options.environmentId) {
      shell = presentThreadShell(options.environmentId, thread);
      presented.set(thread, shell);
    }
    return threadSearchSubject(shell, projects.get(thread.projectId));
  };
  const query = foldSearchQuery(threadSearchQuery(options.query));
  if (!query)
    return [...threads]
      .sort((left, right) => threadRecentUse(subjectOf(right)) - threadRecentUse(subjectOf(left)))
      .map((thread) => ({ thread, source: "metadata" }));
  const metadata = rankSearchItems(threads, (thread, ranking) =>
    scoreThreadSearch(query, subjectOf(thread), options.now, {
      ...ranking,
      picks: options.picks ?? false,
    }),
  );
  const rows: ThreadSearchRow[] = metadata.map(({ item: thread, match }) => {
    const hint = match.explain?.();
    return {
      thread,
      source: "metadata",
      ...(hint ? { hint: `${hint.label}: ${hint.text}` } : {}),
    };
  });
  const included = new Set(rows.map((row) => row.thread.id));
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const messages = rankMessageMatches(
    options.result?.matches ?? [],
    (match) => {
      const thread = byId.get(match.threadId);
      return thread ? subjectOf(thread) : undefined;
    },
    query,
    options.now,
    { picks: options.picks ?? false },
  );
  for (const message of messages) {
    const thread = byId.get(message.threadId);
    if (!thread || included.has(thread.id)) continue;
    included.add(thread.id);
    rows.push({
      thread,
      source: "message",
      hint: `${message.source === "user" ? "You" : "Agent"}: ${message.snippet}`,
      message,
    });
  }
  return rows;
}

export interface ThreadSearchRemoteState {
  readonly key: string;
  readonly result?: OrchestrationV2SearchThreadsResult;
  readonly loading: boolean;
  readonly error: string | null;
}

export function threadSearchRequest(input: {
  readonly query: string;
  readonly before?: string | undefined;
  readonly environmentLabel?: string | undefined;
}): OrchestrationV2SearchThreadsInput | null {
  const query = threadSearchQuery(input.query);
  if (!foldSearchQuery(query)) return null;
  const messages = messageSearchTokens(query).long.length > 0;
  if (!messages && (!input.before || query.length < 2)) return null;
  return {
    query,
    ...(input.before
      ? {
          olderSettledBefore: input.before,
          environmentLabel: input.environmentLabel ?? "",
          ...(messages ? {} : { titlesOnly: true }),
        }
      : {}),
  };
}

export function createThreadSearchLoader(publish: (state: ThreadSearchRemoteState) => void) {
  let version = 0;
  let closed = false;
  return {
    update(key: string, load: (() => Promise<OrchestrationV2SearchThreadsResult>) | null) {
      const requestVersion = ++version;
      if (closed) return () => {};
      publish({ key, loading: load !== null, error: null });
      return () => {
        if (!load || closed || version !== requestVersion) return;
        return Promise.resolve()
          .then(load)
          .then(
            (result) => {
              if (!closed && version === requestVersion)
                publish({ key, result, loading: false, error: null });
            },
            (error: unknown) => {
              if (!closed && version === requestVersion)
                publish({
                  key,
                  loading: false,
                  error: error instanceof Error ? error.message : String(error),
                });
            },
          );
      };
    },
    close() {
      closed = true;
      version += 1;
    },
  };
}
