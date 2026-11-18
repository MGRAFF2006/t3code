import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";

interface PatchFile {
  path: string;
  patch: string;
}

function headerPath(header: string) {
  const body = header.replace(/^diff --git /, "");
  const quotedFirst = /^"(?:\\.|[^"\\])*"/.exec(body)?.[0];
  if (quotedFirst)
    return unquoteGitPatchPath(body.slice(quotedFirst.length + 1)).replace(/^b\//, "");
  const quotedSecond = / ("b\/(?:\\.|[^"\\])*")$/.exec(body)?.[1];
  if (quotedSecond) return unquoteGitPatchPath(quotedSecond).replace(/^b\//, "");
  const separators = [...body.matchAll(/ b\//g)];
  const separator =
    separators.find((match) => body.slice(2, match.index) === body.slice(match.index + 3)) ??
    separators.at(-1);
  return separator ? unquoteGitPatchPath(body.slice(separator.index + 3)) : body;
}

export function patchFiles(patch: string): PatchFile[] {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((part) => part.trim())
    .map((part) => {
      const lines = part.split("\n");
      const newPath = lines.find((line) => line.startsWith("+++ "))?.slice(4);
      const oldPath = lines.find((line) => line.startsWith("--- "))?.slice(4);
      const path = newPath && newPath !== "/dev/null" ? newPath : oldPath;
      const renamed = lines.find((line) => line.startsWith("rename to "))?.slice(10);
      return {
        path: path
          ? unquoteGitPatchPath(path).replace(/^[ab]\//, "")
          : renamed
            ? unquoteGitPatchPath(renamed)
            : headerPath(lines[0] ?? "Changed file"),
        patch: part,
      };
    });
}
