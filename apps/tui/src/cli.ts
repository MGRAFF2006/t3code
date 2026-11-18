export interface CliOptions {
  url?: string;
  pairingUrl?: string;
  configDir?: string;
  thread?: string;
  help: boolean;
  demo: boolean;
}

export function parseCli(args: readonly string[]): CliOptions {
  const options: CliOptions = { help: false, demo: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--demo") options.demo = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
      switch (argument) {
        case "--connect":
          options.url = value;
          break;
        case "--pair":
          options.pairingUrl = value;
          break;
        case "--config-dir":
          options.configDir = value;
          break;
        case "--thread":
          options.thread = value;
          break;
        default:
          throw new Error(`Unknown option: ${argument}. Use --help.`);
      }
    }
  }
  return options;
}

export const help = `T3 Code terminal client

Usage: t3-tui [--connect URL] [--pair PAIRING_URL] [--thread ID]

  --connect URL      Connect to a running T3 server (local or remote)
  --pair URL         Pair using a fresh server pairing URL
  --config-dir DIR   Store terminal client connections in DIR
  --thread ID        Open a thread after connecting
  --demo             Explore the interface with offline example data
  --help, -h         Print this help

T3_TUI_URL provides the default server URL. T3_TUI_TOKEN supplies an existing
bearer credential without putting it in shell history. Press Ctrl+P for commands,
Ctrl+T for threads, Ctrl+N for a new thread, and Ctrl+Q to exit.
`;
