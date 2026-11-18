import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { removeUnusedWorktree } from "./worktrees.ts";
import { describe, expect, it } from "@effect/vitest";
import type {
  ProjectReadFileResult,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
} from "@t3tools/contracts";
import { fileSaveProblem, reduceStatus, workspaceFilePath } from "./logic.ts";

describe("workspace editing", () => {
  const original: ProjectReadFileResult = {
    relativePath: "src/index.ts",
    contents: "original\n",
    byteLength: 9,
    truncated: false,
  };

  it("refuses incomplete previews, external changes and paths outside the workspace", () => {
    expect(fileSaveProblem(original, original)).toBeUndefined();
    expect(fileSaveProblem(original, { ...original, contents: "changed by an agent\n" })).toContain(
      "changed on disk",
    );
    expect(fileSaveProblem({ ...original, truncated: true }, original)).toContain("text limit");
    expect(fileSaveProblem(original, { ...original, truncated: true })).toContain("text limit");
    for (const relativePath of [
      "/etc/hosts",
      "C:\\Windows\\system.ini",
      "\\\\host\\share\\file",
      "../other-project/file",
      "~/report.md",
    ]) {
      expect(
        fileSaveProblem({ ...original, relativePath }, { ...original, relativePath }),
      ).toContain("read-only");
    }
  });

  it("opens repository-relative diff paths relative to a nested workspace when possible", () => {
    expect(workspaceFilePath("/repo", "/repo/apps/web", "apps/web/src/app.ts")).toBe("src/app.ts");
    expect(workspaceFilePath("/repo", "/repo/apps/web", "packages/contracts/index.ts")).toBe(
      "/repo/packages/contracts/index.ts",
    );
    expect(workspaceFilePath("C:\\repo", "C:\\repo\\apps\\web", "apps/web/src/app.ts")).toBe(
      "src/app.ts",
    );
    expect(workspaceFilePath("/repo", "/repo/apps/web", "apps/website/app.ts")).toBe(
      "/repo/apps/website/app.ts",
    );
  });
});

describe("workspace status", () => {
  it("merges independent status updates and clears disconnected remote data", () => {
    const local: VcsStatusLocalResult = {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    };
    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 1,
      behindCount: 0,
      pr: null,
    };
    const snapshot = reduceStatus(
      { local: null, remote: null },
      { _tag: "snapshot", local, remote },
    );
    const changed = reduceStatus(snapshot, {
      _tag: "localUpdated",
      local: { ...local, refName: "other" },
    });
    expect(changed.local?.refName).toBe("other");
    expect(changed.remote).toBe(remote);
    const disconnected = reduceStatus(changed, { _tag: "remoteUpdated", remote: null });
    expect(disconnected).toEqual({ local: changed.local, remote: null });
  });
});

it("keeps worktrees referenced by archived or omitted threads using authoritative IDs", async () => {
  let referenced = true;
  let removed = false;
  const client = {
    invoke: async (method: string, _input: unknown) => {
      if (method === ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds)
        return { threadIds: referenced ? ["omitted-thread"] : [] };
      if (method === WS_METHODS.vcsRemoveWorktree) removed = true;
      return undefined;
    },
  };
  await expect(removeUnusedWorktree(client, "/repo", "/worktree", () => {})).rejects.toThrow(
    "referenced",
  );
  expect(removed).toBe(false);
  referenced = false;
  await removeUnusedWorktree(client, "/repo", "/worktree", () => {});
  expect(removed).toBe(true);
});
