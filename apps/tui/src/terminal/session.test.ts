import * as NodeEvents from "node:events";
import { ThreadId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { runTerminalSession } from "./session.ts";

function setup() {
  const inputEvents = new NodeEvents.EventEmitter();
  const outputEvents = new NodeEvents.EventEmitter();
  const input = Object.assign(inputEvents, {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
  });
  const output = Object.assign(outputEvents, {
    isTTY: true,
    columns: 110,
    rows: 40,
    write: vi.fn(),
  });
  const renderer = {
    externalOutputMode: "capture-stdout" as "capture-stdout" | "passthrough",
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
  };
  let emit = (_event: unknown): void => {
    throw new Error("Terminal is not attached.");
  };
  let fail = (_error: Error): void => {
    throw new Error("Terminal is not attached.");
  };
  let attached!: () => void;
  const ready = new Promise<void>((resolve) => {
    attached = resolve;
  });
  let writeObserved!: () => void;
  const written = new Promise<void>((resolve) => {
    writeObserved = resolve;
  });
  const detach = vi.fn();
  const client = {
    snapshot: () => ({ selectedThreadId: ThreadId.make("thread-1") }),
    invoke: vi.fn(async (method: string, _payload: unknown) => {
      if (method === WS_METHODS.terminalWrite) writeObserved();
      return undefined;
    }),
    stream: vi.fn(
      (
        _method: string,
        _payload: unknown,
        onValue: (value: unknown) => void,
        onError?: (error: Error) => void,
      ) => {
        emit = onValue;
        fail = (error) => onError?.(error);
        attached();
        return detach;
      },
    ),
  };
  const transport = { invoke: client.invoke, stream: client.stream };
  const scopedClient = { ...client, captureTransport: () => transport };
  return {
    client: scopedClient,
    transport,
    input,
    output,
    renderer,
    detach,
    ready,
    written,
    emit: (event: unknown) => emit(event),
    fail: (error: Error) => fail(error),
  };
}

const snapshot = {
  type: "snapshot",
  snapshot: {
    threadId: "thread-1",
    terminalId: "tui",
    cwd: "/remote/project",
    worktreePath: null,
    status: "running",
    pid: 100,
    history: "remote history",
    exitCode: null,
    exitSignal: null,
    label: "shell",
    updatedAt: "2026-11-18T12:00:00Z",
  },
};

describe("remote terminal handoff", () => {
  it("forwards UTF-8 bytes and interrupt keys, resizes, then detaches without closing the shell", async () => {
    const fixture = setup();
    const session = runTerminalSession(
      { client: fixture.client, renderer: fixture.renderer, cwd: "/remote/project" },
      fixture,
    );
    await fixture.ready;
    fixture.emit(snapshot);
    const currentDestination = vi.fn(async (...args: Parameters<typeof fixture.transport.invoke>) =>
      fixture.transport.invoke(...args),
    );
    fixture.client.invoke = currentDestination;
    expect(fixture.renderer.externalOutputMode).toBe("passthrough");
    fixture.input.emit("data", Buffer.from("ä\x03"));
    await fixture.written;
    expect(fixture.transport.invoke).toHaveBeenCalledWith(WS_METHODS.terminalWrite, {
      threadId: "thread-1",
      terminalId: "tui",
      data: "\xc3\xa4\x03",
      binary: true,
    });
    fixture.output.columns = 130;
    fixture.output.emit("resize");
    expect(fixture.transport.invoke).toHaveBeenCalledWith(WS_METHODS.terminalResize, {
      threadId: "thread-1",
      terminalId: "tui",
      cols: 130,
      rows: 40,
    });
    fixture.emit({
      type: "output",
      threadId: "thread-1",
      terminalId: "tui",
      data: "\x1b[32mremote output",
    });
    expect(fixture.output.write).toHaveBeenCalledWith("\x1b[32mremote output");
    fixture.input.emit("data", Buffer.from("echo x\r\x1d"));
    await session;
    expect(fixture.transport.invoke).toHaveBeenCalledWith(WS_METHODS.terminalWrite, {
      threadId: "thread-1",
      terminalId: "tui",
      data: "echo x\r",
      binary: true,
    });
    expect(fixture.detach).toHaveBeenCalledOnce();
    expect(
      fixture.transport.invoke.mock.calls.some(([method]) => method === WS_METHODS.terminalClose),
    ).toBe(false);
    expect(fixture.input.listenerCount("data")).toBe(0);
    expect(fixture.output.listenerCount("resize")).toBe(0);
    expect(fixture.renderer.externalOutputMode).toBe("capture-stdout");
    expect(fixture.renderer.resume).toHaveBeenCalledOnce();
    expect(currentDestination).not.toHaveBeenCalled();
  });

  it("restores renderer ownership and raw input when the stream fails", async () => {
    const fixture = setup();
    const session = runTerminalSession(
      { client: fixture.client, renderer: fixture.renderer, cwd: "/remote/project" },
      fixture,
    );
    await fixture.ready;
    fixture.fail(new Error("Disconnected"));
    await expect(session).rejects.toThrow("Disconnected");
    expect(fixture.detach).toHaveBeenCalledOnce();
    expect(fixture.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(fixture.input.listenerCount("data")).toBe(0);
    expect(fixture.output.listenerCount("resize")).toBe(0);
    expect(fixture.renderer.resume).toHaveBeenCalledOnce();
  });
});
