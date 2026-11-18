import { help, parseCli } from "./cli.ts";

async function main() {
  const options = parseCli(Bun.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${help}\n`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("The terminal client needs an interactive terminal. Use --help for options.");
  const { createCliRenderer } = await import("@opentui/core");
  const { render } = await import("@opentui/solid");
  const { createComponent } = await import("solid-js");
  const { App } = await import("./app.tsx");
  const { createTuiClient } = await import("./runtime/client.ts");
  const url = options.url ?? Bun.env.T3_TUI_URL;
  const token = Bun.env.T3_TUI_TOKEN;
  const client = options.demo
    ? null
    : await createTuiClient({
        ...(url ? { url } : {}),
        ...(token ? { token } : {}),
        ...(options.pairingUrl ? { pairingUrl: options.pairingUrl } : {}),
        ...(options.configDir ? { configDir: options.configDir } : {}),
      });
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined;
  const close = () => {
    if (renderer) renderer.destroy();
    else client?.close();
  };
  try {
    if (options.thread) client?.selectThread(options.thread);
    renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
    renderer.once("destroy", () => client?.close());
    await render(
      () => createComponent(App, { client, demo: options.demo, onExit: close }),
      renderer,
    );
  } catch (error) {
    close();
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
