// @effect-diagnostics nodeBuiltinImport:off -- Preview tests inspect private temporary artifact files without opening a browser.
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { htmlArtifacts } from "./html.ts";
import { browserCommand, createFilePreview, createHtmlPreview } from "./opener.ts";

describe("HTML response previews", () => {
  it("offers complete HTML fences, including multiple artifacts, without treating examples inside other fences as artifacts", () => {
    expect(
      htmlArtifacts(
        "An example:\n````markdown\n```html\n<p>Example only</p>\n```\n````\nActual result:\n~~~html\n<h1>First</h1>\n~~~\n```HTML\n<h1>Second</h1>\n```\n```html\n<p>Still streaming",
      ),
    ).toEqual([
      { title: "HTML preview", html: "<h1>First</h1>" },
      { title: "HTML preview 2", html: "<h1>Second</h1>" },
    ]);
    expect(
      htmlArtifacts("<!doctype html><html><body>Complete document</body></html>")[0]?.html,
    ).toContain("Complete document");
    expect(htmlArtifacts("Prose mentioning <html> is not a document.")).toEqual([]);
  });
  it("passes browser targets as one OS argument and refuses executable URL schemes", () => {
    const url = "https://example.test/preview?label=$(touch%20/tmp/no)&value=1";
    expect(browserCommand("linux", url)).toEqual(["xdg-open", new URL(url).href]);
    expect(browserCommand("win32", url)).toEqual([
      "rundll32.exe",
      "url.dll,FileProtocolHandler",
      new URL(url).href,
    ]);
    expect(() => browserCommand("linux", "javascript:alert(1)")).toThrow("Only web pages");
    expect(() => browserCommand("linux", "data:text/html,hello")).toThrow("Only web pages");
    expect(() => browserCommand("win32", "file://remote-share/preview.html")).toThrow(
      "Only local preview files",
    );
  });
  it.effect("writes HTML to a private local artifact and removes it when disposed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const html = "<!doctype html><title>Agent preview</title><p>Private content</p>";
        const preview = yield* Effect.acquireRelease(
          Effect.promise(() => createHtmlPreview(html)),
          (value) => Effect.promise(value.dispose),
        );
        const path = NodeURL.fileURLToPath(preview.url);
        const contents = yield* Effect.promise(() => NodeFSP.readFile(path, "utf8"));
        const stat = yield* Effect.promise(() => NodeFSP.stat(path));
        expect(contents).toBe(html);
        if ((yield* HostProcess.Platform) !== "win32") expect(stat.mode & 0o777).toBe(0o600);
        yield* Effect.promise(preview.dispose);
        yield* Effect.promise(async () => {
          await expect(NodeFSP.access(path)).rejects.toThrow();
        });
        const artifact = yield* Effect.acquireRelease(
          Effect.promise(() =>
            createFilePreview(new Uint8Array([37, 80, 68, 70]), "../../private/report.pdf"),
          ),
          (value) => Effect.promise(value.dispose),
        );
        const artifactPath = NodeURL.fileURLToPath(artifact.url);
        expect(NodePath.basename(artifactPath)).toBe("report.pdf");
        expect(NodePath.basename(NodePath.dirname(artifactPath))).toMatch(/^t3-tui-artifact-/);
        const bytes = yield* Effect.promise(() => NodeFSP.readFile(artifactPath));
        expect([...bytes]).toEqual([37, 80, 68, 70]);
      }),
    ),
  );
});
