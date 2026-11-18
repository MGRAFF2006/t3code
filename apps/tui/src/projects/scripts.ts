import { ProjectScript, type T3ProjectFile } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeScript = Schema.decodeUnknownSync(ProjectScript);

export function readScript(values: Record<string, string>, id: string): ProjectScript {
  const previewUrl = values.preview?.trim();
  if (previewUrl) {
    const parsed = new URL(previewUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("Preview URL must start with http:// or https://.");
  }
  return decodeScript({
    id,
    name: values.name?.trim(),
    command: values.command?.trim(),
    icon: values.icon ?? "play",
    runOnWorktreeCreate: values.setup === "true",
    runOnSettle: values.settle === "true",
    stopOnSettle: values.stop === "true",
    async: values.setup !== "true" || values.wait !== "true",
    ...(previewUrl ? { previewUrl, autoOpenPreview: values.autoPreview === "true" } : {}),
  });
}

export function replaceScript(
  scripts: readonly ProjectScript[],
  saved: ProjectScript,
): readonly ProjectScript[] {
  const found = scripts.some((script) => script.id === saved.id);
  const next = scripts.map((script) =>
    script.id === saved.id
      ? saved
      : {
          ...script,
          ...(saved.runOnWorktreeCreate && script.runOnWorktreeCreate
            ? { runOnWorktreeCreate: false, async: true }
            : {}),
          ...(saved.runOnSettle && script.runOnSettle ? { runOnSettle: false } : {}),
        },
  );
  return found ? next : [...next, saved];
}

export function importFileScripts(
  scripts: readonly ProjectScript[],
  incoming: NonNullable<T3ProjectFile["scripts"]>,
  id: () => string,
) {
  let result = scripts;
  for (const script of incoming) {
    if (
      result.some(
        (existing) => existing.name === script.name && existing.command === script.command,
      )
    )
      continue;
    result = replaceScript(result, {
      ...script,
      id: id(),
      icon: script.icon ?? "play",
      runOnWorktreeCreate: script.runOnWorktreeCreate ?? false,
    });
  }
  return result;
}
