import { describe, expect, it } from "@effect/vitest";
import type { ProjectScript } from "@t3tools/contracts";
import { importFileScripts, readScript, replaceScript } from "./scripts.ts";

describe("project actions", () => {
  const setup: ProjectScript = {
    id: "setup",
    name: "Install",
    command: "vp i",
    icon: "configure",
    runOnWorktreeCreate: true,
    async: false,
  };
  const cleanup: ProjectScript = {
    id: "cleanup",
    name: "Clean",
    command: "rm -rf build",
    icon: "configure",
    runOnWorktreeCreate: false,
    runOnSettle: true,
  };

  it("transfers setup and settle ownership while preserving ordinary action settings", () => {
    const next = replaceScript([setup, cleanup], {
      id: "new",
      name: "Prepare",
      command: "prepare",
      icon: "play",
      runOnWorktreeCreate: true,
      runOnSettle: true,
    });
    expect(next.filter((script) => script.runOnWorktreeCreate).map((script) => script.id)).toEqual([
      "new",
    ]);
    expect(next.filter((script) => script.runOnSettle).map((script) => script.id)).toEqual(["new"]);
    expect(next[0]).toMatchObject({ id: "setup", command: "vp i", async: true });
    expect(setup.runOnWorktreeCreate).toBe(true);
    const edited = replaceScript(next, { ...next[2]!, name: "Prepare edited" });
    expect(edited).toHaveLength(3);
    expect(edited.at(-1)?.name).toBe("Prepare edited");
  });

  it("imports repository actions without duplicate commands and validates executable form input", () => {
    const imported = importFileScripts(
      [setup],
      [
        { name: "Install", command: "vp i" },
        { name: "Check", command: "vp check", runOnWorktreeCreate: true },
      ],
      () => "imported",
    );
    expect(imported).toHaveLength(2);
    expect(
      imported.filter((script) => script.runOnWorktreeCreate).map((script) => script.id),
    ).toEqual(["imported"]);
    const saved = readScript(
      {
        name: "  Preview ",
        command: "  vp dev\n",
        setup: "true",
        wait: "true",
        preview: "https://localhost:3000",
        autoPreview: "true",
      },
      "preview",
    );
    expect(saved).toMatchObject({
      name: "Preview",
      command: "vp dev",
      async: false,
      previewUrl: "https://localhost:3000",
      autoOpenPreview: true,
    });
    expect(readScript({ name: "Test", command: "vp test", wait: "true" }, "test").async).toBe(true);
    expect(() =>
      readScript({ name: "Preview", command: "vp dev", preview: "file:///etc/hosts" }, "preview"),
    ).toThrow("http:// or https://");
    expect(() => readScript({ name: "Preview", command: "   " }, "preview")).toThrow();
  });
});
