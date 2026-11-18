import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import type { TuiClient } from "../runtime/client.ts";
import { request } from "../rpc/request.ts";

type Client = Pick<TuiClient, "invoke">;
export async function worktreeInUse(client: Client, path: string) {
  const result = await request(client, ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds, {
    worktreePath: path,
  });
  return result.threadIds.length > 0;
}
export async function removeUnusedWorktree(
  client: Client,
  cwd: string,
  path: string,
  assertCurrent: () => void,
) {
  assertCurrent();
  if (await worktreeInUse(client, path))
    throw new Error("This worktree is still referenced by a thread and cannot be removed.");
  assertCurrent();
  await request(client, WS_METHODS.vcsRemoveWorktree, { cwd, path, force: false });
}
