import type { TerminalSummary } from "@t3tools/contracts";
import { createMemo, type Accessor } from "solid-js";
import type { TuiSnapshot } from "../runtime/client.ts";

export function createTerminalActivity(state: Accessor<TuiSnapshot | null>) {
  const metadata = createMemo(() => state()?.terminalMetadata);
  const connection = createMemo(() => state()?.connection);
  return createMemo(() => {
    const value = metadata();
    return runningTerminalsByThread(
      connection() === "connected" && !value?.error && !value?.loading
        ? (value?.terminals ?? [])
        : [],
    );
  });
}

function runningTerminalsByThread(terminals: readonly TerminalSummary[]) {
  const counts = new Map<string, number>();
  for (const terminal of terminals) {
    if (terminal.hasRunningSubprocess)
      counts.set(terminal.threadId, (counts.get(terminal.threadId) ?? 0) + 1);
  }
  return counts;
}

export function terminalActivityLabel(count: number) {
  return count > 1 ? `●${count > 99 ? "99+" : count}` : "●";
}
