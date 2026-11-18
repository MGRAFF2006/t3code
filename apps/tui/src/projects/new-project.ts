import { ProjectId, WS_METHODS, type ProjectCloneSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { request, subscribe } from "../rpc/request.ts";
import type { FeatureProps } from "../ui/controller.ts";

function guardDestination(props: FeatureProps) {
  const destination = props.state()?.environmentId;
  return () => {
    if (!destination || props.state()?.environmentId !== destination)
      throw new Error("The environment changed. Reopen this project action.");
  };
}

export function cloneProject(props: FeatureProps) {
  const guard = guardDestination(props);
  props.ui.form({
    title: "Clone repository",
    description: "Clone on the selected environment and add it as a project.",
    fields: [
      { name: "url", label: "Repository URL", required: true },
      { name: "destination", label: "Destination directory", required: true },
      { name: "title", label: "Project name (optional)" },
    ],
    submitLabel: "Clone",
    onSubmit: async ({ url = "", destination: path = "", title = "" }) => {
      guard();
      const name =
        title.trim() ||
        path
          .replace(/[/\\]$/, "")
          .split(/[/\\]/)
          .at(-1) ||
        "Cloned project";
      await request(props.client, WS_METHODS.projectCloneStart, {
        projectId: ProjectId.make(SecureRandom.uuidV4Unsafe()),
        title: name,
        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
        remoteUrl: url.trim(),
        destinationPath: path.trim(),
        protocol: "auto",
      });
      props.ui.notify("Cloning started. Use project cloning status to follow progress.");
    },
  });
}

export async function projectCloneStatus(props: FeatureProps) {
  const guard = guardDestination(props);
  guard();
  let stop: (() => void) | undefined;
  let result: readonly ProjectCloneSnapshot[];
  try {
    result = await new Promise((resolve, reject) => {
      stop = subscribe(props.client, WS_METHODS.subscribeProjectClones, {}, resolve, reject);
    });
  } finally {
    stop?.();
  }
  guard();
  props.ui.choose("Repository cloning status", [
    { title: "Refresh", run: () => void props.ui.run(() => projectCloneStatus(props)) },
    ...result.map((clone) => ({
      title: clone.repository?.nameWithOwner ?? clone.destinationPath,
      category: clone.phase,
      description: `${clone.stage}${clone.percent === null ? "" : ` ${clone.percent}%`}${clone.stalled ? " (waiting for output)" : ""}${clone.error ? `: ${clone.error}` : ""}`,
      run: () =>
        props.ui.choose(clone.destinationPath, [
          {
            title: "Details",
            description: clone.detail ?? clone.phase,
            run: () =>
              props.ui.text(
                "Clone details",
                [clone.destinationPath, clone.phase, clone.stage, clone.detail, clone.error]
                  .filter(Boolean)
                  .join("\n"),
              ),
          },
          ...(clone.phase === "running"
            ? [
                {
                  title: "Cancel cloning",
                  run: () =>
                    void props.ui.run(async () => {
                      guard();
                      await request(props.client, WS_METHODS.projectCloneCancel, {
                        projectId: clone.projectId,
                      });
                      await projectCloneStatus(props);
                    }),
                },
              ]
            : []),
          ...(clone.phase === "failed" || clone.phase === "cancelled"
            ? [
                {
                  title: "Retry cloning",
                  run: () =>
                    void props.ui.run(async () => {
                      guard();
                      await request(props.client, WS_METHODS.projectCloneRetry, {
                        projectId: clone.projectId,
                      });
                      await projectCloneStatus(props);
                    }),
                },
              ]
            : []),
        ]),
    })),
  ]);
}

export function newProjectActions(props: FeatureProps) {
  const guard = guardDestination(props);
  async function browse(partialPath = "~/") {
    guard();
    const result = await request(props.client, WS_METHODS.filesystemBrowse, { partialPath });
    guard();
    props.ui.choose(result.parentPath, [
      {
        title: "Add this folder as a project",
        description: result.parentPath,
        run: () =>
          props.ui.form({
            title: "Open folder",
            fields: [{ name: "name", label: "Project name (optional)" }],
            submitLabel: "Add project",
            onSubmit: async ({ name = "" }) => {
              guard();
              await props.client.createProject(result.parentPath, name.trim() || undefined);
            },
          }),
      },
      {
        title: "Parent folder",
        run: () => void props.ui.run(() => browse(`${result.parentPath}/../`)),
      },
      {
        title: "Enter path…",
        run: () =>
          props.ui.form({
            title: "Browse environment folders",
            fields: [
              {
                name: "path",
                label: "Directory or path prefix",
                value: result.parentPath,
                required: true,
              },
            ],
            submitLabel: "Browse",
            onSubmit: async ({ path = "~/" }) => browse(path),
          }),
      },
      ...result.entries.map((entry) => ({
        title: entry.name,
        description: entry.fullPath,
        run: () => void props.ui.run(() => browse(`${entry.fullPath}/`)),
      })),
    ]);
  }
  props.ui.choose("Add project", [
    {
      title: "Browse environment folders",
      description: "Choose a folder on this environment",
      run: () => void props.ui.run(() => browse()),
    },
    {
      title: "Open existing folder",
      description: "Add a workspace from the selected environment",
      run: () =>
        props.ui.form({
          title: "Open folder",
          fields: [
            { name: "path", label: "Workspace directory", required: true },
            { name: "name", label: "Project name (optional)" },
          ],
          submitLabel: "Add project",
          onSubmit: async ({ path = "", name = "" }) => {
            guard();
            await props.client.createProject(path.trim(), name.trim() || undefined);
          },
        }),
    },
    {
      title: "Create new project",
      description: "Create a new folder and repository",
      run: () =>
        props.ui.form({
          title: "New project",
          fields: [{ name: "name", label: "Project name", required: true }],
          submitLabel: "Create project",
          onSubmit: async ({ name = "" }) => {
            guard();
            const result = await request(props.client, WS_METHODS.projectsCreateNew, {
              name: name.trim(),
            });
            props.ui.notify(
              result.commitError
                ? `Created ${result.workspaceRoot}; initial commit failed: ${result.commitError}`
                : `Created ${result.workspaceRoot}`,
              !!result.commitError,
            );
          },
        }),
    },
    { title: "Clone repository", run: () => cloneProject(props) },
    {
      title: "Repository cloning status",
      run: () => void props.ui.run(() => projectCloneStatus(props)),
    },
  ]);
}
