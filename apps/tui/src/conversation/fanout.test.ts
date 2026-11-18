import { expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createFanoutTargets, startFanoutTargets } from "./fanout.ts";

it("retries only failed model launches with their original identities after a partial or uncertain submission", async () => {
  const targets = createFanoutTargets([
    { instanceId: ProviderInstanceId.make("codex"), model: "first" },
    { instanceId: ProviderInstanceId.make("codex"), model: "second" },
  ]);
  const submitted: Array<{ model: string; thread: string; command: string; message: string }> = [];
  let failSecond = true;
  const launch = async (target: (typeof targets)[number]) => {
    submitted.push({
      model: target.selection.model,
      thread: target.threadId,
      command: target.commandId,
      message: target.messageId,
    });
    if (target.selection.model === "second" && failSecond)
      throw new Error("Connection lost after submission");
    return target.threadId;
  };
  await startFanoutTargets(targets, launch, () => {});
  expect(targets.map((target) => target.status)).toEqual(["started", "failed"]);
  expect(targets[1]?.error).toBe("Connection lost after submission");
  failSecond = false;
  await startFanoutTargets(targets, launch, () => {});
  expect(targets.map((target) => target.status)).toEqual(["started", "started"]);
  expect(submitted).toHaveLength(3);
  expect(submitted[2]).toEqual(submitted[1]);
  expect(targets[1]?.error).toBeUndefined();
});
