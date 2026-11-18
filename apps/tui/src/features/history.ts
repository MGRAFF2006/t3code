import { WS_METHODS } from "@t3tools/contracts";
import { request } from "../rpc/request.ts";
import type { FeatureProps } from "../ui/controller.ts";

export async function importAgentHistory(props: FeatureProps) {
  const environment = props.state()?.environmentId;
  const guard = () => {
    if (!environment || props.state()?.environmentId !== environment)
      throw new Error("The environment changed. Scan agent history again.");
  };
  guard();
  const result = await request(props.client, WS_METHODS.agentSessionsScan, {});
  guard();
  if (!result.candidates.length) {
    props.ui.notify("No importable Codex, Claude or Pi history was found on this environment.");
    return;
  }
  props.ui.choose(
    "Import agent history",
    result.candidates.map((candidate) => ({
      title: candidate.title,
      description: `${candidate.path} · ${candidate.threadCount} conversations · ${candidate.sources.join(", ")}${candidate.alreadyImported ? " · Already imported" : ""}`,
      run: () =>
        props.ui.confirm(
          "Import agent history",
          `Import conversations from ${candidate.path}. Existing conversations are retained and previously imported sessions are skipped.`,
          async () => {
            guard();
            const projectId =
              candidate.projectId ??
              (await props.client.createProject(candidate.path, candidate.title));
            guard();
            const imported = await request(props.client, WS_METHODS.agentSessionsImport, {
              projectId,
              expectedWorkspaceRoot: candidate.path,
            });
            props.ui.notify(
              `Imported ${imported.importedCount} conversations; ${imported.skippedCount} already present.`,
            );
          },
          "Import conversations",
        ),
    })),
  );
  if (result.truncated)
    props.ui.notify(
      "The session scan was truncated. Import these projects, then scan again for more.",
    );
}
