import { CommandId, ORCHESTRATION_V2_WS_METHODS, ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { destinationGuard } from "./common.tsx";

export function guestShareActions(props: FeatureProps, threadId: string) {
  const guard = destinationGuard(props);
  const thread = props.state()?.thread?.thread;
  if (thread?.id !== threadId) {
    props.ui.notify("Open this thread to manage its guest link and proposed messages.", true);
    return;
  }
  const share = thread.guestShare;
  const options: Choice[] = [
    {
      title: share ? "Show guest link" : "Create guest link",
      description:
        "One guest can watch this thread and propose messages you approve before sending.",
      run: () =>
        void props.ui.run(async () => {
          guard();
          const result = await request(props.client, WS_METHODS.guestShareCreate, {
            threadId: ThreadId.make(threadId),
          });
          guard();
          props.ui.text(
            "Guest link",
            `${result.url}\n\nExpires: ${result.share.expiresAt}\n\nShare this private link with your guest. Proposed messages require your approval.`,
          );
        }),
    },
  ];
  if (share) {
    options.push({
      title: "Close guest link",
      description: share.guestName ? `Guest: ${share.guestName}` : "No guest has joined yet.",
      run: () =>
        props.ui.confirm(
          "Close guest link",
          "Disconnect this guest and stop accepting proposed messages?",
          async () => {
            guard();
            await request(props.client, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
              type: "thread.guest-share.close",
              commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
              threadId: ThreadId.make(threadId),
            });
          },
          "Close link",
        ),
    });
    for (const message of share.messages.filter((message) => message.status === "pending")) {
      options.push({
        title: `Guest: ${message.text || "Attachments"}`,
        description: `${message.attachments?.length ?? 0} attachments · ${message.submittedAt}`,
        run: () =>
          props.ui.choose("Proposed guest message", [
            {
              title: "Read proposed message",
              run: () =>
                props.ui.text(
                  "Guest message",
                  `${message.text}\n\n${(message.attachments ?? []).map((attachment) => attachment.name).join("\n")}`,
                ),
            },
            {
              title: "Send to agent",
              description:
                "Queue the guest's original text and attachments after the current turn.",
              run: () =>
                props.ui.confirm(
                  "Send guest message",
                  message.text || "Send the guest's attached files to the agent?",
                  async () => {
                    guard();
                    await props.client.resolveGuestMessage(threadId, message.id, "send");
                  },
                  "Send message",
                ),
            },
            {
              title: "Dismiss message",
              run: () =>
                props.ui.confirm(
                  "Dismiss guest message",
                  "Discard this proposed message and its attachments?",
                  async () => {
                    guard();
                    await props.client.resolveGuestMessage(threadId, message.id, "dismiss");
                  },
                  "Dismiss",
                ),
            },
          ]),
      });
    }
  }
  props.ui.choose("Guest sharing", options);
}
