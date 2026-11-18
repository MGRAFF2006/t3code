import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type MentionContextRecord } from "@t3tools/contracts";
import {
  toKindScopedComposerContextId,
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { referencedDraftContext, resolveFileMentions } from "./context.ts";

it("preserves distinct file mentions with overlapping paths and ignores path prefixes and email text", () => {
  const record = (path: string): MentionContextRecord => ({
    version: 1,
    kind: "mention",
    contextId: toKindScopedComposerContextId("mention", path),
    label: path,
    path,
  });
  const short = record("src/foo");
  const long = record("src/foo.test.ts");
  const spaced = record("src/My File.ts");
  const special = record("src/a+b[1].ts");
  expect(resolveFileMentions("Read @src/a+b[1].ts and @src/aab1Xts", [special])).toEqual({
    text: `Read ${formatComposerContextReference(special)} and @src/aab1Xts`,
    records: [special],
  });
  expect(
    resolveFileMentions("Compare @src/foo and @src/foo.test.ts (@src/My File.ts).", [
      short,
      long,
      spaced,
    ]),
  ).toEqual({
    text: `Compare ${formatComposerContextReference(short)} and ${formatComposerContextReference(long)} (${formatComposerContextReference(spaced)}).`,
    records: [short, long, spaced],
  });
  expect(resolveFileMentions("Only @src/foo.test.ts and mail@src/foo", [short, long])).toEqual({
    text: `Only ${formatComposerContextReference(long)} and mail@src/foo`,
    records: [long],
  });
});

it("sends structured context only while its identity remains referenced in the edited message", () => {
  const first = threadContextRecord(
    { environmentId: EnvironmentId.make("environment-a"), threadId: ThreadId.make("thread-a") },
    "Same title",
  );
  const second = threadContextRecord(
    { environmentId: EnvironmentId.make("environment-a"), threadId: ThreadId.make("thread-b") },
    "Same title",
  );
  expect(
    referencedDraftContext(`Use ${formatComposerContextReference(second)}`, [first, second]),
  ).toEqual([second]);
  expect(referencedDraftContext("Use Same title as plain text", [first, second])).toEqual([]);
});
