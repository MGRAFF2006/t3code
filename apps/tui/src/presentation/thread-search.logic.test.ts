import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationThreadSearchMatch,
  type OrchestrationV2SearchThreadsResult,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  v2Now,
  v2Project,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  createThreadSearchLoader,
  rankThreadSearch,
  threadSearchRequest,
  type ThreadSearchRemoteState,
} from "./thread-search.logic.ts";

const environmentId = EnvironmentId.make("search-environment");
const now = DateTime.toEpochMillis(v2Now);

function thread(id: string, changes: Partial<OrchestrationV2ThreadShell> = {}) {
  return { ...v2ThreadShell, id: ThreadId.make(id), ...changes };
}

function message(threadId: string, quality = 1): OrchestrationThreadSearchMatch {
  return {
    threadId: ThreadId.make(threadId),
    projectId: v2Project.id,
    source: "assistant",
    snippet: "An older message mentions workspace search.",
    messageCreatedAt: "2026-06-20T00:00:00.000Z",
    quality,
  };
}

it("uses desktop metadata matching and ranking across titles, branches, projects, PRs and IDs", () => {
  const threads = [
    thread("inside", { title: "Homework notes" }),
    thread("title", { title: "Fix workspace search" }),
    thread("branch", { title: "Review changes", branch: "t3/worktree-cleanup" }),
    thread("pr", {
      linkedPullRequest: {
        projectId: v2Project.id,
        number: 812,
        repository: "owner/repo",
        url: "https://github.com/owner/repo/pull/812",
      },
    }),
  ];
  const search = (query: string) =>
    rankThreadSearch({ environmentId, threads, projects: [v2Project], query, now });
  expect(search("work").map((row) => row.thread.id)).toEqual(["title", "branch", "inside"]);
  expect(search("cleanup")[0]).toMatchObject({
    thread: { id: "branch" },
    hint: "Branch: worktree-cleanup",
  });
  expect(search("Project")).toHaveLength(4);
  expect(search("#812").map((row) => row.thread.id)).toEqual(["pr"]);
  expect(search("owner/repo#812").map((row) => row.thread.id)).toEqual(["pr"]);
  expect(search("https://github.com/owner/repo/pull/812").map((row) => row.thread.id)).toEqual([
    "pr",
  ]);
  expect(
    rankThreadSearch({
      environmentId,
      threads: [thread("thread-reference-12345678")],
      projects: [v2Project],
      query: "thread-reference-12345678",
      now,
    }).map((row) => row.thread.id),
  ).toEqual(["thread-reference-12345678"]);
  expect(search("  WORKSPACE   search ").map((row) => row.thread.id)).toEqual(["title"]);
  expect(search("worktree typo nonsense")).toEqual([]);
});

it("ranks complete message history below metadata once, including omitted settled rows", () => {
  const title = thread("title", { title: "Workspace search" });
  const history = thread("history", { title: "Older conversation" });
  const omitted = thread("omitted", { title: "Settled conversation", settledOverride: "settled" });
  const archived = thread("archived", { archivedAt: v2Now });
  const child = thread("child", {
    lineage: {
      rootThreadId: title.id,
      parentThreadId: title.id,
      relationshipToParent: "subagent",
    },
  });
  const rows = rankThreadSearch({
    environmentId,
    threads: [title, history, archived, child],
    projects: [v2Project],
    query: "workspace search",
    now,
    result: {
      threads: [omitted, { ...title, title: "Stale title" }],
      matches: [
        message("history", 0.8),
        message("title"),
        message("omitted"),
        message("history"),
        message("archived"),
        message("child"),
        message("unloaded"),
      ],
    },
  });
  expect(rows.map((row) => [row.thread.id, row.source])).toEqual([
    ["title", "metadata"],
    ["omitted", "message"],
    ["history", "message"],
  ]);
  expect(rows[1]?.hint).toBe("Agent: An older message mentions workspace search.");
  expect(rows[2]?.message?.quality).toBe(1);
});

it("uses desktop history thresholds and legacy-safe requests, with omitted title search", () => {
  expect(threadSearchRequest({ query: "   " })).toBeNull();
  expect(threadSearchRequest({ query: "hi" })).toBeNull();
  expect(threadSearchRequest({ query: "部署" })).toEqual({ query: "部署" });
  expect(threadSearchRequest({ query: "cat is" })).toEqual({ query: "cat is" });
  const before = "2026-06-01T00:00:00.000Z";
  expect(threadSearchRequest({ query: "hi", before, environmentLabel: "Laptop" })).toEqual({
    query: "hi",
    olderSettledBefore: before,
    environmentLabel: "Laptop",
    titlesOnly: true,
  });
  expect(threadSearchRequest({ query: "x", before })).toBeNull();
  expect(threadSearchRequest({ query: "cat", before })).toEqual({
    query: "cat",
    olderSettledBefore: before,
    environmentLabel: "",
  });
  expect(threadSearchRequest({ query: "x".repeat(220) })?.query).toHaveLength(200);
});

it("rejects obsolete query/environment results, cancelled dispatch and late disposal", async () => {
  const states: ThreadSearchRemoteState[] = [];
  const loader = createThreadSearchLoader((state) => states.push(state));
  const first = Promise.withResolvers<OrchestrationV2SearchThreadsResult>();
  const second = Promise.withResolvers<OrchestrationV2SearchThreadsResult>();
  const skipped = vi.fn(async () => ({ matches: [] }));
  const loadFirst = vi.fn(() => first.promise);
  const loadSecond = vi.fn(() => second.promise);
  try {
    const cancelled = loader.update("a:wor", skipped);
    const dispatchFirst = loader.update("a:workspace", loadFirst);
    expect(states.at(-1)).toEqual({ key: "a:workspace", loading: true, error: null });
    cancelled();
    const firstDone = dispatchFirst();
    await Promise.resolve();
    expect(skipped).not.toHaveBeenCalled();
    expect(loadFirst).toHaveBeenCalledOnce();
    const secondDone = loader.update("b:other", loadSecond)();
    await Promise.resolve();
    second.resolve({ matches: [message("second")] });
    await secondDone;
    expect(states.at(-1)).toMatchObject({ key: "b:other", loading: false });
    const completed = states.length;
    first.resolve({ matches: [message("first")] });
    await firstDone;
    expect(states).toHaveLength(completed);
    expect(states.at(-1)?.result?.matches[0]?.threadId).toBe("second");
    const failure = Promise.withResolvers<OrchestrationV2SearchThreadsResult>();
    const failed = loader.update("b:failure", () => failure.promise)();
    await Promise.resolve();
    failure.reject(new Error("Search unavailable"));
    await failed;
    expect(states.at(-1)).toEqual({
      key: "b:failure",
      loading: false,
      error: "Search unavailable",
    });
    loader.update("b:clear", null);
    expect(states.at(-1)).toEqual({ key: "b:clear", loading: false, error: null });
    const late = Promise.withResolvers<OrchestrationV2SearchThreadsResult>();
    const lateDone = loader.update("b:in-flight", () => late.promise)();
    await Promise.resolve();
    const disposed = loader.update("b:closed", skipped);
    loader.close();
    const closed = states.length;
    disposed();
    late.resolve({ matches: [message("late")] });
    await lateDone;
    expect(states).toHaveLength(closed);
    expect(skipped).not.toHaveBeenCalled();
  } finally {
    loader.close();
  }
});
