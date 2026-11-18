import type {
  KnownComposerContextRecord,
  MentionContextRecord,
  OrchestrationV2PromptSuggestion,
  OrchestrationV2Run,
  RunId,
} from "@t3tools/contracts";
import type { LocalAttachment } from "../runtime/attachments.ts";

export interface Draft {
  text: string;
  mentions: ReadonlyArray<MentionContextRecord>;
  context: ReadonlyArray<KnownComposerContextRecord>;
  attachments: ReadonlyArray<LocalAttachment>;
  freshContext: boolean;
}

export function hasDraftContent(draft: Draft) {
  return draft.text.length > 0 || draft.attachments.length > 0 || draft.freshContext;
}

export function promptSuggestionForLatestRun(
  suggestion: OrchestrationV2PromptSuggestion,
  latestRunId: RunId | null | undefined,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>,
) {
  return suggestion?.runId === latestRunId &&
    runs.some((run) => run.id === latestRunId && run.status === "completed")
    ? suggestion
    : null;
}

export function settleSentDraft(current: Draft, sent: Draft): Draft {
  const unchanged = current.text === sent.text;
  return {
    text: unchanged ? "" : current.text,
    mentions: unchanged ? [] : current.mentions,
    context: unchanged ? [] : current.context,
    attachments: current.attachments.filter(
      (attachment) => !sent.attachments.some((value) => value.id === attachment.id),
    ),
    freshContext: current.freshContext && !sent.freshContext,
  };
}
