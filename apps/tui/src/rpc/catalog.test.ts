import { describe, expect, it } from "vite-plus/test";
import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { decodeServiceInput, services } from "./catalog.ts";

describe("TUI service discovery", () => {
  it("exposes schema and operation variants for commands that do not have dedicated controls", () => {
    const dispatch = services.find(
      (service) => service.method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    )!;
    expect(dispatch.streaming).toBe(false);
    expect(dispatch.payloadSchema).toContain("thread.archive");
    expect(dispatch.variants.some((variant) => variant.name === "thread.archive")).toBe(true);
    const archive = dispatch.variants.find((variant) => variant.name === "thread.archive")!;
    expect(JSON.parse(archive.draft)).toMatchObject({
      type: "thread.archive",
      threadId: "",
      commandId: "",
    });
  });

  it("provides an inspectable schema and editable seed for every server service", () => {
    for (const service of services) {
      expect(() => JSON.parse(service.payloadSchema), service.method).not.toThrow();
      expect(() => JSON.parse(service.defaultDraft), service.method).not.toThrow();
    }
  });

  it("validates external JSON against the same contracts as the T3 server", () => {
    const read = { cwd: "/repo", relativePath: "README.md" };
    expect(decodeServiceInput(WS_METHODS.projectsReadFile, read)).toEqual({
      stream: false,
      input: read,
    });
    expect(() => decodeServiceInput(WS_METHODS.projectsReadFile, { cwd: "/repo" })).toThrow();
    expect(() => decodeServiceInput("does.not.exist", {})).toThrow("Unknown T3 service");
    expect(decodeServiceInput(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {}).stream).toBe(true);
  });
});
