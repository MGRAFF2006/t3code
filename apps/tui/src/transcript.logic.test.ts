import { describe, expect, it } from "vite-plus/test";
import {
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import {
  v2Now,
  v2ThreadId,
} from "../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { groupTranscriptItems, summarizeTranscriptWork } from "./transcript.logic.ts";

function call(id: string) {
  return {
    sourceThreadId: v2ThreadId,
    sourceItemId: TurnItemId.make(id),
    position: 0,
    visibility: "local",
    item: {
      id: TurnItemId.make(id),
      threadId: v2ThreadId,
      runId: RunId.make("run"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: "Read file",
      startedAt: null,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "dynamic_tool",
      toolName: "read_file",
      input: {},
      output: null,
    },
  } satisfies OrchestrationV2ProjectedTurnItem;
}

describe("terminal work groups", () => {
  it("groups adjacent calls while keeping messages and actionable requests outside", () => {
    const first = call("first");
    const second = call("second");
    const separator = {
      ...call("separator"),
      item: {
        ...call("separator").item,
        type: "system_notice" as const,
        message: "Approval needed",
      },
    };
    const rows = groupTranscriptItems([first, second, separator, call("third")]);
    expect(rows.map((row) => row.entries.map((entry) => entry.sourceItemId))).toEqual([
      ["first", "second"],
      ["separator"],
      ["third"],
    ]);
    expect(groupTranscriptItems([first, second, call("streamed")])[0]?.key).toBe(rows[0]?.key);
  });

  it.each(["sourceThreadId", "visibility", "runId", "parentItemId"] as const)(
    "does not merge calls across %s boundaries",
    (field) => {
      const first = call("first");
      const second = call("second");
      const changed =
        field === "sourceThreadId"
          ? { ...second, sourceThreadId: ThreadId.make("other-thread") }
          : field === "visibility"
            ? { ...second, visibility: "inherited" as const }
            : {
                ...second,
                item: {
                  ...second.item,
                  ...(field === "runId"
                    ? { runId: RunId.make("other-run") }
                    : { parentItemId: TurnItemId.make("parent") }),
                },
              };
      expect(groupTranscriptItems([first, changed])).toHaveLength(2);
    },
  );

  it("keeps running and failed work visible in summaries and counts deferred work once", () => {
    const first = call("first");
    const failed = {
      ...call("failed"),
      item: { ...call("failed").item, status: "failed" as const },
    };
    const running = {
      ...call("running"),
      item: { ...call("running").item, status: "running" as const },
    };
    expect(summarizeTranscriptWork([first, failed, running])).toMatchObject({
      active: 1,
      hasFailure: true,
    });
    const deferred = {
      ...first,
      item: { ...first.item, deferredWork: { cursor: "work", itemCount: 50, lastOrdinal: 49 } },
    };
    expect(summarizeTranscriptWork([deferred, failed]).label).toBe("Work · 50 items");
  });
});
