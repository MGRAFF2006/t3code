// @effect-diagnostics nodeBuiltinImport:off -- Native plan downloads use exclusive local files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { WS_METHODS } from "@t3tools/contracts";
import type { FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";

export function planActions(
  props: FeatureProps,
  markdown: string,
  copy: () => void,
  canUpdate: () => boolean,
) {
  const thread = props.state()?.thread?.thread;
  const project = props.state()?.shell?.projects.find((value) => value.id === thread?.projectId);
  const cwd = thread?.worktreePath ?? project?.workspaceRoot;
  const contents = `${markdown.trimEnd()}\n`;
  props.ui.choose("Proposed plan", [
    { title: "Open full plan", run: () => props.ui.text("Proposed plan", markdown, "markdown") },
    { title: "Copy plan", run: copy },
    {
      title: "Save to this computer…",
      run: () =>
        props.ui.form({
          title: "Save plan locally",
          fields: [
            {
              name: "path",
              label: "New local file path",
              value: "~/Downloads/plan.md",
              required: true,
            },
          ],
          submitLabel: "Save plan",
          onSubmit: async (values) => {
            const input = (values.path ?? "").trim();
            const path = NodePath.resolve(
              input.startsWith("~/") ? NodePath.join(NodeOS.homedir(), input.slice(2)) : input,
            );
            await NodeFSP.writeFile(path, contents, { flag: "wx", mode: 0o600 });
            props.ui.notify(`Saved plan to ${path}`);
          },
        }),
    },
    ...(cwd
      ? [
          {
            title: "Save to workspace…",
            run: () =>
              props.ui.form({
                title: "Save plan to workspace",
                description: cwd,
                fields: [
                  {
                    name: "path",
                    label: "New workspace file path",
                    value: "plan.md",
                    required: true,
                  },
                ],
                submitLabel: "Save plan",
                onSubmit: async (values) => {
                  if (!canUpdate())
                    throw new Error("Return to the original conversation to save this plan.");
                  const relativePath = (values.path ?? "").trim();
                  const existing = await request(props.client, WS_METHODS.projectsReadFile, {
                    cwd,
                    relativePath,
                    allowMissing: true,
                  });
                  if (existing.exists !== false)
                    throw new Error(
                      "This file already exists. Choose a new path or edit the existing file.",
                    );
                  if (!canUpdate())
                    throw new Error("Return to the original conversation to save this plan.");
                  await request(props.client, WS_METHODS.projectsWriteFile, {
                    cwd,
                    relativePath,
                    contents,
                  });
                  props.ui.notify(`Saved plan to ${relativePath}`);
                },
              }),
          },
        ]
      : []),
  ]);
}
