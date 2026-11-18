// @effect-diagnostics nodeBuiltinImport:off -- Exercises local preferences in an owned temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createPreferences } from "./preferences.ts";

const withDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-preferences-"))),
    use,
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
  );

describe("terminal preferences", () => {
  it.effect(
    "merges independent terminal windows and serializes local updates without changing connection credentials",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          const credentialFile = NodePath.join(directory, "connections.json");
          const credentials = '{"version":1,"credentials":["test-credential"]}';
          yield* Effect.promise(() => NodeFSP.writeFile(credentialFile, credentials));
          const first = yield* Effect.promise(() => createPreferences(directory));
          const second = yield* Effect.promise(() => createPreferences(directory));
          const changes: string[] = [];
          const unsubscribe = first.subscribe((preferences) => changes.push(preferences.theme));
          yield* Effect.promise(() => first.update({ theme: "light" }));
          yield* Effect.promise(() => second.update({ sendShortcut: "ctrl-s" }));
          yield* Effect.promise(() =>
            Promise.all([
              first.update({ wordWrap: false }),
              first.update({ diffView: "split", followUpMode: "steer" }),
            ]),
          );
          unsubscribe();
          const reopened = yield* Effect.promise(() => createPreferences(directory));
          expect(reopened.get()).toEqual({
            theme: "light",
            sendShortcut: "ctrl-s",
            wordWrap: false,
            diffView: "split",
            followUpMode: "steer",
          });
          expect(changes).toEqual(["dark", "light", "light", "light"]);
          expect(yield* Effect.promise(() => NodeFSP.readFile(credentialFile, "utf8"))).toBe(
            credentials,
          );
          expect((yield* Effect.promise(() => NodeFSP.stat(directory))).mode & 0o777).toBe(0o700);
          expect(
            (yield* Effect.promise(() =>
              NodeFSP.stat(NodePath.join(directory, "preferences.json")),
            )).mode & 0o777,
          ).toBe(0o600);
        }),
      ),
  );

  it.effect(
    "leaves damaged documents unchanged and refuses to overwrite a concurrently locked file",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          const preferences = yield* Effect.promise(() => createPreferences(directory));
          yield* Effect.promise(() => preferences.update({ theme: "light" }));
          const filename = NodePath.join(directory, "preferences.json");
          const saved = yield* Effect.promise(() => NodeFSP.readFile(filename, "utf8"));
          yield* Effect.promise(() =>
            NodeFSP.writeFile(`${filename}.lock`, "another writer", { mode: 0o600 }),
          );
          yield* Effect.promise(async () => {
            await expect(preferences.update({ theme: "dark" })).rejects.toThrow(
              "Could not lock terminal preferences",
            );
          });
          expect(yield* Effect.promise(() => NodeFSP.readFile(filename, "utf8"))).toBe(saved);
          yield* Effect.promise(() => NodeFSP.rm(`${filename}.lock`));
          yield* Effect.promise(() => preferences.update({ wordWrap: false }));
          const damaged = '{"version":1,"settings":{"theme":"invalid-theme"}}';
          yield* Effect.promise(() => NodeFSP.writeFile(filename, damaged));
          yield* Effect.promise(async () => {
            await expect(createPreferences(directory)).rejects.toThrow(
              "The file was left unchanged",
            );
            await expect(preferences.update({ theme: "dark" })).rejects.toThrow(
              "The file was left unchanged",
            );
          });
          expect(yield* Effect.promise(() => NodeFSP.readFile(filename, "utf8"))).toBe(damaged);
          expect(preferences.get().theme).toBe("light");
        }),
      ),
  );
});
