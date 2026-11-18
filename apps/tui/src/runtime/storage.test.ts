// @effect-diagnostics nodeBuiltinImport:off -- Exercises private credential files in an owned temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { BearerConnectionCredential, CredentialStore } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createStorage } from "./storage.ts";

const withStorageDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-storage-"))),
    use,
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
  );

describe("TUI credential storage", () => {
  it.effect("persists concurrent credential updates atomically with private permissions", () =>
    withStorageDirectory((directory) =>
      Effect.gen(function* () {
        const layer = yield* Effect.promise(() => createStorage(directory));
        const otherWindow = yield* Effect.promise(() => createStorage(directory));
        yield* Effect.gen(function* () {
          const credentials = yield* CredentialStore.ConnectionCredentialStore;
          yield* Effect.all(
            [
              credentials.put(
                "first",
                new BearerConnectionCredential({ token: "first-test-token" }),
              ),
              credentials.put(
                "second",
                new BearerConnectionCredential({ token: "second-test-token" }),
              ),
            ],
            { concurrency: "unbounded" },
          );
        }).pipe(Effect.provide(layer));
        yield* Effect.gen(function* () {
          const credentials = yield* CredentialStore.ConnectionCredentialStore;
          yield* credentials.put(
            "third",
            new BearerConnectionCredential({ token: "third-test-token" }),
          );
        }).pipe(Effect.provide(otherWindow));
        const loaded = yield* Effect.promise(() => createStorage(directory));
        const saved = yield* Effect.gen(function* () {
          const credentials = yield* CredentialStore.ConnectionCredentialStore;
          return [
            yield* credentials.get("first"),
            yield* credentials.get("second"),
            yield* credentials.get("third"),
          ];
        }).pipe(Effect.provide(loaded));
        expect(saved.map((value) => Option.map(value, (credential) => credential.token))).toEqual([
          Option.some("first-test-token"),
          Option.some("second-test-token"),
          Option.some("third-test-token"),
        ]);
        expect((yield* Effect.promise(() => NodeFSP.stat(directory))).mode & 0o777).toBe(0o700);
        expect(
          (yield* Effect.promise(() => NodeFSP.stat(NodePath.join(directory, "connections.json"))))
            .mode & 0o777,
        ).toBe(0o600);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(directory, ".gitignore"), "utf8"),
          ),
        ).toContain("*");
      }),
    ),
  );

  it.effect("rejects damaged credential documents without overwriting them", () =>
    withStorageDirectory((directory) =>
      Effect.gen(function* () {
        const filename = NodePath.join(directory, "connections.json");
        const damaged = '{"credentials":[{"token":"private-test-token"}]}';
        yield* Effect.promise(() => NodeFSP.writeFile(filename, damaged));
        const result = yield* Effect.tryPromise({
          try: () => createStorage(directory),
          catch: (cause) => (cause instanceof Error ? cause.message : "invalid-document"),
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure).not.toContain("private-test-token");
        expect(yield* Effect.promise(() => NodeFSP.readFile(filename, "utf8"))).toBe(damaged);
      }),
    ),
  );
});
