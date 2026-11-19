import type {
  OrchestrationV2ThreadShell,
  OrchestrationV2ProviderFailureClass,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { limitRecoveryOwnsSnooze } from "@t3tools/client-runtime/state/thread-execution";
import { toServerClock } from "@t3tools/client-runtime/clock";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";

export function threadErrorBanner(
  environmentId: string | null | undefined,
  threadId: string,
  error: string | null | undefined,
  errorClass?: OrchestrationV2ProviderFailureClass | null,
  errorCode?: string | null,
) {
  if (!environmentId || !error) return null;
  let message = error;
  try {
    const parsed: unknown = JSON.parse(error);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      "message" in parsed.error &&
      typeof parsed.error.message === "string" &&
      parsed.error.message.trim()
    )
      message = parsed.error.message;
  } catch {
    // Provider errors may be plain text rather than a JSON error envelope.
  }
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  return {
    key: `${environmentId}\0${threadId}\0${error}`,
    title: chatGptLimit
      ? "ChatGPT usage limit reached"
      : errorClass === "usage_limit"
        ? "Usage limit reached"
        : "Agent error",
    message: workspaceLimit
      ? "You've reached your workspace's limit for using your ChatGPT plan in other apps. Copy a request to ask your workspace admin for increased usage limits."
      : message,
    tone: errorClass === "usage_limit" || chatGptLimit ? ("warning" as const) : ("error" as const),
    workspaceLimit,
    chatGptLimit,
  };
}

export function usageRecoveryResetDelay(
  environmentId: Parameters<typeof presentThreadShell>[0],
  resetAt: string,
  clientNow: number,
) {
  return Date.parse(resetAt) - toServerClock(environmentId, clientNow);
}

export function usageRecoveryState(
  shell: OrchestrationV2ThreadShell | null | undefined,
  environmentId: Parameters<typeof presentThreadShell>[0],
  requestPending: boolean,
  now: string,
) {
  if (!shell) return null;
  const presented = presentThreadShell(environmentId, shell);
  const runtime = presented.runtime;
  const run = presented.latestRun;
  if (runtime?.status !== "failed" || runtime.lastErrorClass !== "usage_limit" || !run) return null;
  const resetAt = runtime.usageLimitResetAt ?? null;
  const stoppedAt = run.completedAt ?? presented.updatedAt;
  const canSchedule =
    shell.settledOverride !== "settled" &&
    !requestPending &&
    resetAt !== null &&
    Date.parse(resetAt) > Date.parse(stoppedAt);
  const scheduled =
    canSchedule &&
    shell.limitRecovery?.runId === run.runId &&
    shell.limitRecovery.resetAt === resetAt &&
    shell.limitRecovery.autoResume;
  const resetPassed =
    resetAt !== null && usageRecoveryResetDelay(environmentId, resetAt, Date.parse(now)) <= 0;
  const snoozed =
    !resetPassed &&
    limitRecoveryOwnsSnooze({
      runId: run.runId,
      resetAt,
      recovery: shell.limitRecovery,
      snoozedUntil: presented.snoozedUntil,
    });
  const displayAt =
    scheduled &&
    resetAt &&
    presented.snoozedUntil &&
    Date.parse(presented.snoozedUntil) > Date.parse(resetAt)
      ? presented.snoozedUntil
      : resetAt;
  return {
    runId: run.runId,
    resetAt,
    canSchedule,
    scheduled,
    resetPassed,
    snoozed,
    description: displayAt
      ? `${scheduled ? "Resumes" : "Resets"}: ${displayAt}`
      : "Reset time unavailable; retry manually.",
  };
}
