import { WS_METHODS } from "@t3tools/contracts";
import type { FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { destinationGuard } from "./common.tsx";

const inFlight = new Set<string>();

export function providerFeedbackActions(props: FeatureProps) {
  const thread = props.state()?.thread?.thread;
  const provider = props
    .state()
    ?.config?.providers.find((entry) => entry.instanceId === thread?.providerInstanceId);
  if (!thread || provider?.driver !== "codex" || !thread.activeProviderThreadId) {
    props.ui.notify(
      "Open a Codex conversation with a provider session before uploading feedback.",
      true,
    );
    return;
  }
  const guard = destinationGuard(props);
  const key = `${props.state()?.environmentId}/${thread.id}`;
  props.ui.form({
    title: "Upload Codex feedback",
    description:
      "Upload this thread's provider diagnostics to Codex. The feedback ID is returned after submission.",
    fields: [{ name: "reason", label: "Feedback (optional)", type: "multiline" }],
    submitLabel: "Upload feedback",
    onSubmit: async ({ reason = "" }) => {
      guard();
      if (inFlight.has(key)) throw new Error("Feedback for this thread is already uploading.");
      inFlight.add(key);
      try {
        const result = await request(props.client, WS_METHODS.providerUploadFeedback, {
          threadId: thread.id,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        });
        guard();
        props.ui.text("Codex feedback uploaded", `Feedback ID: ${result.feedbackId}`);
      } finally {
        inFlight.delete(key);
      }
    },
  });
}
