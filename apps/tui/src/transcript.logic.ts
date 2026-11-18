import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import {
  summarizeToolGroup,
  type WorkLogPresentationEntry,
} from "@t3tools/client-runtime/work-log/presentation";

export interface TranscriptRow {
  readonly key: string;
  readonly entries: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
}

export function transcriptItemKey(entry: OrchestrationV2ProjectedTurnItem) {
  return `${entry.sourceThreadId}/${entry.sourceItemId}`;
}

export function transcriptEntryMatches(
  entry: OrchestrationV2ProjectedTurnItem,
  id: string | undefined,
) {
  if (!id) return false;
  const item = entry.item;
  return (
    entry.sourceItemId === id ||
    item.id === id ||
    ((item.type === "user_message" || item.type === "assistant_message") && item.messageId === id)
  );
}

function isWork(entry: OrchestrationV2ProjectedTurnItem) {
  switch (entry.item.type) {
    case "command_execution":
    case "file_change":
    case "dynamic_tool":
    case "file_search":
    case "web_search":
    case "reasoning":
    case "subagent":
      return true;
    default:
      return false;
  }
}

export function groupTranscriptItems(entries: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  const rows: Array<{ key: string; entries: OrchestrationV2ProjectedTurnItem[] }> = [];
  for (const entry of entries) {
    const previous = rows.at(-1);
    const anchor = previous?.entries[0];
    if (
      anchor &&
      isWork(anchor) &&
      isWork(entry) &&
      anchor.sourceThreadId === entry.sourceThreadId &&
      anchor.visibility === entry.visibility &&
      anchor.item.runId === entry.item.runId &&
      anchor.item.providerThreadId === entry.item.providerThreadId &&
      anchor.item.providerTurnId === entry.item.providerTurnId &&
      anchor.item.parentItemId === entry.item.parentItemId
    )
      previous.entries.push(entry);
    else rows.push({ key: transcriptItemKey(entry), entries: [entry] });
  }
  return rows;
}

export function summarizeTranscriptWork(entries: TranscriptRow["entries"]) {
  const work: WorkLogPresentationEntry[] = entries.map(({ item }) => ({
    id: item.id,
    createdAt: "",
    label: item.title ?? (item.type === "dynamic_tool" ? (item.toolName ?? "Tool") : item.type),
    itemType: item.type,
    tone: item.type === "reasoning" ? "thinking" : "tool",
    structuredPayload: item,
    toolLifecycleStatus: isOrchestrationV2WorkActive(item.status)
      ? "inProgress"
      : item.status === "failed"
        ? "failed"
        : item.status === "completed"
          ? "completed"
          : "stopped",
  }));
  const { summary, hasFailure } = summarizeToolGroup(work);
  const active = entries.filter(({ item }) => isOrchestrationV2WorkActive(item.status)).length;
  const tools = entries.filter(({ item }) => item.type !== "reasoning").length;
  const deferred = entries.flatMap(({ item }) => (item.deferredWork ? [item.deferredWork] : []));
  const count = Math.max(entries.length, ...deferred.map((value) => value.itemCount));
  return {
    label: deferred.length
      ? `Work · ${count} items`
      : tools
        ? `${tools} tool call${tools === 1 ? "" : "s"} · ${summary}`
        : summary,
    active,
    hasFailure,
  };
}
