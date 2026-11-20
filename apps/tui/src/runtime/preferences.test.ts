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
          const fresh = yield* Effect.promise(() => createPreferences(directory));
          expect(fresh.get().theme).toBe("system");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(directory, "preferences.json"),
              '{"version":1,"settings":{"icons":"plain"}}',
            ),
          );
          const withoutAppearance = yield* Effect.promise(() => createPreferences(directory));
          expect(withoutAppearance.get().theme).toBe("system");
          expect(withoutAppearance.get().icons).toBe("plain");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(directory, "preferences.json"),
              '{"version":1,"settings":{"theme":"dark"}}',
            ),
          );
          const first = yield* Effect.promise(() => createPreferences(directory));
          expect(first.get().theme).toBe("dark");
          expect(first.get().timestampFormat).toBe("locale");
          expect(first.get().sidebarWidth).toBe(29);
          expect(first.get().workspaceWidth).toBeNull();
          const second = yield* Effect.promise(() => createPreferences(directory));
          const changes: string[] = [];
          const unsubscribe = first.subscribe((preferences) => changes.push(preferences.theme));
          yield* Effect.promise(() =>
            first.update({ theme: "light", timestampFormat: "12-hour", sidebarWidth: 44 }),
          );
          yield* Effect.promise(() =>
            second.update({ sendShortcut: "ctrl-s", workspaceWidth: 67 }),
          );
          yield* Effect.promise(() =>
            Promise.all([
              first.update({ wordWrap: false }),
              first.update({ diffView: "split", followUpMode: "steer", icons: "nerd" }),
            ]),
          );
          unsubscribe();
          const reopened = yield* Effect.promise(() => createPreferences(directory));
          expect(reopened.get()).toEqual({
            icons: "nerd",
            theme: "light",
            sendShortcut: "ctrl-s",
            wordWrap: false,
            diffView: "split",
            followUpMode: "steer",
            timestampFormat: "12-hour",
            sidebarWidth: 44,
            workspaceWidth: 67,
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
          yield* Effect.promise(() => reopened.update({ workspaceWidth: null }));
          const reset = yield* Effect.promise(() => createPreferences(directory));
          expect(reset.get().workspaceWidth).toBeNull();
          expect(reset.get().sidebarWidth).toBe(44);
          yield* Effect.promise(() => reset.update({ theme: "system" }));
          const automatic = yield* Effect.promise(() => createPreferences(directory));
          expect(automatic.get().theme).toBe("system");
          yield* Effect.promise(() => automatic.update({ theme: "dark" }));
          const manual = yield* Effect.promise(() => createPreferences(directory));
          expect(manual.get().theme).toBe("dark");
          expect(manual.get().sidebarWidth).toBe(44);
          expect(manual.get().wordWrap).toBe(false);
          expect(yield* Effect.promise(() => NodeFSP.readFile(credentialFile, "utf8"))).toBe(
            credentials,
          );
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
          yield* Effect.promise(async () => {
            for (const patch of [
              { sidebarWidth: 21 },
              { sidebarWidth: 44.5 },
              { workspaceWidth: 41 },
              { workspaceWidth: 1001 },
            ]) {
              await expect(preferences.update(patch)).rejects.toThrow();
              expect(await NodeFSP.readFile(filename, "utf8")).toBe(saved);
            }
          });
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
