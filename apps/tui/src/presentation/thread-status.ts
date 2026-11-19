import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  hasUnseenCompletion,
  hasUnseenRunFailure,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import { icon } from "./icons.ts";
import { theme } from "../theme/index.ts";

export function threadStatus(thread: EnvironmentThreadShell | null, now: string) {
  if (!thread) return "ready";
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") return "approval";
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") return "input";
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return "request";
  const runtime = thread.runtime;
  const wokeAt = threadWokeAt(thread, { now });
  const visitedAt = thread.lastVisitedAt ? Date.parse(thread.lastVisitedAt) : NaN;
  const woken =
    thread.settledOverride !== "settled" &&
    wokeAt !== null &&
    (!Number.isFinite(visitedAt) || visitedAt < Date.parse(wokeAt));
  if (runtime?.status === "running" && thread.blockedOnThreadWait) return "waiting";
  switch (runtime?.status) {
    case "queued":
    case "preparing":
    case "starting":
    case "running":
    case "waiting":
      return "working";
    case "idle":
      return "waiting";
    case "failed":
      if (runtime.lastErrorClass === "usage_limit") return "limited";
      if (thread.latestRun?.status !== "failed" || hasUnseenRunFailure(thread)) return "failed";
      break;
  }
  return woken ? "woken" : hasUnseenCompletion(thread) ? "done" : "ready";
}

export function threadStatusPresentation(
  status: ReturnType<typeof threadStatus>,
  selected = false,
) {
  switch (status) {
    case "working":
      return { color: theme.statusWorking, symbol: icon("running") };
    case "approval":
      return { color: theme.statusApproval, symbol: icon("approval") };
    case "input":
      return { color: theme.statusInput, symbol: icon("input") };
    case "request":
      return { color: theme.statusRequest, symbol: icon("request") };
    case "waiting":
      return { color: theme.textMuted, symbol: icon("waiting") };
    case "limited":
      return { color: theme.statusApproval, symbol: icon("limited") };
    case "failed":
      return { color: theme.statusFailed, symbol: icon("error") };
    case "done":
      return { color: theme.statusDone, symbol: icon("success") };
    case "woken":
      return { color: theme.statusWoken, symbol: icon("woken") };
    case "ready":
      return { color: selected ? theme.text : theme.textMuted, symbol: "" };
  }
}
