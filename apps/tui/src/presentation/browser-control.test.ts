import { expect, it, vi } from "@effect/vitest";
import * as BrowserStream from "@t3tools/client-runtime/preview/server-browser-stream";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { controlBrowser } from "./browser-control.ts";

const access: DeviceHubAccess = {
  httpBase: "http://server.invalid/api/preview-stream",
  wsBase: "ws://server.invalid/api/preview-stream",
  query: {},
  credentials: false,
};

it("takes shared browser control before navigating, sends once and disconnects", async () => {
  const sent: BrowserStream.PreviewStreamInput[] = [];
  const stop = vi.fn();
  const registered = Promise.withResolvers<BrowserStream.PreviewStreamEvents>();
  using _stream = vi
    .spyOn(BrowserStream, "createPreviewStreamClient")
    .mockImplementation((_target, handlers) => {
      registered.resolve(handlers);
      return {
        send: (input) => {
          sent.push(input);
          return true;
        },
        stop,
      };
    });
  const promise = controlBrowser(access, "thread", "tab", { type: "history", delta: -1 }, () => {});
  const events = await registered.promise;
  const control = { canOperate: true, controller: "agent" as const, generation: 1, dialog: null };
  events?.onControl?.(control);
  expect(sent).toEqual([{ type: "takeControl" }]);
  events?.onControl?.({ ...control, controller: "you", generation: 2 });
  events?.onControl?.({ ...control, controller: "you", generation: 2 });
  expect(sent).toEqual([
    { type: "takeControl" },
    { type: "history", delta: -1 },
    { type: "probe", x: 0, y: 0 },
  ]);
  expect(stop).not.toHaveBeenCalled();
  events.onProbe?.({ x: 0, y: 0, editable: false });
  await promise;
  expect(sent).toHaveLength(3);
  expect(stop).toHaveBeenCalledOnce();
});

it.each(["read-only", "changed-environment"] as const)(
  "leaves the page unchanged when %s",
  async (scenario) => {
    const send = vi.fn(() => true);
    const stop = vi.fn();
    const registered = Promise.withResolvers<BrowserStream.PreviewStreamEvents>();
    using _stream = vi
      .spyOn(BrowserStream, "createPreviewStreamClient")
      .mockImplementation((_target, handlers) => {
        registered.resolve(handlers);
        return { send, stop };
      });
    let current = true;
    const promise = controlBrowser(
      access,
      "thread",
      "tab",
      { type: "navigate", url: "https://example.com" },
      () => {
        if (!current) throw Error("The environment changed");
      },
    );
    const events = await registered.promise;
    if (scenario === "changed-environment") current = false;
    events?.onControl?.({
      canOperate: scenario !== "read-only",
      controller: "you",
      generation: 1,
      dialog: null,
    });
    await expect(promise).rejects.toThrow(
      scenario === "read-only" ? "read-only" : "environment changed",
    );
    expect(send).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  },
);
