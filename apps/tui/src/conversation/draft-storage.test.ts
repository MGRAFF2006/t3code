// @effect-diagnostics nodeBuiltinImport:off -- Exercises terminal draft files in an owned temporary directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createDraftStore } from "./draft-storage.ts";
import type { Draft } from "./draft.ts";

const draft = (text: string): Draft => ({
  text,
  mentions: [],
  context: [],
  attachments: [],
  freshContext: false,
});

it.effect(
  "recovers scoped drafts, preserves edits made before hydration and independent writers, and removes empty sent drafts",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-drafts-"))),
      (directory) =>
        Effect.gen(function* () {
          const errors: string[] = [];
          const first = createDraftStore(directory, (message) => errors.push(message));
          const second = createDraftStore(directory, (message) => errors.push(message));
          yield* Effect.promise(() => Promise.all([first.ready, second.ready]));
          first.save("environment-a/thread-a", { ...draft("Original prompt"), freshContext: true });
          second.save("environment-b/thread-a", draft("Different environment"));
          yield* Effect.promise(async () => {
            const results = await Promise.allSettled([first.flush(), second.flush()]);
            for (const result of results) if (result.status === "rejected") throw result.reason;
          });
          const reopened = createDraftStore(directory, (message) => errors.push(message));
          reopened.save("environment-a/thread-a", draft("Typed while loading"));
          yield* Effect.promise(() => reopened.ready);
          expect(reopened.get("environment-a/thread-a")?.text).toBe("Typed while loading");
          expect(reopened.get("environment-b/thread-a")?.text).toBe("Different environment");
          reopened.stashDraft({
            id: "stash-1",
            scope: "environment-a/thread-a",
            label: "Reusable prompt",
            draft: draft("Keep this prompt"),
          });
          yield* Effect.promise(reopened.flush);
          yield* Effect.promise(second.refresh);
          expect(second.stash()[0]?.draft.text).toBe("Keep this prompt");
          const saved = createDraftStore(directory, (message) => errors.push(message));
          yield* Effect.promise(() => saved.ready);
          expect(saved.stash()[0]?.draft.text).toBe("Keep this prompt");
          saved.save("environment-a/thread-a", draft(""));
          saved.removeStash("stash-1");
          yield* Effect.promise(saved.flush);
          const final = createDraftStore(directory, (message) => errors.push(message));
          yield* Effect.promise(() => final.ready);
          expect(final.get("environment-a/thread-a")).toBeUndefined();
          expect(final.get("environment-b/thread-a")?.text).toBe("Different environment");
          expect(final.stash()).toEqual([]);
          expect(errors).toEqual([]);
          expect(
            (yield* Effect.promise(() => NodeFSP.stat(NodePath.join(directory, "drafts.json"))))
              .mode & 0o777,
          ).toBe(0o600);
        }),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
    ),
);

it.live("recovers after a lock holder dies without deleting a legacy lock artifact", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-drafts-crash-"))),
    (directory) =>
      Effect.promise(async () => {
        const filename = NodePath.join(directory, "drafts.json");
        const child = NodeChildProcess.spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
              import { writeFileSync } from "node:fs";
              import { DatabaseSync } from "node:sqlite";
              const filename = process.argv[1];
              writeFileSync(filename + ".lock", "legacy owner artifact", { mode: 0o600 });
              writeFileSync(filename + ".lock.sqlite", "", { mode: 0o600 });
              const db = new DatabaseSync(filename + ".lock.sqlite");
              db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
              process.on("message", () => {});
              process.send("locked");
            `,
            filename,
          ],
          { stdio: ["ignore", "ignore", "pipe", "ipc"] },
        );
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        try {
          await new Promise<void>((resolve, reject) => {
            child.once("message", () => resolve());
            child.once("error", reject);
            child.once("exit", (code, signal) =>
              reject(new Error(`Draft lock fixture exited before acquisition: ${code ?? signal}`)),
            );
          });
          child.kill("SIGKILL");
          await exited;
          const errors: string[] = [];
          const store = createDraftStore(directory, (message) => errors.push(message));
          await store.ready;
          store.save("environment/thread", draft("Recovered prompt"));
          await store.flush();
          const recovered = createDraftStore(directory, (message) => errors.push(message));
          await recovered.ready;
          expect(recovered.get("environment/thread")?.text).toBe("Recovered prompt");
          expect(await NodeFSP.readFile(`${filename}.lock`, "utf8")).toBe("legacy owner artifact");
          expect((await NodeFSP.stat(`${filename}.lock.sqlite`)).mode & 0o777).toBe(0o600);
          expect(errors).toEqual([]);
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await exited;
          }
        }
      }),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
  ),
);

it.effect(
  "leaves invalid saved drafts unchanged and reports failed writes without losing the in-memory prompt",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-drafts-invalid-")),
      ),
      (directory) =>
        Effect.gen(function* () {
          const errors: string[] = [];
          const store = createDraftStore(directory, (message) => errors.push(message));
          yield* Effect.promise(() => store.ready);
          const filename = NodePath.join(directory, "drafts.json");
          const invalid = '{"version":1,"drafts":{"bad":{"text":42}},"stash":[]}';
          yield* Effect.promise(() => NodeFSP.writeFile(filename, invalid));
          store.save("environment/thread", draft("Do not lose this"));
          yield* Effect.promise(async () => {
            await expect(store.flush()).rejects.toThrow("left unchanged");
          });
          expect(store.get("environment/thread")?.text).toBe("Do not lose this");
          expect(yield* Effect.promise(() => NodeFSP.readFile(filename, "utf8"))).toBe(invalid);
          const damaged = createDraftStore(directory, (message) => errors.push(message));
          yield* Effect.promise(async () => {
            await expect(damaged.ready).rejects.toThrow("left unchanged");
          });
          expect(errors).toHaveLength(1);
        }),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
    ),
);
