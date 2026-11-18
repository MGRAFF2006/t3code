import { CommandId, MessageId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";

export interface FanoutTarget {
  readonly selection: ModelSelection;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  status: "pending" | "started" | "failed";
  error?: string;
}

export function createFanoutTargets(selections: ReadonlyArray<ModelSelection>): FanoutTarget[] {
  return selections.map((selection) => ({
    selection,
    threadId: ThreadId.make(SecureRandom.uuidV4Unsafe()),
    commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
    messageId: MessageId.make(SecureRandom.uuidV4Unsafe()),
    status: "pending",
  }));
}

export async function startFanoutTargets(
  targets: ReadonlyArray<FanoutTarget>,
  launch: (target: FanoutTarget) => Promise<string>,
  onProgress: () => void,
) {
  await Promise.all(
    targets
      .filter((target) => target.status !== "started")
      .map(async (target) => {
        target.status = "pending";
        delete target.error;
        onProgress();
        try {
          await launch(target);
          target.status = "started";
        } catch (error) {
          target.status = "failed";
          target.error = error instanceof Error ? error.message : String(error);
        }
        onProgress();
      }),
  );
}
