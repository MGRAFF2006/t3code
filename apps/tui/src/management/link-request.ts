import {
  WS_METHODS,
  type AuthMcpClientAccess,
  type PeerLinkRequestAnswerInput,
} from "@t3tools/contracts";
import {
  linkRequestAnswerInput,
  linkRequestDefaultAccess,
  linkRequestFailureMessage,
  type LinkRequestItem,
} from "@t3tools/client-runtime/link-request";
import type { FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { destinationGuard } from "./common.tsx";

export function answerLinkRequest(props: FeatureProps, item: LinkRequestItem) {
  if (item.linkStatus !== "pending") return;
  if (props.state()?.thread?.thread.id !== item.threadId) {
    props.ui.notify("Open the original thread to answer this environment link request.", true);
    return;
  }
  const guard = destinationGuard(props);
  const access = linkRequestDefaultAccess(item);
  async function answer(input: PeerLinkRequestAnswerInput | null) {
    guard();
    if (props.state()?.thread?.thread.id !== item.threadId)
      throw new Error("Return to the original thread to answer this link request.");
    if (!input) throw new Error("Enter the server address and pairing code.");
    try {
      await request(props.client, WS_METHODS.peerLinksAnswerRequest, input);
    } catch (error) {
      // oxlint-disable-next-line preserve-caught-error -- Transport causes may contain the private pairing code.
      throw new Error(linkRequestFailureMessage(error));
    }
    props.ui.notify(
      input.answer.type === "decline"
        ? "Environment link declined."
        : "Environment link request answered.",
    );
  }
  void props.ui.run(async () => {
    guard();
    const existing = await request(props.client, WS_METHODS.peerLinksList, {});
    guard();
    props.ui.choose("Link requested environment", [
      {
        title: "Link with a pairing code",
        description: item.reason,
        run: () =>
          props.ui.form({
            title: "Link requested environment",
            description: item.reason,
            fields: [
              { name: "url", label: "Server address", value: item.url ?? "", required: true },
              { name: "code", label: "Pairing code", required: true, type: "secret" },
              {
                name: "access",
                label: "Agent access",
                type: "select",
                value: access,
                options: (
                  [
                    "read-only",
                    "approval-required",
                    "auto-accept-edits",
                    "auto",
                    "full-access",
                  ] as const
                ).map((value) => ({ label: value, value })),
              },
            ],
            onSubmit: async (values) =>
              answer(
                linkRequestAnswerInput(item, {
                  type: "link",
                  target: { url: values.url ?? "" },
                  pairingCode: values.code ?? "",
                  access: (values.access ?? access) as AuthMcpClientAccess,
                }),
              ),
          }),
      },
      ...existing.links
        .filter((link) => link.status !== "expired")
        .map((link) => ({
          title: `Use existing link: ${link.label}`,
          description: `${link.access} · ${link.status}`,
          run: () =>
            void props.ui.run(() =>
              answer(
                linkRequestAnswerInput(item, {
                  type: "use-existing",
                  environmentId: link.environmentId,
                }),
              ),
            ),
        })),
      {
        title: "Decline request",
        run: () =>
          props.ui.confirm(
            "Decline environment link",
            item.reason,
            () => answer(linkRequestAnswerInput(item, { type: "decline" })),
            "Decline",
          ),
      },
    ]);
  });
}
