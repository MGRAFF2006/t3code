// @effect-diagnostics nodeBuiltinImport:off -- The terminal's explicit browser action writes a private local preview and launches the OS URL handler.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";

export function browserCommand(platform: string, value: string): ReadonlyArray<string> {
  const url = new URL(value);
  if (!["http:", "https:", "file:"].includes(url.protocol))
    throw new Error("Only web pages and local preview files can open in the browser.");
  if (url.protocol === "file:" && url.hostname && url.hostname !== "localhost")
    throw new Error("Only local preview files can open in the browser.");
  if (platform === "darwin") return ["open", url.href];
  if (platform === "win32") return ["rundll32.exe", "url.dll,FileProtocolHandler", url.href];
  return ["xdg-open", url.href];
}

export async function openBrowser(value: string): Promise<void> {
  const args = browserCommand(HostProcess.Platform.defaultValue(), value);
  const child = Bun.spawn([...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const result = await child.exited;
  if (result !== 0)
    throw new Error("The browser could not be opened. Open the preview URL manually.");
}

export async function createHtmlPreview(
  html: string,
): Promise<{ url: string; dispose: () => Promise<void> }> {
  return createFilePreview(new TextEncoder().encode(html), "preview.html");
}

export async function createFilePreview(bytes: Uint8Array, label: string) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-artifact-"));
  try {
    const basename = NodePath.basename(label.replaceAll("\\", "/"))
      .replace(/[^\p{L}\p{N}._ -]/gu, "_")
      .slice(-120);
    const filename = !basename || basename === "." || basename === ".." ? "artifact.bin" : basename;
    const path = NodePath.join(directory, filename);
    await NodeFSP.writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    return {
      url: NodeURL.pathToFileURL(path).href,
      dispose: () => NodeFSP.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
