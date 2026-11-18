import { expect, it } from "@effect/vitest";
import type { MentionContextRecord } from "@t3tools/contracts";
import {
  toKindScopedComposerContextId,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { resolveFileMentions } from "./context.ts";

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
