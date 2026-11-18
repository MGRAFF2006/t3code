import type {
  ProjectReadFileResult,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import type { TuiSnapshot } from "../runtime/client.ts";

export function workspaceRoot(state: TuiSnapshot | null) {
  const thread = state?.thread?.thread;
  const projectId =
    thread?.projectId ??
    state?.shell?.threads.find((entry) => entry.id === state.selectedThreadId)?.projectId;
  return (
    thread?.worktreePath ??
    state?.shell?.projects.find((entry) => entry.id === projectId)?.workspaceRoot ??
    state?.config?.cwd
  );
}

export interface WorkspaceStatus {
  local: VcsStatusLocalResult | null;
  remote: VcsStatusRemoteResult | null;
}

export function reduceStatus(
  previous: WorkspaceStatus,
  event: VcsStatusStreamEvent,
): WorkspaceStatus {
  switch (event._tag) {
    case "snapshot":
      return { local: event.local, remote: event.remote };
    case "localUpdated":
      return { ...previous, local: event.local };
    case "remoteUpdated":
      return { ...previous, remote: event.remote };
  }
}

export function fileSaveProblem(original: ProjectReadFileResult, latest: ProjectReadFileResult) {
  if (original.truncated || latest.truncated) {
    return "This file exceeds the server's text limit and cannot be safely saved here.";
  }
  if (
    original.relativePath.startsWith("/") ||
    original.relativePath.startsWith("\\") ||
    /^~[/\\]/.test(original.relativePath) ||
    /^[a-z]:[/\\]/i.test(original.relativePath) ||
    original.relativePath.replaceAll("\\", "/").split("/").includes("..")
  ) {
    return "Files outside the workspace are read-only.";
  }
  if (original.contents !== latest.contents) {
    return "The file changed on disk. Keep your draft open and reload the file before saving.";
  }
  return undefined;
}

export function workspaceFilePath(root: string, cwd: string, path: string) {
  const absolute = `${root.replaceAll("\\", "/").replace(/\/$/, "")}/${path}`;
  const prefix = `${cwd.replaceAll("\\", "/").replace(/\/$/, "")}/`;
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute;
}

export function basename(path: string) {
  return path.replaceAll("\\", "/").replace(/\/$/, "").split("/").at(-1) ?? path;
}
