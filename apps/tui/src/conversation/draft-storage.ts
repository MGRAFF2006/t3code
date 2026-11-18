// @effect-diagnostics nodeBuiltinImport:off -- Terminal draft persistence owns private local files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  COMPOSER_CONTEXT_MAX_RECORDS,
  KnownComposerContextRecord,
  MentionContextRecord,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { hasDraftContent, type Draft } from "./draft.ts";

const LocalAttachment = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(128)),
  path: Schema.String.check(Schema.isMaxLength(4096)),
  name: Schema.String.check(Schema.isMaxLength(255)),
  type: Schema.Literals(["file", "image"]),
  mimeType: Schema.String.check(Schema.isMaxLength(100)),
  sizeBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  modifiedAtMs: Schema.Number,
});
const DraftSchema = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(1_000_000)),
  mentions: Schema.Array(MentionContextRecord).check(
    Schema.isMaxLength(COMPOSER_CONTEXT_MAX_RECORDS),
  ),
  context: Schema.Array(KnownComposerContextRecord).check(
    Schema.isMaxLength(COMPOSER_CONTEXT_MAX_RECORDS),
  ),
  attachments: Schema.Array(LocalAttachment).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
  freshContext: Schema.Boolean,
});
const StashEntrySchema = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(128)),
  scope: Schema.String.check(Schema.isMaxLength(4096)),
  label: Schema.String.check(Schema.isMaxLength(200)),
  draft: DraftSchema,
});
const DocumentSchema = Schema.Struct({
  version: Schema.Literal(1),
  drafts: Schema.Record(Schema.String, DraftSchema).check(
    Schema.makeFilter((value) => Object.keys(value).length <= 200),
  ),
  stash: Schema.Array(StashEntrySchema).check(Schema.isMaxLength(50)),
});
type Document = typeof DocumentSchema.Type;
export type StashEntry = typeof StashEntrySchema.Type;
const isDocument = Schema.is(DocumentSchema);
const empty = (): Document => ({ version: 1, drafts: {}, stash: [] });
const MAX_BYTES = 16 * 1024 * 1024;

function mergeDrafts(saved: Document["drafts"], changed: ReadonlyMap<string, Draft>) {
  const next = { ...saved };
  for (const [scope, draft] of changed) {
    if (hasDraftContent(draft)) next[scope] = draft;
    else delete next[scope];
  }
  return next;
}

