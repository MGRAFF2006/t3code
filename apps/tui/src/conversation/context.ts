import type { MentionContextRecord } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";

export function resolveFileMentions(text: string, mentions: ReadonlyArray<MentionContextRecord>) {
  const candidates = mentions.toSorted((left, right) => right.path.length - left.path.length);
  if (candidates.length === 0) return { text, records: [] as MentionContextRecord[] };
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(^|[\\s([{])@(${candidates.map((record) => escape(record.path)).join("|")})(?=$|[\\s,;!?)}\\]]|\\.(?=\\s|$))`,
    "g",
  );
  const used = new Set<MentionContextRecord>();
  const rewritten = text.replace(pattern, (_match, prefix: string, path: string) => {
    const record = candidates.find((candidate) => candidate.path === path)!;
    used.add(record);
    return `${prefix}${formatComposerContextReference(record)}`;
  });
  return { text: rewritten, records: mentions.filter((record) => used.has(record)) };
}
