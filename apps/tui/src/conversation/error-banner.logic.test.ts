import { expect, it } from "vite-plus/test";
import { EnvironmentId, RunId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { recordServerClock } from "@t3tools/client-runtime/clock";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { v2ThreadShell } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  threadErrorBanner,
  usageRecoveryResetDelay,
  usageRecoveryState,
} from "./error-banner.logic.ts";

it("distinguishes recoverable usage limits from errors while retaining error identity and scope", () => {
  const raw = JSON.stringify({
    error: { message: "Missing API token" },
    debug: "provider details",
  });
  const result = threadErrorBanner("local", "thread", raw, "provider_error");
  expect(result).toMatchObject({
    tone: "error",
    message: "Missing API token",
    chatGptLimit: false,
  });
  expect(result?.key).toContain(raw);
  expect(result?.key).not.toBe(threadErrorBanner("remote", "thread", raw)?.key);
  expect(result?.key).not.toBe(threadErrorBanner("local", "other", raw)?.key);
  expect(threadErrorBanner("local", "thread", "Plain provider error")?.message).toBe(
    "Plain provider error",
  );
  expect(threadErrorBanner("local", "thread", '{"error":null}')?.message).toBe('{"error":null}');
  expect(threadErrorBanner("local", "thread", null)).toBeNull();
  expect(threadErrorBanner("local", "thread", "Limit", "usage_limit")).toMatchObject({
    tone: "warning",
    chatGptLimit: false,
  });
  expect(
    threadErrorBanner("local", "thread", "Limit", null, CHATGPT_USAGE_LIMIT_CODE),
  ).toMatchObject({ tone: "warning", chatGptLimit: true, workspaceLimit: false });
  expect(
    threadErrorBanner("local", "thread", "Limit", null, CHATGPT_WORKSPACE_USAGE_LIMIT_CODE),
  ).toMatchObject({ tone: "warning", chatGptLimit: true, workspaceLimit: true });
});

const now = "2026-06-20T00:00:00.000Z";
const resetAt = "2026-06-20T01:00:00.000Z";
const runId = RunId.make("limited-run");
const limited: OrchestrationV2ThreadShell = {
  ...v2ThreadShell,
  latestRunId: runId,
  status: "failed",
  lastErrorClass: "usage_limit",
  usageLimitResetAt: resetAt,
  latestRunCompletedAt: DateTime.makeUnsafe(now),
};
const environmentId = EnvironmentId.make("local");

it("keeps auto-resume and owned snoozing independent and discards recovery from earlier limits", () => {
  const state = (shell: OrchestrationV2ThreadShell, time = now, pending = false) =>
    usageRecoveryState(shell, environmentId, pending, time);
  expect(state(limited)).toMatchObject({ canSchedule: true, scheduled: false, snoozed: false });
  const recovery = { runId, resetAt, autoResume: true };
  expect(state({ ...limited, limitRecovery: recovery })).toMatchObject({
    scheduled: true,
    snoozed: false,
  });
  expect(
    state({
      ...limited,
      limitRecovery: { ...recovery, autoResume: false, snooze: true },
      snoozedUntil: DateTime.makeUnsafe(resetAt),
    }),
  ).toMatchObject({ scheduled: false, snoozed: true });
  expect(
    state({
      ...limited,
      limitRecovery: recovery,
      snoozedUntil: DateTime.makeUnsafe("2026-06-20T02:00:00.000Z"),
    })?.description,
  ).toBe("Resumes: 2026-06-20T02:00:00.000Z");
  expect(
    state({
      ...limited,
      limitRecovery: { ...recovery, runId: RunId.make("older-run"), snooze: true },
      snoozedUntil: DateTime.makeUnsafe(resetAt),
    }),
  ).toMatchObject({ scheduled: false, snoozed: false });
  expect(
    state(
      {
        ...limited,
        limitRecovery: { ...recovery, snooze: true },
        snoozedUntil: DateTime.makeUnsafe(resetAt),
      },
      resetAt,
    ),
  ).toMatchObject({ resetPassed: true, snoozed: false });
  expect(state(limited, now, true)?.canSchedule).toBe(false);
  expect(state({ ...limited, settledOverride: "settled" })?.canSchedule).toBe(false);
  expect(state({ ...limited, usageLimitResetAt: now })?.canSchedule).toBe(false);
  expect(state({ ...limited, usageLimitResetAt: null })).toMatchObject({
    canSchedule: false,
    resetAt: null,
  });
  expect(state({ ...limited, status: "running" })).toBeNull();
  expect(state({ ...limited, lastErrorClass: "provider_error" })).toBeNull();
});

it("expires owned recovery snoozes on the environment clock when a remote clock disagrees", () => {
  const clientNow = Date.parse(now);
  const snoozed: OrchestrationV2ThreadShell = {
    ...limited,
    limitRecovery: { runId, resetAt, autoResume: false, snooze: true },
    snoozedUntil: DateTime.makeUnsafe(resetAt),
  };
  for (const sample of [
    { environmentId: EnvironmentId.make("recovery-host-ahead"), offset: 7_200_000, passed: true },
    {
      environmentId: EnvironmentId.make("recovery-host-behind"),
      offset: -7_200_000,
      passed: false,
    },
  ]) {
    recordServerClock(sample.environmentId, {
      serverTimeMs: clientNow + sample.offset,
      requestedAtMs: clientNow,
      receivedAtMs: clientNow,
    });
    expect(usageRecoveryState(snoozed, sample.environmentId, false, now)).toMatchObject({
      resetPassed: sample.passed,
      snoozed: !sample.passed,
    });
    expect(usageRecoveryResetDelay(sample.environmentId, resetAt, clientNow)).toBe(
      3_600_000 - sample.offset,
    );
    recordServerClock(sample.environmentId, {
      serverTimeMs: undefined,
      requestedAtMs: clientNow,
      receivedAtMs: clientNow,
    });
  }
});
