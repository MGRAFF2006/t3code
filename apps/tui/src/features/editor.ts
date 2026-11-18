import { EDITORS, WS_METHODS } from "@t3tools/contracts";
import { request } from "../rpc/request.ts";
import type { FeatureProps } from "../ui/controller.ts";

export function openInEnvironmentEditor(
  props: FeatureProps,
  cwd: string,
  target?: { path: string; line?: number },
) {
  const environmentId = props.state()?.environmentId;
  const available = props.state()?.config?.availableEditors ?? [];
  const editors = EDITORS.filter((editor) => available.includes(editor.id));
  if (editors.length === 0) {
    props.ui.notify("No external editors are available on this environment.");
    return;
  }
  const path = target
    ? /^(?:[\\/]|[a-z]:[\\/])/i.test(target.path)
      ? target.path
      : `${cwd.replace(/[\\/]$/, "")}/${target.path}`
    : cwd;
  props.ui.choose(
    "Open on environment's computer",
    editors.map((editor) => ({
      title: editor.label,
      description: `${props.state()?.label ?? "Environment"}: ${path}`,
      run: () =>
        void props.ui.run(async () => {
          if (props.state()?.environmentId !== environmentId)
            throw new Error("The environment changed. Select the editor again.");
          await request(props.client, WS_METHODS.shellOpenInEditor, {
            cwd: path,
            editor: editor.id,
            projectRoot: cwd,
            position: target?.line ? { line: target.line } : {},
          });
        }),
    })),
  );
}
