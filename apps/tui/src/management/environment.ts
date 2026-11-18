import {
  WS_METHODS,
  type ClientServerSettingsPatch,
  type ModelSelection,
} from "@t3tools/contracts";
import {
  globalIdleCompaction,
  IDLE_COMPACTION_MODES,
  idleCompactionPatch,
} from "@t3tools/contracts/settings";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { destinationGuard } from "./common.tsx";
import { textGeneratorActions } from "./text-generators.ts";

export function environmentSettingsActions(props: FeatureProps): Choice[] {
  const guard = destinationGuard(props);
  const value = props.state()?.config?.settings;
  if (!value) return [];
  const options = (values: readonly string[]) => values.map((value) => ({ label: value, value }));
  async function save(patch: typeof ClientServerSettingsPatch.Type) {
    guard();
    await request(props.client, WS_METHODS.serverUpdateSettings, { patch });
    props.ui.notify("Environment settings saved.");
  }
  function chooseModel(
    title: string,
    current: ModelSelection | null,
    update: (selection: ModelSelection | null) => Promise<void>,
    allowDefault = true,
  ) {
    props.ui.choose(title, [
      ...(allowDefault
        ? [
            {
              title: "Use text-generation default",
              run: () => void props.ui.run(() => update(null)),
            },
          ]
        : []),
      ...(props.state()?.config?.providers ?? [])
        .filter((provider) => provider.enabled && provider.installed)
        .flatMap((provider) =>
          provider.models.map((model) => ({
            title: `${current?.instanceId === provider.instanceId && current.model === model.slug ? "✓ " : ""}${model.name}`,
            category: provider.displayName ?? provider.driver,
            run: () =>
              void props.ui.run(() =>
                update({ instanceId: provider.instanceId, model: model.slug }),
              ),
          })),
        ),
    ]);
  }
  return [
    {
      title: "Text-generation APIs",
      description: "OpenAI-compatible and Anthropic endpoints for generated text.",
      run: () => textGeneratorActions(props),
    },
    {
      title: "Thread and agent defaults",
      description: "Workspace, streaming, agent browser access and settling.",
      run: () =>
        props.ui.form({
          title: "Thread and agent defaults",
          fields: [
            {
              name: "workspace",
              label: "New thread workspace",
              type: "select",
              value: value.defaultThreadEnvMode ?? "inherit",
              options: [
                { label: "Follow t3.json", value: "inherit" },
                { label: "Current checkout", value: "local" },
                { label: "New worktree", value: "worktree" },
              ],
            },
            {
              name: "streaming",
              label: "Responses",
              type: "select",
              value: value.responseStreamingMode,
              options: [
                { label: "Completed paragraphs", value: "paragraph" },
                { label: "After the turn", value: "turn" },
              ],
            },
            {
              name: "browser",
              label: "Agent browser access",
              type: "toggle",
              value: String(value.enableAgentBrowserAccess),
            },
            {
              name: "settleMerged",
              label: "Settle threads after merge",
              type: "toggle",
              value: String(value.sidebarAutoSettleOnMerge),
            },
            {
              name: "keepPrs",
              label: "Keep threads with open pull requests active",
              type: "toggle",
              value: String(value.sidebarAutoSettleKeepPullRequests),
            },
            {
              name: "continue",
              label: "Continue threads after server updates",
              type: "toggle",
              value: String(value.continueThreadsAfterServerUpdate),
            },
          ],
          onSubmit: async (fields) =>
            save({
              defaultThreadEnvMode:
                fields.workspace === "inherit"
                  ? null
                  : fields.workspace === "worktree"
                    ? "worktree"
                    : "local",
              responseStreamingMode: fields.streaming === "turn" ? "turn" : "paragraph",
              enableAgentBrowserAccess: fields.browser === "true",
              sidebarAutoSettleOnMerge: fields.settleMerged === "true",
              sidebarAutoSettleKeepPullRequests: fields.keepPrs === "true",
              continueThreadsAfterServerUpdate: fields.continue === "true",
            }),
        }),
    },
    {
      title: "Idle context compaction",
      description: `Current: ${globalIdleCompaction(value)}`,
      run: () =>
        props.ui.choose(
          "Compact idle context",
          IDLE_COMPACTION_MODES.map((mode) => ({
            title: mode.label,
            run: () => void props.ui.run(() => save(idleCompactionPatch(value, mode.value))),
          })),
        ),
    },
    {
      title: "Worktree and project defaults",
      description: "Checkout location, base refs, submodules and clone layout.",
      run: () =>
        props.ui.form({
          title: "Worktree and project defaults",
          fields: [
            {
              name: "directory",
              label: "Worktrees directory (blank uses default)",
              value: value.worktreesDirectory,
            },
            {
              name: "projects",
              label: "Add-project base directory",
              value: value.addProjectBaseDirectory,
            },
            {
              name: "origin",
              label: "Start new worktrees from remote branch",
              type: "toggle",
              value: String(value.newWorktreesStartFromOrigin),
            },
            {
              name: "submodules",
              label: "Initialize submodules",
              type: "select",
              value: value.worktreeSubmodules ?? "inherit",
              options: [
                { label: "Follow t3.json", value: "inherit" },
                { label: "Recursively", value: "recursive" },
                { label: "Top level only", value: "top-level" },
                { label: "Skip", value: "none" },
              ],
            },
            {
              name: "clone",
              label: "Group clones by host and owner",
              type: "toggle",
              value: String(value.ghqCloneLayout),
            },
            {
              name: "fast",
              label: "Fast worktree checkout (supported hosts)",
              type: "toggle",
              value: String(value.fastWorktreeCheckout),
            },
          ],
          onSubmit: async (fields) =>
            save({
              worktreesDirectory: fields.directory?.trim() ?? "",
              addProjectBaseDirectory: fields.projects?.trim() ?? "",
              newWorktreesStartFromOrigin: fields.origin === "true",
              worktreeSubmodules:
                fields.submodules === "inherit"
                  ? null
                  : fields.submodules === "none"
                    ? "none"
                    : fields.submodules === "top-level"
                      ? "top-level"
                      : "recursive",
              ghqCloneLayout: fields.clone === "true",
              fastWorktreeCheckout: fields.fast === "true",
            }),
        }),
    },
    {
      title: "Source-control defaults and writing",
      description: "Branch names, commit and PR writing, merge behavior.",
      run: () =>
        props.ui.form({
          title: "Source-control defaults and writing",
          fields: [
            {
              name: "autoPull",
              label: "Pull automatically before a turn",
              type: "toggle",
              value: String(value.defaultAutoPull),
            },
            {
              name: "branchMode",
              label: "Branch naming",
              type: "select",
              value: value.branchNamingMode,
              options: options(["static", "semantic", "custom"]),
            },
            { name: "prefix", label: "Branch prefix", value: value.branchNamePrefix },
            {
              name: "branchInstructions",
              label: "Branch naming instructions",
              type: "multiline",
              value: value.branchNameInstructions,
            },
            {
              name: "writingMode",
              label: "Commit and PR style",
              type: "select",
              value: value.sourceControlWritingStyle.mode,
              options: options(["repo_conventions", "conventional_commits", "custom"]),
            },
            {
              name: "writingInstructions",
              label: "Writing instructions",
              type: "multiline",
              value: value.sourceControlWritingStyle.customInstructions,
            },
            {
              name: "templates",
              label: "Follow change-request templates",
              type: "toggle",
              value: String(value.sourceControlWritingStyle.followChangeRequestTemplates),
            },
            {
              name: "credits",
              label: "Remove agent credits on merge",
              type: "toggle",
              value: String(value.removeAgentCreditsOnMerge),
            },
            {
              name: "merge",
              label: "Preferred merge method",
              type: "select",
              value: value.pullRequestMergeMethod ?? "host-default",
              options: options(["host-default", "merge", "squash", "rebase"]),
            },
          ],
          onSubmit: async (fields) =>
            save({
              defaultAutoPull: fields.autoPull === "true",
              branchNamingMode:
                fields.branchMode === "semantic" || fields.branchMode === "custom"
                  ? fields.branchMode
                  : "static",
              branchNamePrefix: fields.prefix?.trim() ?? "",
              branchNameInstructions: fields.branchInstructions?.trim() ?? "",
              sourceControlWritingStyle: {
                mode:
                  fields.writingMode === "custom" || fields.writingMode === "conventional_commits"
                    ? fields.writingMode
                    : "repo_conventions",
                customInstructions: fields.writingInstructions?.trim() ?? "",
                followChangeRequestTemplates: fields.templates === "true",
              },
              removeAgentCreditsOnMerge: fields.credits === "true",
              pullRequestMergeMethod:
                fields.merge === "squash" || fields.merge === "rebase" || fields.merge === "merge"
                  ? fields.merge
                  : null,
            }),
        }),
    },
    {
      title: "Generation models and instructions",
      description: "Titles, branch names, source-control writing and review guides.",
      run: () =>
        props.ui.choose("Generated text", [
          {
            title: "Default text-generation model",
            run: () =>
              chooseModel(
                "Default text-generation model",
                value.textGenerationModelSelection,
                (selection) =>
                  selection ? save({ textGenerationModelSelection: selection }) : Promise.resolve(),
                false,
              ),
          },
          {
            title: "Source-control writing model",
            run: () =>
              chooseModel(
                "Source-control writing model",
                value.sourceControlWriterModelSelection,
                (selection) => save({ sourceControlWriterModelSelection: selection }),
              ),
          },
          {
            title: "Review-guide model",
            run: () =>
              chooseModel("Review-guide model", value.reviewGuideModelSelection, (selection) =>
                save({ reviewGuideModelSelection: selection }),
              ),
          },
          {
            title: "Generation instructions",
            run: () =>
              props.ui.form({
                title: "Generation instructions",
                fields: [
                  {
                    name: "titles",
                    label: "Thread-title instructions",
                    type: "multiline",
                    value: value.threadTitleInstructions,
                  },
                  {
                    name: "reviews",
                    label: "Review-guide instructions",
                    type: "multiline",
                    value: value.reviewGuideInstructions,
                  },
                ],
                onSubmit: async (fields) =>
                  save({
                    threadTitleInstructions: fields.titles?.trim() ?? "",
                    reviewGuideInstructions: fields.reviews?.trim() ?? "",
                  }),
              }),
          },
        ]),
    },
    {
      title: "Host background activity",
      description: "Performance profile, keep-awake and provider update checks.",
      run: () =>
        props.ui.form({
          title: "Host background activity",
          fields: [
            {
              name: "profile",
              label: "Activity profile",
              type: "select",
              value: value.backgroundActivity.profile,
              options: options(["balanced", "performance", "battery-saver", "custom"]),
            },
            {
              name: "awake",
              label: "Keep host awake while agents work",
              type: "toggle",
              value: String(value.keepAwakeWhileAgentsWork),
            },
            {
              name: "updates",
              label: "Check provider updates",
              type: "toggle",
              value: String(value.enableProviderUpdateChecks),
            },
            {
              name: "approval",
              label: "Require approval for new T3 Connect devices",
              type: "toggle",
              value: String(value.requireConnectDeviceApproval),
            },
          ],
          onSubmit: async (fields) =>
            save({
              backgroundActivity: {
                ...value.backgroundActivity,
                profile:
                  fields.profile === "performance" ||
                  fields.profile === "battery-saver" ||
                  fields.profile === "custom"
                    ? fields.profile
                    : "balanced",
              },
              keepAwakeWhileAgentsWork: fields.awake === "true",
              enableProviderUpdateChecks: fields.updates === "true",
              requireConnectDeviceApproval: fields.approval === "true",
            }),
        }),
    },
    {
      title: "OTLP destinations",
      description: "Trace, metric and log collector URLs.",
      run: () =>
        props.ui.form({
          title: "OTLP destinations",
          fields: [
            { name: "traces", label: "Traces URL", value: value.observability.otlpTracesUrl },
            { name: "metrics", label: "Metrics URL", value: value.observability.otlpMetricsUrl },
            { name: "logs", label: "Logs URL", value: value.observability.otlpLogsUrl },
          ],
          onSubmit: async (fields) =>
            save({
              observability: {
                otlpTracesUrl: fields.traces?.trim() ?? "",
                otlpMetricsUrl: fields.metrics?.trim() ?? "",
                otlpLogsUrl: fields.logs?.trim() ?? "",
              },
            }),
        }),
    },
  ];
}
