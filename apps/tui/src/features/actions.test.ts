import { ProjectId, ThreadId, WsRpcGroup } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { quickActions } from "./actions.ts";

const decoders = new Map<string, (input: unknown) => unknown>();
for (const [method, rpc] of WsRpcGroup.requests) {
  decoders.set(method, Schema.decodeUnknownSync(rpc.payloadSchema));
}

describe("terminal quick actions", () => {
  it("seeds runnable read operations and lifecycle commands accepted by the server contracts", () => {
    const readyActions = new Set([
      "Working tree diff",
      "Branch commits",
      "Git status",
      "Branches and references",
      "Browse workspace files",
      "Archived threads",
      "Thread family",
      "Fork thread",
      "Checkpoint diff",
      "Archive thread",
      "Restore archived thread",
      "Settle thread",
      "Reopen settled thread",
      "Pin thread",
      "Unpin thread",
      "Mark unread",
      "Unsnooze thread",
      "Permission mode",
      "Interaction mode",
      "Open shell",
      "Observe shell output",
      "Close shell",
      "Scheduled tasks",
      "Server settings",
      "Refresh providers",
      "Linked environments",
      "Host resources",
      "Storage report",
    ]);
    for (const action of quickActions.filter((entry) => readyActions.has(entry.title))) {
      const decode = decoders.get(action.method);
      expect(decode, action.title).toBeDefined();
      if (decode === undefined) throw new Error(`Unknown action: ${action.title}`);
      const payload = action.payload({
        cwd: "/remote/project",
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
      });
      expect(() => decode(payload), action.title).not.toThrow();
    }
  });
});
