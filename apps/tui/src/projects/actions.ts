import {
  CommandId,
  ProjectId,
  ProjectScriptIcon,
  WS_METHODS,
  resolveProjectProviderInstanceEnabled,
  type ProjectScript,
  type ProjectSettingsOverrides,
  type ProjectScopedServerSettingKey,
  type ProjectUpdatePayload,
  type T3ProjectFile,
} from "@t3tools/contracts";
import {
  clearProjectSettingsOverrides,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import {
  resolveProjectScripts,
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
} from "@t3tools/shared/projectScripts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { request } from "../rpc/request.ts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { importFileScripts, readScript, replaceScript } from "./scripts.ts";
import { conversationSearch } from "./search.ts";
import { cloneProject, projectCloneStatus } from "./new-project.ts";

export function projectActions(props: FeatureProps, projectId: string) {
  const destination = props.state()?.environmentId;
  const id = ProjectId.make(projectId);
  function project() {
    const value = props.state()?.shell?.projects.find((entry) => entry.id === id);
    if (!value) throw new Error("This project is no longer available.");
    return value;
  }
  function guard() {
    if (!destination || props.state()?.environmentId !== destination)
      throw new Error("The environment changed. Open project actions again.");
    return project();
  }

  async function update(patch: ProjectUpdatePayload) {
    guard();
    await request(props.client, WS_METHODS.projectsMutate, {
      type: "project.update",
      commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
      projectId: id,
      ...patch,
    });
  }

  async function settings() {
    guard();
    const value = await request(props.client, WS_METHODS.serverGetSettings, {});
    guard();
    return value;
  }

  async function projectFile(): Promise<T3ProjectFile | null> {
    const current = guard();
    const file = await request(props.client, WS_METHODS.projectsReadFile, {
      cwd: current.workspaceRoot,
      relativePath: "t3.json",
      allowMissing: true,
    });
    guard();
    if (file.exists === false) return null;
    if (file.truncated)
      throw new Error(
        "t3.json exceeds the server's read limit. Open it in an editor before importing project settings.",
      );
    const parsed = parseT3ProjectFile(file.contents);
    if (!parsed)
      throw new Error(
        "t3.json contains invalid project configuration. Fix it in Workspace → Files.",
      );
    return parsed;
  }

  async function overrides(
    patch: ProjectSettingsOverrides,
    clear: readonly ProjectScopedServerSettingKey[] = [],
  ) {
    const current = await settings();
    const inherited = clearProjectSettingsOverrides(current, id, clear);
    const next = { ...inherited, ...patch };
    guard();
    await request(props.client, WS_METHODS.serverUpdateSettings, {
      patch: { projectSettingsOverrides: { [id]: Object.keys(next).length ? next : null } },
    });
  }

  async function chooseModel() {
    const value = await settings();
    const current = resolveProjectSettings(value, id, project());
    const models = (props.state()?.config?.providers ?? []).filter(
      (provider) =>
        provider.enabled &&
        provider.status === "ready" &&
        resolveProjectProviderInstanceEnabled(value, id, provider.instanceId),
    );
    props.ui.choose(`Default model for ${project().title}`, [
      {
        title: "Inherit environment default",
        description:
          current.sources.defaultModelSelection === "environment"
            ? "Currently inherited"
            : "Remove this project's override",
        run: () => void props.ui.run(() => overrides({}, ["defaultModelSelection"])),
      },
      {
        title: "Choose automatically",
        description: "Let T3 choose from available providers",
        run: () => void props.ui.run(() => overrides({ defaultModelSelection: null })),
      },
      ...models.flatMap((provider) =>
        provider.models.map((model) => ({
          title: `${current.settings.defaultModelSelection?.instanceId === provider.instanceId && current.settings.defaultModelSelection.model === model.slug ? "✓ " : ""}${model.name}`,
          category: provider.displayName ?? provider.driver,
          run: () =>
            void props.ui.run(() =>
              overrides({
                defaultModelSelection: { instanceId: provider.instanceId, model: model.slug },
              }),
            ),
        })),
      ),
    ]);
  }

  async function defaults() {
    const [value, file] = await Promise.all([settings(), projectFile()]);
    const resolved = resolveProjectSettings(value, id, project(), file);
    const saved = value.projectSettingsOverrides[id] ?? {};
    const inherit = { label: "Inherit", value: "inherit" };
    const booleanOptions = [
      inherit,
      { label: "On", value: "true" },
      { label: "Off", value: "false" },
    ];
    props.ui.form({
      title: `${project().title} defaults`,
      description: `Workspace: ${resolved.settings.defaultThreadEnvMode} (${resolved.sources.defaultThreadEnvMode})\nSubmodules: ${resolved.settings.worktreeSubmodules} (${resolved.sources.worktreeSubmodules}). Inherit preserves environment and t3.json defaults.`,
      fields: [
        {
          name: "workspace",
          label: "New thread workspace",
          type: "select",
          value: saved.defaultThreadEnvMode ?? "inherit",
          options: [
            inherit,
            { label: "Local checkout", value: "local" },
            { label: "Separate worktree", value: "worktree" },
          ],
        },
        {
          name: "permissions",
          label: "Default permissions",
          type: "select",
          value: saved.defaultRuntimeMode ?? "inherit",
          options: [
            inherit,
            ...["approval-required", "auto-accept-edits", "auto", "full-access"].map((mode) => ({
              label: mode,
              value: mode,
            })),
          ],
        },
        {
          name: "submodules",
          label: "Worktree submodules",
          type: "select",
          value: saved.worktreeSubmodules ?? "inherit",
          options: [
            inherit,
            { label: "Recursive", value: "recursive" },
            { label: "Top level", value: "top-level" },
            { label: "None", value: "none" },
          ],
        },
        {
          name: "origin",
          label: "Start worktrees from remote",
          type: "select",
          value:
            saved.newWorktreesStartFromOrigin === undefined
              ? "inherit"
              : String(saved.newWorktreesStartFromOrigin),
          options: booleanOptions,
        },
        {
          name: "autoPull",
          label: "Pull automatically",
          type: "select",
          value: saved.defaultAutoPull === undefined ? "inherit" : String(saved.defaultAutoPull),
          options: booleanOptions,
        },
        {
          name: "browser",
          label: "Agent browser access",
          type: "select",
          value:
            saved.enableAgentBrowserAccess === undefined
              ? "inherit"
              : String(saved.enableAgentBrowserAccess),
          options: booleanOptions,
        },
        {
          name: "device",
          label: "Agent device access",
          type: "select",
          value:
            saved.enableAgentDeviceAccess === undefined
              ? "inherit"
              : String(saved.enableAgentDeviceAccess),
          options: booleanOptions,
        },
      ],
      submitLabel: "Save project defaults",
      onSubmit: async (values) => {
        const patch: {
          -readonly [Key in keyof ProjectSettingsOverrides]: ProjectSettingsOverrides[Key];
        } = {};
        const clear: ProjectScopedServerSettingKey[] = [];
        if (values.workspace === "local" || values.workspace === "worktree")
          patch.defaultThreadEnvMode = values.workspace;
        else clear.push("defaultThreadEnvMode");
        if (
          values.permissions === "approval-required" ||
          values.permissions === "auto-accept-edits" ||
          values.permissions === "auto" ||
          values.permissions === "full-access"
        )
          patch.defaultRuntimeMode = values.permissions;
        else clear.push("defaultRuntimeMode");
        if (
          values.submodules === "recursive" ||
          values.submodules === "top-level" ||
          values.submodules === "none"
        )
          patch.worktreeSubmodules = values.submodules;
        else clear.push("worktreeSubmodules");
        for (const [field, key] of [
          ["origin", "newWorktreesStartFromOrigin"],
          ["autoPull", "defaultAutoPull"],
          ["browser", "enableAgentBrowserAccess"],
          ["device", "enableAgentDeviceAccess"],
        ] as const) {
          if (values[field] === "inherit") clear.push(key);
          else patch[key] = values[field] === "true";
        }
        await overrides(patch, clear);
      },
    });
  }

  async function saveScripts(
    transform: (scripts: readonly ProjectScript[]) => readonly ProjectScript[],
  ) {
    const current = await settings();
    const scripts = transform(resolveProjectScripts(current, project()));
    guard();
    await request(props.client, WS_METHODS.serverUpdateSettings, {
      patch: {
        projectSettingsOverrides: {
          [id]: { ...current.projectSettingsOverrides[id], defaultProjectScripts: scripts },
        },
      },
    });
  }

  function editScript(script?: ProjectScript) {
    props.ui.form({
      title: script ? `Edit ${script.name}` : "Add project action",
      fields: [
        { name: "name", label: "Name", value: script?.name ?? "", required: true },
        {
          name: "command",
          label: "Shell command",
          type: "multiline",
          value: script?.command ?? "",
          required: true,
        },
        {
          name: "icon",
          label: "Icon",
          type: "select",
          value: script?.icon ?? "play",
          options: ProjectScriptIcon.literals.map((icon) => ({ label: icon, value: icon })),
        },
        {
          name: "setup",
          label: "Run when worktree is created",
          type: "toggle",
          value: String(script?.runOnWorktreeCreate ?? false),
        },
        {
          name: "wait",
          label: "Wait for setup before starting agent",
          type: "toggle",
          value: String(script?.async === false),
        },
        {
          name: "settle",
          label: "Run when worktree thread settles",
          type: "toggle",
          value: String(script?.runOnSettle ?? false),
        },
        {
          name: "stop",
          label: "Stop command when thread settles",
          type: "toggle",
          value: String(script?.stopOnSettle ?? false),
        },
        { name: "preview", label: "Preview URL (optional)", value: script?.previewUrl ?? "" },
        {
          name: "autoPreview",
          label: "Open preview automatically",
          type: "toggle",
          value: String(script?.autoOpenPreview ?? false),
        },
      ],
      submitLabel: "Save action",
      onSubmit: async (values) => {
        const saved = readScript(values, script?.id ?? SecureRandom.uuidV4Unsafe());
        await saveScripts((scripts) => {
          if (script && !scripts.some((entry) => entry.id === script.id))
            throw new Error("This action was removed. Reopen project actions before editing it.");
          return replaceScript(scripts, saved);
        });
      },
    });
  }

  async function runScript(script: ProjectScript) {
    const current = guard();
    const state = props.state();
    const thread = state?.thread?.thread;
    if (!thread || thread.projectId !== id)
      throw new Error("Select a thread in this project before running an action.");
    const session = { threadId: thread.id, terminalId: `action-${SecureRandom.uuidV4Unsafe()}` };
    await request(props.client, WS_METHODS.terminalOpen, {
      ...session,
      cwd: current.workspaceRoot,
      worktreePath: thread.worktreePath,
      env: projectScriptRuntimeEnv({
        project: { cwd: current.workspaceRoot },
        worktreePath: thread.worktreePath,
      }),
      stopOnSettle: script.stopOnSettle ?? false,
    });
    const checkout = guard();
    if (
      props.state()?.selectedThreadId !== thread.id ||
      props.state()?.thread?.thread.worktreePath !== thread.worktreePath ||
      checkout.workspaceRoot !== current.workspaceRoot
    )
      throw new Error(
        "The selected thread changed before the action started. Run it again from its thread.",
      );
    await request(props.client, WS_METHODS.terminalWrite, {
      ...session,
      data: projectScriptTerminalInput(script.command),
    });
    if (script.previewUrl && script.autoOpenPreview) props.ui.openBrowser?.(script.previewUrl);
    props.ui.notify(`Started ${script.name} in its own terminal.`);
    if (
      props.state()?.selectedThreadId === thread.id &&
      props.state()?.thread?.thread.worktreePath === thread.worktreePath
    )
      props.ui.openTerminal?.(session.terminalId);
  }

  async function scriptsMenu() {
    const current = await settings();
    const scripts = resolveProjectScripts(current, project());
    props.ui.choose(`${project().title} actions`, [
      { title: "Add action…", category: "Configure", run: () => editScript() },
      {
        title: "Import from t3.json",
        category: "Configure",
        run: () =>
          void props.ui.run(async () => {
            const file = await projectFile();
            if (!file?.scripts?.length)
              return props.ui.notify("t3.json has no project actions to import.");
            await saveScripts((existing) =>
              importFileScripts(existing, file.scripts!, SecureRandom.uuidV4Unsafe),
            );
          }, "Imported project actions"),
      },
      {
        title: "Inherit environment actions",
        category: "Configure",
        run: () =>
          props.ui.confirm(
            "Reset project actions?",
            "Use the environment's actions. This removes the project's action overrides.",
            () => overrides({}, ["defaultProjectScripts"]),
            "Use environment actions",
          ),
      },
      ...scripts.map((script) => ({
        title: script.name,
        description: script.command,
        category: script.runOnWorktreeCreate
          ? "Setup"
          : script.runOnSettle
            ? "On settle"
            : "Actions",
        run: () =>
          props.ui.choose(script.name, [
            { title: "Run action", run: () => void props.ui.run(() => runScript(script)) },
            { title: "Edit action", run: () => editScript(script) },
            {
              title: "Remove action",
              run: () =>
                props.ui.confirm(
                  "Remove project action?",
                  script.name,
                  () =>
                    saveScripts((existing) => existing.filter((entry) => entry.id !== script.id)),
                  "Remove action",
                ),
            },
          ]),
      })),
    ]);
  }

  async function publish() {
    const hosts = await request(props.client, WS_METHODS.serverDiscoverSourceControl, {});
    guard();
    const available = hosts.sourceControlProviders.filter((host) => host.status === "available");
    if (available.length === 0)
      throw new Error(
        "No source-control host is available. Configure one in Settings before publishing.",
      );
    props.ui.choose(
      "Publish repository to",
      available.map((host) => ({
        title: host.label,
        description:
          host.auth.status === "authenticated" ? "Signed in" : "Host sign-in may be required",
        run: () => {
          props.ui.form({
            title: `Publish to ${host.label}`,
            description: "Create a repository on your source-control host and add its remote.",
            fields: [
              { name: "repository", label: "Owner/repository", required: true },
              {
                name: "visibility",
                label: "Visibility",
                type: "select",
                value: "private",
                options: [
                  { label: "Private", value: "private" },
                  { label: "Public", value: "public" },
                ],
              },
            ],
            submitLabel: "Publish repository",
            onSubmit: async ({ repository = "", visibility = "private" }) => {
              const current = guard();
              const result = await request(
                props.client,
                WS_METHODS.sourceControlPublishRepository,
                {
                  cwd: current.workspaceRoot,
                  provider: host.kind,
                  repository: repository.trim(),
                  visibility: visibility === "public" ? "public" : "private",
                  protocol: "auto",
                },
              );
              props.ui.text("Published repository", result.repository.url);
            },
          });
        },
      })),
    );
  }

  async function openProjectFile() {
    const current = guard();
    const thread = props.state()?.thread?.thread;
    if (thread?.projectId === id && !thread.worktreePath) {
      props.ui.openFile("t3.json");
      return;
    }
    const file = await request(props.client, WS_METHODS.projectsReadFile, {
      cwd: current.workspaceRoot,
      relativePath: "t3.json",
      allowMissing: true,
    });
    guard();
    if (file.exists === false) throw new Error("This project has no t3.json file.");
    props.ui.text(
      `${current.title}/t3.json${file.truncated ? " (truncated)" : ""}`,
      file.contents,
      "json",
    );
  }

  const current = props.state()?.shell?.projects.find((entry) => entry.id === id);
  if (!current || !destination)
    return props.ui.notify("This project is no longer available.", true);
  const actions: Choice[] = [
    {
      title: "Rename project",
      run: () =>
        props.ui.form({
          title: "Rename project",
          fields: [{ name: "title", label: "Name", value: current.title, required: true }],
          submitLabel: "Rename",
          onSubmit: async ({ title = "" }) => update({ title: title.trim() }),
        }),
    },
    {
      title: current.pinnedAt ? "Unpin project" : "Pin project",
      run: () => void props.ui.run(() => update({ pinned: !current.pinnedAt })),
    },
    {
      title: current.archivedAt ? "Reopen project" : "Archive project",
      description: "Keep threads and files",
      run: () => void props.ui.run(() => update({ archived: !current.archivedAt })),
    },
    { title: "Default model", run: () => void props.ui.run(chooseModel) },
    { title: "Workspace, permissions and submodules", run: () => void props.ui.run(defaults) },
    { title: "Project actions and scripts", run: () => void props.ui.run(scriptsMenu) },
    { title: "Search conversations", run: () => conversationSearch(props, id) },
    {
      title: "Open t3.json",
      run: () => void props.ui.run(openProjectFile),
    },
    { title: "Clone another repository", run: () => cloneProject(props) },
    {
      title: "Repository cloning status",
      run: () => void props.ui.run(() => projectCloneStatus(props)),
    },
    { title: "Publish repository", run: () => void props.ui.run(publish) },
    {
      title: "Remove project from T3",
      description: "Remove its saved threads; keep the workspace folder on disk.",
      run: () =>
        props.ui.confirm(
          "Remove project from T3?",
          "Removes this project's saved conversations and project record. The workspace folder and repository stay on disk.",
          async () => {
            if (!(await props.ui.beforeNavigate())) return;
            guard();
            await request(props.client, WS_METHODS.projectsMutate, {
              type: "project.delete",
              commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
              projectId: id,
              force: true,
            });
            if (
              props.state()?.environmentId === destination &&
              props.state()?.thread?.thread.projectId === id
            )
              props.client.selectThread(null);
          },
          "Remove project",
        ),
    },
    {
      title: "Show workspace path",
      run: () => props.ui.text(current.title, current.workspaceRoot),
    },
  ];
  props.ui.choose(current.title, actions);
}
