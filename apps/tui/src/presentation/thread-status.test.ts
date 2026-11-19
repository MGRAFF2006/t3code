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
  { name: "new thread", changes: { latestRunId: null }, expected: "idle" },
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
    expected: "done",
  },
  {
    name: "completed despite earlier error",
    changes: { status: "completed", lastError: "Old error" },
    expected: "done",
  },
  {
    name: "failed",
    changes: { status: "failed", lastError: "Provider failed" },
    expected: "failed",
  },
  {
    name: "usage limit",
    changes: { status: "failed", lastErrorClass: "usage_limit" },
    expected: "limited",
  },
  ...(["interrupted", "cancelled", "rolled_back"] as const).map((status) => ({
    name: status,
    changes: { status },
    expected: "stopped",
  })),
  ...(["command", "user_input", "auth_refresh"] as const).map((kind) => ({
    name: `running with ${kind}`,
    changes: {
      status: "running" as const,
      pendingRuntimeRequest: { id: RuntimeRequestId.make("request"), kind, createdAt: v2Now },
    },
    expected: kind === "auth_refresh" ? "working" : "attention",
  })),
  {
    name: "guest request after completion",
    changes: { status: "completed", pendingGuestMessageCount: 1 },
    expected: "attention",
  },
  ...(
    [
      { name: "unseen snooze wake", changes: {}, expected: "woken" },
      { name: "acknowledged wake", changes: { lastVisitedAt: v2Now }, expected: "done" },
      { name: "settled wake", changes: { settledOverride: "settled" }, expected: "done" },
      { name: "active work after wake", changes: { status: "running" }, expected: "working" },
      { name: "failure after wake", changes: { status: "failed" }, expected: "failed" },
      {
        name: "future snooze",
        changes: { snoozedUntil: DateTime.makeUnsafe("2026-06-21T00:00:00Z") },
        expected: "done",
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
