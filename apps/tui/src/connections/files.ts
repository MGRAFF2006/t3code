// @effect-diagnostics nodeBuiltinImport:off -- Terminal connection credentials use private files in the client state directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

export const isMissingFile = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export async function preparePrivateDirectory(directory: string) {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(directory, 0o700);
  await NodeFSP.writeFile(NodePath.join(directory, ".gitignore"), "*\n!.gitignore\n", {
    mode: 0o600,
  });
}

export async function readPrivateFile(filename: string) {
  try {
    await NodeFSP.chmod(filename, 0o600);
    return await NodeFSP.readFile(filename, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function writePrivateFile(filename: string, contents: string) {
  const temporary = `${filename}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await NodeFSP.rename(temporary, filename);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

export async function createPrivateFile(filename: string, contents: string) {
  const temporary = `${filename}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    try {
      await NodeFSP.link(temporary, filename);
      return contents;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const existing = await readPrivateFile(filename);
      if (existing === null)
        throw new Error("Connection identity disappeared while loading it.", { cause: error });
      return existing;
    }
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

export const removePrivateFile = (filename: string) => NodeFSP.rm(filename, { force: true });
