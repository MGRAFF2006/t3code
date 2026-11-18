import type { CliRenderer } from "@opentui/core";
import { chunkTerminalWrite, TerminalAttachStreamEvent, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { TuiClient, TuiSnapshot } from "../runtime/client.ts";

type TerminalClient = Pick<TuiClient, "captureTransport"> & {
  readonly snapshot: () => Pick<TuiSnapshot, "selectedThreadId">;
};

interface TerminalIo {
  readonly input: {
    readonly isTTY?: boolean;
    readonly isRaw?: boolean;
    setRawMode?: (enabled: boolean) => unknown;
    resume: () => unknown;
    pause: () => unknown;
    on: (event: "data", listener: (data: Buffer | string) => void) => unknown;
    off: (event: "data", listener: (data: Buffer | string) => void) => unknown;
  };
  readonly output: {
    readonly isTTY?: boolean;
    readonly columns?: number;
    readonly rows?: number;
    write: (data: string) => unknown;
    on: (event: "resize", listener: () => void) => unknown;
    off: (event: "resize", listener: () => void) => unknown;
  };
}

export interface OpenTerminalOptions {
  readonly client: TerminalClient;
  readonly renderer: Pick<CliRenderer, "suspend" | "resume" | "externalOutputMode">;
  readonly cwd: string;
  readonly threadId?: string;
  readonly terminalId?: string;
}

const resetScreen = "\x1b[0m\x1b[2J\x1b[H";
const detachScreen =
  "\x1b[0m\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l";
const decodeEvent = Schema.decodeUnknownSync(TerminalAttachStreamEvent);

export async function openTerminal(options: OpenTerminalOptions): Promise<void> {
  return runTerminalSession(options, { input: process.stdin, output: process.stdout });
}

export async function runTerminalSession(
  {
    client,
    renderer,
    cwd,
    threadId = client.snapshot().selectedThreadId ?? "",
    terminalId = "tui",
  }: OpenTerminalOptions,
  { input, output }: TerminalIo,
): Promise<void> {
  if (!threadId) throw new Error("Select a thread before opening its terminal.");
  if (!cwd) throw new Error("This thread has no workspace directory.");
  if (!input.isTTY || !output.isTTY)
    throw new Error("The remote shell needs an interactive terminal.");

  const transport = client.captureTransport();
  const session = { threadId, terminalId };
  const grid = () => ({
    cols: Math.min(1000, Math.max(1, output.columns ?? 80)),
    rows: Math.min(500, Math.max(1, output.rows ?? 24)),
  });
  const previousOutputMode = renderer.externalOutputMode;
  let detach: (() => void) | undefined;
  let active = true;
  let ready = false;
  let writes = Promise.resolve();
  let writeFailure: Error | undefined;
  let cancelWrites = false;
  let pendingInput = "";
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const fail = (error: unknown) => {
    cancelWrites = true;
    if (!active) return;
    active = false;
    rejectCompletion(error instanceof Error ? error : new Error(String(error)));
  };
  const finish = () => {
    active = false;
    resolveCompletion();
  };
  const send = (data: string) => {
    for (const part of chunkTerminalWrite(data)) {
      writes = writes
        .then(async () => {
          if (!cancelWrites)
            await transport.invoke(WS_METHODS.terminalWrite, {
              ...session,
              data: part,
              binary: true,
            });
        })
        .catch((error: unknown) => {
          writeFailure = error instanceof Error ? error : new Error(String(error));
          fail(error);
        });
    }
  };
  const onInput = (data: Buffer | string) => {
    if (!active) return;
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    const escape = bytes.indexOf(0x1d);
    const forwarded = (escape < 0 ? bytes : bytes.subarray(0, escape)).toString("latin1");
    if (ready) send(forwarded);
    else {
      pendingInput += forwarded;
      if (pendingInput.length > 65_536)
        fail(new Error("The shell has not connected; input buffer is full."));
    }
    if (escape >= 0) finish();
  };
  const onResize = () => {
    if (active && ready)
      void transport.invoke(WS_METHODS.terminalResize, { ...session, ...grid() }).catch(fail);
  };

  await renderer.suspend();
  const previousRaw = input.isRaw ?? false;
  try {
    renderer.externalOutputMode = "passthrough";
    output.write(`\x1b[?1049h${resetScreen}T3 remote shell · Ctrl+] returns to chat\r\n`);
    input.setRawMode?.(true);
    input.on("data", onInput);
    output.on("resize", onResize);
    input.resume();
    detach = transport.stream(
      WS_METHODS.terminalAttach,
      {
        ...session,
        cwd,
        ...grid(),
        maxHistoryBytes: 256 * 1024,
      },
      (value) => {
        if (!active) return;
        try {
          const event = decodeEvent(value);
          switch (event.type) {
            case "snapshot":
            case "restarted": {
              output.write(resetScreen + event.snapshot.history);
              if (event.snapshot.status === "error") {
                fail(new Error(event.snapshot.error ?? "The remote shell failed to start."));
              } else if (event.snapshot.status === "exited") finish();
              else if (event.snapshot.status === "running") {
                ready = true;
                if (pendingInput) {
                  send(pendingInput);
                  pendingInput = "";
                }
                onResize();
              }
              break;
            }
            case "output":
              output.write(event.data);
              break;
            case "cleared":
              output.write(resetScreen);
              break;
            case "exited":
            case "closed":
              finish();
              break;
            case "error":
              fail(new Error(event.message));
              break;
            case "activity":
              break;
          }
        } catch (error) {
          fail(error);
        }
      },
      fail,
    );
    await completion;
  } finally {
    active = false;
    try {
      detach?.();
    } finally {
      try {
        input.pause();
        input.off("data", onInput);
        output.off("resize", onResize);
        input.setRawMode?.(previousRaw);
        output.write(detachScreen);
      } finally {
        try {
          renderer.externalOutputMode = previousOutputMode;
        } finally {
          await renderer.resume();
        }
      }
    }
  }
  await writes;
  if (writeFailure) throw writeFailure;
}
