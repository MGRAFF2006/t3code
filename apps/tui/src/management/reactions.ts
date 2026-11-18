import type { PullRequestReaction, PullRequestReactionContent } from "@t3tools/contracts";
import type { FeatureProps } from "../ui/controller.ts";

const labels: Record<PullRequestReactionContent, string> = {
  "thumbs-up": "Thumbs up",
  "thumbs-down": "Thumbs down",
  laugh: "Laugh",
  hooray: "Celebrate",
  confused: "Confused",
  heart: "Heart",
  rocket: "Rocket",
  eyes: "Eyes",
};

export function reactionActions(
  props: FeatureProps,
  reactions: ReadonlyArray<PullRequestReaction> | undefined,
  update: (content: PullRequestReactionContent, reacted: boolean) => Promise<unknown>,
) {
  props.ui.choose(
    "Reactions",
    (Object.entries(labels) as [PullRequestReactionContent, string][]).map(([content, label]) => {
      const current = reactions?.find((reaction) => reaction.content === content);
      return {
        title: `${current?.viewerHasReacted ? "Remove" : "Add"} ${label.toLowerCase()}`,
        description: current
          ? `${current.count} reactions${current.actors.length ? ` · ${current.actors.join(", ")}` : ""}`
          : undefined,
        run: () =>
          void props.ui.run(() => update(content, !current?.viewerHasReacted), "Reaction updated."),
      };
    }),
  );
}
