import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  v2ThreadShell,
  v2Now,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as DateTime from "effect/DateTime";
import { threadStatus } from "./thread-status.ts";

it.each([
  { name: "new thread", changes: { latestRunId: null }, expected: "ready" },
  ...(["queued", "preparing", "starting", "running", "waiting"] as const).map((status) => ({
    name: status,
    changes: { status },
    expected: "working",
  })),
  {
    name: "active follow-up after completion",
    changes: { status: "completed", activityRunStatus: "running" },
    expected: "working",
  },
  {
    name: "waiting for related work",
    changes: { status: "running", blockedOnThreadWait: true },
    expected: "waiting",
  },
  {
    name: "completed with awaited background work",
    changes: {
      status: "completed",
      pendingBackgroundTasks: [{ taskId: "background", kind: "command", awaited: true }],
    },
    expected: "waiting",
  },
  {
    name: "completed with unawaited monitor",
    changes: {
      status: "completed",
      pendingBackgroundTasks: [{ taskId: "monitor", kind: "monitor" }],
    },
    expected: "ready",
  },
  {
    name: "completed despite earlier error",
    changes: { status: "completed", lastError: "Old error" },
    expected: "ready",
  },
  {
    name: "missing provider credential",
    changes: { status: "failed", lastErrorClass: "provider_error", lastError: "Missing API token" },
    expected: "failed",
  },
  {
    name: "exhausted provider token budget",
    changes: {
      status: "failed",
      lastErrorClass: "usage_limit",
      lastError: "Token budget exhausted",
    },
    expected: "limited",
  },
  ...(["interrupted", "cancelled", "rolled_back"] as const).map((status) => ({
    name: status,
    changes: { status },
    expected: "ready",
  })),
  ...(["command", "user_input", "auth_refresh"] as const).map((kind) => ({
    name: `running with ${kind}`,
    changes: {
      status: "running" as const,
      pendingRuntimeRequest: { id: RuntimeRequestId.make("request"), kind, createdAt: v2Now },
    },
    expected: kind === "auth_refresh" ? "working" : kind === "user_input" ? "input" : "approval",
  })),
  {
    name: "unseen completion",
    changes: { status: "completed", lastVisitedAt: DateTime.makeUnsafe("2026-06-19T23:59:00Z") },
    expected: "done",
  },
  {
    name: "completion cleared by visit",
    changes: { status: "completed", lastVisitedAt: v2Now },
    expected: "ready",
  },
  {
    name: "dated failure cleared by visit",
    changes: { status: "failed", lastVisitedAt: v2Now },
    expected: "ready",
  },
  {
    name: "undated failed run remains after visit",
    changes: {
      status: "failed",
      latestRunCompletedAt: null,
      latestRunStartedAt: null,
      latestRunRequestedAt: null,
      lastVisitedAt: v2Now,
    },
    expected: "failed",
  },
  {
    name: "usage limit remains after visit",
    changes: { status: "failed", lastErrorClass: "usage_limit", lastVisitedAt: v2Now },
    expected: "limited",
  },
  {
    name: "guest request after completion",
    changes: { status: "completed", pendingGuestMessageCount: 1 },
    expected: "request",
  },
  ...(["command", "user_input"] as const).map((kind) => ({
    name: `${kind} before guest request`,
    changes: {
      status: "running" as const,
      pendingRuntimeRequest: { id: RuntimeRequestId.make("request"), kind, createdAt: v2Now },
      pendingGuestMessageCount: 1,
    },
    expected: kind === "user_input" ? "input" : "approval",
  })),
  ...(
    [
      { name: "unseen snooze wake", changes: {}, expected: "woken" },
      { name: "acknowledged wake", changes: { lastVisitedAt: v2Now }, expected: "ready" },
      { name: "settled wake", changes: { settledOverride: "settled" }, expected: "ready" },
      { name: "active work after wake", changes: { status: "running" }, expected: "working" },
      { name: "failure after wake", changes: { status: "failed" }, expected: "failed" },
      {
        name: "future snooze",
        changes: { snoozedUntil: DateTime.makeUnsafe("2026-06-21T00:00:00Z") },
        expected: "ready",
      },
    ] satisfies Array<{
      name: string;
      changes: Partial<OrchestrationV2ThreadShell>;
      expected: string;
    }>
  ).map((test) => ({
    ...test,
    changes: { status: "completed" as const, snoozedUntil: v2Now, ...test.changes },
  })),
] satisfies Array<{
  name: string;
  changes: Partial<OrchestrationV2ThreadShell>;
  expected: string;
}>)("shows the effective state for $name", ({ changes, expected }) => {
  const thread = { ...v2ThreadShell, latestRunId: RunId.make("latest"), ...changes };
  expect(
    threadStatus(
      presentThreadShell(EnvironmentId.make("environment"), thread),
      "2026-06-20T00:01:00Z",
    ),
  ).toBe(expected);
});
