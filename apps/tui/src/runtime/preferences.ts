// @effect-diagnostics nodeBuiltinImport:off -- Local terminal preferences share the existing private client state directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  preparePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from "../connections/files.ts";

const Preferences = Schema.Struct({
  theme: Schema.Literals(["dark", "light"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("dark")),
  ),
  sendShortcut: Schema.Literals(["enter", "ctrl-s"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("enter")),
  ),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffView: Schema.Literals(["unified", "split"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("unified")),
  ),
  followUpMode: Schema.Literals(["queue", "steer"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("queue")),
  ),
});
export type TuiPreferences = typeof Preferences.Type;
export type TuiPreferencesPatch = Partial<TuiPreferences>;
const decodePreferences = Schema.decodeSync(Preferences);
const Document = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), settings: Preferences }),
);
const decodeDocument = Schema.decodeSync(Document);
const encodeDocument = Schema.encodeSync(Document);
export const DEFAULT_TUI_PREFERENCES: TuiPreferences = decodePreferences({});

export async function createPreferences(configDir: string) {
  const filename = NodePath.join(configDir, "preferences.json");
  await preparePrivateDirectory(configDir);
  async function read() {
    try {
      const contents = await readPrivateFile(filename);
      return contents === null ? DEFAULT_TUI_PREFERENCES : decodeDocument(contents).settings;
    } catch (error) {
      throw new Error(
        `Could not read terminal preferences at ${filename}. The file was left unchanged.`,
        { cause: error },
      );
    }
  }
  let preferences = await read();
  const listeners = new Set<(value: TuiPreferences) => void>();
  let pending: Promise<unknown> = Promise.resolve();
  function update(patch: TuiPreferencesPatch): Promise<TuiPreferences> {
    const save = pending.then(async () => {
      if (Object.keys(patch).some((key) => !Object.hasOwn(DEFAULT_TUI_PREFERENCES, key)))
        throw new Error("Unknown terminal preference.");
      const lockPath = `${filename}.lock`;
      let lock;
      try {
        lock = await NodeFSP.open(lockPath, "wx", 0o600);
      } catch (error) {
        throw new Error(
          `Could not lock terminal preferences at ${filename}. Retry after other TUI writes finish.`,
          { cause: error },
        );
      }
      try {
        const latest = await read();
        const next = decodePreferences({ ...latest, ...patch });
        await writePrivateFile(filename, encodeDocument({ version: 1, settings: next }));
        preferences = next;
        for (const listener of listeners) listener(next);
        return next;
      } finally {
        await lock.close();
        await NodeFSP.rm(lockPath, { force: true });
      }
    });
    pending = save.catch(() => undefined);
    return save;
  }
  return {
    get: () => preferences,
    update,
    subscribe: (listener: (value: TuiPreferences) => void) => {
      listeners.add(listener);
      listener(preferences);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