async function readDocument(filename: string): Promise<Document> {
  let contents: string;
  try {
    const handle = await NodeFSP.open(filename, "r");
    try {
      if ((await handle.stat()).size > MAX_BYTES)
        throw new Error("Saved TUI drafts exceed the storage size limit.");
      contents = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return empty();
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Saved TUI drafts could not be read. The file was left unchanged.");
  }
  if (!isDocument(value))
    throw new Error("Saved TUI drafts are invalid. The file was left unchanged.");
  return value;
}

async function acquireLock(filename: string) {
  const handle = await NodeFSP.open(filename, "a", 0o600);
  await handle.close();
  const Database = process.versions.bun
    ? (await import("bun:sqlite")).Database
    : (await import("node:sqlite")).DatabaseSync;
  // This permanent file is never unlinked: the OS releases its transaction lock on exit.
  for (let attempt = 0; attempt < 200; attempt++) {
    const database = new Database(filename);
    try {
      database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
      return database;
    } catch (error) {
      database.close();
      if (
        !(error instanceof Error) ||
        !(
          ("errcode" in error && error.errcode === 5) ||
          ("code" in error && error.code === "SQLITE_BUSY")
        )
      )
        throw error;
    }
    await Effect.runPromise(Effect.sleep("25 millis"));
  }
  throw new Error(
    "TUI drafts are busy in another terminal. Your unsaved prompt is still available; retry saving.",
  );
}

export function createDraftStore(directory: string, onError: (message: string) => void) {
  const filename = NodePath.join(directory, "drafts.json");
  let document = empty();
  const pending = new Map<string, Draft>();
  const stashOperations: Array<(entries: ReadonlyArray<StashEntry>) => ReadonlyArray<StashEntry>> =
    [];
  let scheduled: Fiber.Fiber<void> | undefined;
  let writing = Promise.resolve();
  let ordinal = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const ready = readDocument(filename).then((saved) => {
    document = {
      ...saved,
      drafts: mergeDrafts(saved.drafts, pending),
      stash: stashOperations.reduce((entries, apply) => apply(entries), saved.stash),
    };
    notify();
  });
  const report = (error: unknown) =>
    onError(error instanceof Error ? error.message : "Could not save TUI drafts.");
  void ready.catch(report);
  const flush = () => {
    if (scheduled) {
      Effect.runFork(Fiber.interrupt(scheduled));
      scheduled = undefined;
    }
    writing = writing
      .catch(() => undefined)
      .then(async () => {
        await ready;
        if (pending.size === 0 && stashOperations.length === 0) return;
        const changed = new Map(pending);
        const operations = [...stashOperations];
        await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
        const lock = await acquireLock(`${filename}.lock.sqlite`);
        const temporary = `${filename}.${process.pid}.${ordinal++}.tmp`;
        let next: Document;
        try {
          const latest = await readDocument(filename);
          next = {
            version: 1,
            drafts: mergeDrafts(latest.drafts, changed),
            stash: operations.reduce((entries, apply) => apply(entries), latest.stash),
          };
          const encoded = JSON.stringify(next);
          if (!isDocument(next) || Buffer.byteLength(encoded) > MAX_BYTES)
            throw new Error(
              "TUI draft storage is full. Remove saved prompts or shorten the draft before saving more.",
            );
          await NodeFSP.writeFile(temporary, encoded, { mode: 0o600, flag: "wx" });
          await NodeFSP.rename(temporary, filename);
        } finally {
          try {
            await NodeFSP.rm(temporary, { force: true });
          } finally {
            lock.close();
          }
        }
        for (const [scope, value] of changed)
          if (pending.get(scope) === value) pending.delete(scope);
        stashOperations.splice(0, operations.length);
        document = {
          ...next,
          drafts: mergeDrafts(next.drafts, pending),
          stash: stashOperations.reduce((entries, apply) => apply(entries), next.stash),
        };
        notify();
      });
    return writing;
  };
  const schedule = () => {
    if (scheduled) Effect.runFork(Fiber.interrupt(scheduled));
    scheduled = Effect.runFork(
      Effect.sleep("300 millis").pipe(
        Effect.andThen(
          Effect.promise(async () => {
            scheduled = undefined;
            await flush().catch(report);
          }),
        ),
      ),
    );
  };
  return {
    ready,
    refresh: () => {
      writing = writing
        .catch(() => undefined)
        .then(async () => {
          await ready;
          const latest = await readDocument(filename);
          document = {
            ...latest,
            drafts: mergeDrafts(latest.drafts, pending),
            stash: stashOperations.reduce((entries, apply) => apply(entries), latest.stash),
          };
          notify();
        });
      return writing;
    },
    get: (scope: string): Draft | undefined => document.drafts[scope],
    stash: () => document.stash,
    save: (scope: string, draft: Draft) => {
      pending.set(scope, draft);
      document = { ...document, drafts: mergeDrafts(document.drafts, new Map([[scope, draft]])) };
      schedule();
    },
    stashDraft: (entry: StashEntry) => {
      if (document.stash.length >= 50)
        throw new Error("The prompt stash is full. Remove a saved prompt first.");
      const append = (entries: ReadonlyArray<StashEntry>) => [
        ...entries.filter((value) => value.id !== entry.id),
        entry,
      ];
      stashOperations.push(append);
      document = { ...document, stash: append(document.stash) };
      notify();
      schedule();
    },
    removeStash: (id: string) => {
      const remove = (entries: ReadonlyArray<StashEntry>) =>
        entries.filter((entry) => entry.id !== id);
      stashOperations.push(remove);
      document = { ...document, stash: remove(document.stash) };
      notify();
      schedule();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flush,
  };
}

const stores = new Map<string, ReturnType<typeof createDraftStore>>();
export function draftStore(directory: string, onError: (message: string) => void) {
  let store = stores.get(directory);
  if (!store) {
    store = createDraftStore(directory, onError);
    stores.set(directory, store);
  }
  return store;
}
