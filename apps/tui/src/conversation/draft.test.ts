import { expect, it } from "@effect/vitest";
import { RunId } from "@t3tools/contracts";
import { promptSuggestionForLatestRun, settleSentDraft, type Draft } from "./draft.ts";

it("consumes a fresh-session arm only after its message was sent and preserves a newer follow-up", () => {
  const sent: Draft = {
    text: "Start again",
    mentions: [],
    context: [],
    attachments: [],
    freshContext: true,
  };
  expect(settleSentDraft(sent, sent)).toEqual({ ...sent, text: "", freshContext: false });
  expect(settleSentDraft({ ...sent, text: "A follow-up typed while uploading" }, sent)).toEqual({
    ...sent,
    text: "A follow-up typed while uploading",
    freshContext: false,
  });
  expect(settleSentDraft(sent, { ...sent, freshContext: false })).toMatchObject({
    freshContext: true,
  });
});

it("offers a next-prompt suggestion only for the latest completed run", () => {
  const first = RunId.make("first");
  const second = RunId.make("second");
  const suggestion = { runId: first, text: "Review the changes" };
  expect(
    promptSuggestionForLatestRun(suggestion, first, [{ id: first, status: "completed" }]),
  ).toBe(suggestion);
  expect(
    promptSuggestionForLatestRun(suggestion, second, [
      { id: first, status: "completed" },
      { id: second, status: "running" },
    ]),
  ).toBeNull();
  expect(
    promptSuggestionForLatestRun(suggestion, first, [{ id: first, status: "running" }]),
  ).toBeNull();
  expect(
    promptSuggestionForLatestRun(null, first, [{ id: first, status: "completed" }]),
  ).toBeNull();
});
