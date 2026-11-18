import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";

export interface TuiActionContext {
  readonly cwd?: string;
  readonly threadId?: ThreadId;
  readonly projectId?: ProjectId;
  readonly modelSelection?: ModelSelection;
}

type Method =
  | (typeof WS_METHODS)[keyof typeof WS_METHODS]
  | (typeof ORCHESTRATION_V2_WS_METHODS)[keyof typeof ORCHESTRATION_V2_WS_METHODS];

export interface TuiQuickAction {
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly method: Method;
  readonly context?: "workspace" | "thread";
  readonly payload: (context: TuiActionContext) => Record<string, unknown>;
}

const workspace = ({ cwd }: TuiActionContext) => ({ cwd: cwd ?? "" });
const thread = ({ threadId }: TuiActionContext) => ({ threadId: threadId ?? "" });
const command = (type: string, context: TuiActionContext, fields = {}) => ({
  type,
  commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
  ...thread(context),
  ...fields,
});

function threadAction(title: string, description: string, type: string): TuiQuickAction {
  return {
    title,
    description,
    category: "Threads",
    method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    context: "thread",
    payload: (context) => command(type, context),
  };
}

export const quickActions: ReadonlyArray<TuiQuickAction> = [
  {
    title: "Working tree diff",
    description: "Review changed files and their patches.",
    category: "Source control",
    method: WS_METHODS.reviewGetDiffPreview,
    context: "workspace",
    payload: (context) => ({ ...workspace(context), sourceKind: "working-tree" }),
  },
  {
    title: "Branch commits",
    description: "Inspect commits against a base reference.",
    category: "Source control",
    method: WS_METHODS.reviewGetBranchCommits,
    context: "workspace",
    payload: workspace,
  },
  {
    title: "Git status",
    description: "Watch local and remote repository status.",
    category: "Source control",
    method: WS_METHODS.subscribeVcsStatus,
    context: "workspace",
    payload: workspace,
  },
  {
    title: "Branches and references",
    description: "List local and remote references; use the cursor to load more.",
    category: "Source control",
    method: WS_METHODS.vcsListRefs,
    context: "workspace",
    payload: (context) => ({ ...workspace(context), refKind: "all", limit: 100 }),
  },
  {
    title: "Create branch",
    description: "Enter the new branch name; optionally switch to it.",
    category: "Source control",
    method: WS_METHODS.vcsCreateRef,
    context: "workspace",
    payload: (context) => ({ ...workspace(context), refName: "", switchRef: false }),
  },
  {
    title: "Switch branch",
    description: "Enter the destination reference.",
    category: "Source control",
    method: WS_METHODS.vcsSwitchRef,
    context: "workspace",
    payload: (context) => ({ ...workspace(context), refName: "" }),
  },
  {
    title: "Create worktree",
    description: "Choose a reference and optional path for a separate checkout.",
    category: "Source control",
    method: WS_METHODS.vcsCreateWorktree,
    context: "workspace",
    payload: (context) => ({ ...workspace(context), refName: "", path: null }),
  },
  {
    title: "Remove worktree",
    description: "Enter the checkout path to remove. Force is disabled.",
    category: "Source control",
    method: WS_METHODS.vcsRemoveWorktree,
    context: "workspace",
    payload: (context) => ({ ...workspace(context), path: "", force: false }),
  },
  {
    title: "Pull changes",
    description: "Pull the current branch from its upstream.",
    category: "Source control",
    method: WS_METHODS.vcsPull,
    context: "workspace",
    payload: workspace,
  },
  {
    title: "Commit changes",
    description: "Enter a commit message and filePaths to select what is committed.",
    category: "Source control",
    method: WS_METHODS.gitRunStackedAction,
    context: "workspace",
    payload: (context) => ({
      ...workspace(context),
      actionId: SecureRandom.uuidV4Unsafe(),
      action: "commit",
      commitMessage: "",
      filePaths: [],
    }),
  },
  {
    title: "Push branch",
    description: "Push committed changes in this workspace.",
    category: "Source control",
    method: WS_METHODS.gitRunStackedAction,
    context: "workspace",
    payload: (context) => ({
      ...workspace(context),
      actionId: SecureRandom.uuidV4Unsafe(),
      action: "push",
    }),
  },
  {
    title: "Browse workspace files",
    description: "List directory entries relative to the workspace root.",
    category: "Files",
    method: WS_METHODS.projectsListEntries,
    context: "workspace",
    payload: (context) => ({ ...workspace(context), directoryPath: "" }),
  },
  {
    title: "Find files",
    description: "Search workspace filenames.",
    category: "Files",
    method: WS_METHODS.projectsSearchEntries,
    context: "workspace",
    payload: (context) => ({ ...workspace(context), query: "", limit: 100 }),
  },
  {
    title: "Search file contents",
    description: "Search text with optional regular expressions and case matching.",
    category: "Files",
    method: WS_METHODS.projectsSearchContents,
    context: "workspace",
    payload: (context) => ({
      ...workspace(context),
      query: "",
      limit: 100,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    }),
  },
  {
    title: "Read text file",
    description: "Enter a file path on the connected environment.",
    category: "Files",
    method: WS_METHODS.projectsReadFile,
    context: "workspace",
    payload: (context) => ({ ...workspace(context), relativePath: "" }),
  },
  {
    title: "Write text file",
    description: "Enter a workspace-relative path and replacement contents.",
    category: "Files",
    method: WS_METHODS.projectsWriteFile,
    context: "workspace",
    payload: (context) => ({ ...workspace(context), relativePath: "", contents: "" }),
  },
  {
    title: "Search all threads",
    description: "Search thread titles and conversation contents (at least two characters).",
    category: "Threads",
    method: ORCHESTRATION_V2_WS_METHODS.searchThreads,
    payload: () => ({ query: "", limit: 50 }),
  },
  {
    title: "Archived threads",
    description: "Read the archived thread list.",
    category: "Threads",
    method: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
    payload: () => ({}),
  },
  {
    title: "Thread family",
    description: "Inspect forks and delegated work related to this thread.",
    category: "Threads",
    method: ORCHESTRATION_V2_WS_METHODS.getThreadFamily,
    context: "thread",
    payload: thread,
  },
  {
    title: "Fork thread",
    description: "Create a new thread from this conversation's latest stable run.",
    category: "Threads",
    method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    context: "thread",
    payload: (context) => ({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      commandId: SecureRandom.uuidV4Unsafe(),
      sourceThreadId: context.threadId ?? "",
      targetThreadId: SecureRandom.uuidV4Unsafe(),
      sourcePoint: { type: "latest_stable" },
    }),
  },
  {
    title: "Checkpoint diff",
    description: "Choose the checkpoint turn range to inspect.",
    category: "Threads",
    method: ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
    context: "thread",
    payload: (context) => ({ ...thread(context), fromTurnCount: 0, toTurnCount: 1 }),
  },
  {
    title: "Restore checkpoint",
    description: "Enter scopeId and checkpointId from the thread's checkpoint history.",
    category: "Threads",
    method: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    context: "thread",
    payload: (context) =>
      command("checkpoint.rollback", context, {
        scopeId: "",
        checkpointId: "",
        restoreFiles: true,
      }),
  },
  threadAction("Archive thread", "Move this thread to the archive.", "thread.archive"),
  threadAction(
    "Restore archived thread",
    "Return this thread from the archive.",
    "thread.unarchive",
  ),
  threadAction("Settle thread", "Mark this thread as settled.", "thread.settle"),
  {
    ...threadAction(
      "Reopen settled thread",
      "Return this thread to active work.",
      "thread.unsettle",
    ),
    payload: (context) => command("thread.unsettle", context, { reason: "user" }),
  },
  threadAction("Pin thread", "Keep this thread in the pinned list.", "thread.pin"),
  threadAction("Unpin thread", "Remove this thread from the pinned list.", "thread.unpin"),
  threadAction("Mark unread", "Mark this thread as unread.", "thread.mark-unread"),
  {
    ...threadAction("Rename thread", "Enter a new thread title.", "thread.metadata.update"),
    payload: (context) => command("thread.metadata.update", context, { title: "" }),
  },
  {
    ...threadAction(
      "Snooze thread",
      "Set the UTC time when this thread should return.",
      "thread.snooze",
    ),
    payload: (context) => command("thread.snooze", context, { snoozedUntil: "" }),
  },
  {
    ...threadAction("Unsnooze thread", "Return a snoozed thread immediately.", "thread.unsnooze"),
    payload: (context) => command("thread.unsnooze", context, { reason: "user" }),
  },
  {
    ...threadAction(
      "Permission mode",
      "Choose the runtime permission mode.",
      "thread.runtime-mode.set",
    ),
    payload: (context) =>
      command("thread.runtime-mode.set", context, { runtimeMode: "approval-required" }),
  },
  {
    ...threadAction(
      "Interaction mode",
      "Choose default or plan mode.",
      "thread.interaction-mode.set",
    ),
    payload: (context) =>
      command("thread.interaction-mode.set", context, { interactionMode: "default" }),
  },
  {
    title: "Open shell",
    description: "Create a shell on the connected environment for this thread.",
    category: "Terminal",
    method: WS_METHODS.terminalOpen,
    context: "thread",
    payload: (context) => ({
      ...workspace(context),
      ...thread(context),
      terminalId: "tui",
      cols: 100,
      rows: 30,
    }),
  },
  {
    title: "Observe shell output",
    description: "Watch output from the thread's tui shell.",
    category: "Terminal",
    method: WS_METHODS.terminalObserve,
    context: "thread",
    payload: (context) => ({ ...thread(context), terminalId: "tui" }),
  },
  {
    title: "Send shell input",
    description: "Send data to the thread's tui shell; include a newline to execute.",
    category: "Terminal",
    method: WS_METHODS.terminalWrite,
    context: "thread",
    payload: (context) => ({ ...thread(context), terminalId: "tui", data: "" }),
  },
  {
    title: "Close shell",
    description: "Stop the thread's tui shell while keeping its history.",
    category: "Terminal",
    method: WS_METHODS.terminalClose,
    context: "thread",
    payload: (context) => ({ ...thread(context), terminalId: "tui", deleteHistory: false }),
  },
  {
    title: "Scheduled tasks",
    description: "Watch scheduled tasks and their run status.",
    category: "Schedules",
    method: WS_METHODS.scheduledTasksSubscribe,
    payload: () => ({}),
  },
  {
    title: "Create scheduled task",
    description: "Enter title and prompt. Starts disabled; enable after reviewing it.",
    category: "Schedules",
    method: WS_METHODS.scheduledTasksUpsert,
    context: "thread",
    payload: (context) => ({
      title: "",
      prompt: "",
      enabled: false,
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId: context.projectId ?? "",
      threadId: context.threadId ?? null,
      workspaceStrategy: { type: "root" },
      modelSelection: context.modelSelection ?? { instanceId: "", model: "" },
      runtimeMode: "approval-required",
      interactionMode: "default",
    }),
  },
  {
    title: "Enable or disable scheduled task",
    description: "Enter the task ID and desired enabled state.",
    category: "Schedules",
    method: WS_METHODS.scheduledTasksSetEnabled,
    payload: () => ({ id: "", enabled: false }),
  },
  {
    title: "Run scheduled task now",
    description: "Enter a task ID to launch a run immediately.",
    category: "Schedules",
    method: WS_METHODS.scheduledTasksRunNow,
    payload: () => ({ id: "" }),
  },
  {
    title: "Delete scheduled task",
    description: "Enter the task ID to remove.",
    category: "Schedules",
    method: WS_METHODS.scheduledTasksDelete,
    payload: () => ({ id: "" }),
  },
  {
    title: "Server settings",
    description: "Read configuration for the connected environment.",
    category: "Settings",
    method: WS_METHODS.serverGetSettings,
    payload: () => ({}),
  },
  {
    title: "Update server settings",
    description: "Enter the settings patch to apply.",
    category: "Settings",
    method: WS_METHODS.serverUpdateSettings,
    payload: () => ({ patch: {} }),
  },
  {
    title: "Refresh providers",
    description: "Refresh installed providers and their availability.",
    category: "Providers",
    method: WS_METHODS.serverRefreshProviders,
    payload: () => ({}),
  },
  {
    title: "Linked environments",
    description: "Read connections to peer environments.",
    category: "Connections",
    method: WS_METHODS.peerLinksList,
    payload: () => ({}),
  },
  {
    title: "Host resources",
    description: "Read CPU, memory and host resource usage.",
    category: "Diagnostics",
    method: WS_METHODS.serverGetHostResources,
    payload: () => ({}),
  },
  {
    title: "Usage summary",
    description: "Enter the first and last day (YYYY-MM-DD) to inspect provider usage.",
    category: "Usage",
    method: WS_METHODS.serverGetUsageSummary,
    payload: () => ({ sinceDay: "", untilDay: "", timeZone: "Europe/Berlin" }),
  },
  {
    title: "Storage report",
    description: "Inspect database and attachment storage.",
    category: "Diagnostics",
    method: WS_METHODS.serverGetDatabaseStorage,
    payload: () => ({}),
  },
];

export function serviceCategory(method: string): string {
  if (method.startsWith("orchestration.")) return "Threads";
  if (/^(vcs\.|git\.|review\.|subscribeVcs|subscribeWorktree|worktreeSetup\.)/.test(method))
    return "Source control";
  if (/^(projects\.|filesystem\.|assets\.|attachments\.)/.test(method)) return "Files";
  if (method.startsWith("terminal.") || method === "subscribeTerminalMetadata") return "Terminal";
  if (method.startsWith("scheduledTasks.")) return "Schedules";
  if (method.startsWith("server.") && method.toLowerCase().includes("usage")) return "Usage";
  if (method.startsWith("pullRequests.")) return "Pull requests";
  if (method.startsWith("issues.")) return "Issues";
  if (/^(provider\.|server\..*AcpRegistry)/.test(method)) return "Providers";
  if (/^(peerLinks\.|cloud\.)/.test(method)) return "Connections";
  if (method.startsWith("mcpApps.")) return "MCP apps";
  if (/^(preview\.|device\.|subscribePreview|subscribeDevice)/.test(method))
    return "Browser and devices";
  return "Settings and services";
}
