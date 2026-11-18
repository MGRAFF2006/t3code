import {
  CommandId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { request } from "../rpc/request.ts";
import type { FeatureProps } from "../ui/controller.ts";

export async function threadRelationships(props: FeatureProps, target: OrchestrationV2ThreadShell) {
  const environment = props.state()?.environmentId;
  const guard = () => {
    if (!environment || props.state()?.environmentId !== environment)
      throw new Error("The environment changed. Open thread relationships again.");
  };
  guard();
  const current = props.state()?.thread;
  const projection =
    current?.thread.id === target.id
      ? current
      : await request(props.client, ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
          threadId: target.id,
        });
  const family = await request(props.client, ORCHESTRATION_V2_WS_METHODS.getThreadFamily, {
    threadId: target.id,
  });
  guard();
  const parent =
    projection.thread.lineage.parentThreadId ??
    (projection.thread.forkedFrom?.type === "run" ? projection.thread.forkedFrom.threadId : null);
  props.ui.choose("Related threads and context", [
    ...projection.subagents.map((agent) => ({
      title: agent.title ?? agent.id,
      description: `${agent.status} · ${agent.executedModel ?? agent.model ?? agent.driver}`,
      run: () =>
        props.ui.choose(agent.title ?? "Subagent", [
          {
            title: "Task and result",
            run: () =>
              props.ui.text(
                agent.title ?? "Subagent",
                [agent.prompt, agent.progress, agent.result].filter(Boolean).join("\n\n"),
              ),
          },
          ...(agent.childThreadId && agent.origin === "app_owned"
            ? [
                {
                  title: "Open child conversation",
                  run: () => props.ui.openThread(agent.childThreadId!),
                },
              ]
            : []),
          ...(["pending", "running", "waiting"].includes(agent.status)
            ? [
                {
                  title: "Stop task",
                  run: () =>
                    props.ui.confirm(
                      "Stop subagent",
                      "Stop this task through its owning T3 provider.",
                      async () => {
                        guard();
                        if (agent.workflow)
                          await request(props.client, ORCHESTRATION_V2_WS_METHODS.stopWorkflow, {
                            threadId: target.id,
                            subagentId: agent.id,
                          });
                        else await props.client.stopSubagent(target.id, agent.id);
                      },
                      "Stop task",
                    ),
                },
              ]
            : []),
        ]),
    })),
    {
      title: "Provider-native child work…",
      run: () =>
        void props.ui.run(async () => {
          guard();
          const work = await request(props.client, ORCHESTRATION_V2_WS_METHODS.getNativeChildWork, {
            threadId: target.id,
          });
          guard();
          props.ui.choose(
            "Provider-native child work",
            work.children.map((child) => ({
              title: child.role,
              description: child.prompt,
              run: () => props.ui.text(child.role, JSON.stringify(child, null, 2)),
            })),
          );
        }),
    },
    ...(parent
      ? [{ title: "Open source conversation", run: () => props.ui.openThread(parent) }]
      : []),
    {
      title: "Start side conversation…",
      description: "Fork the latest stable context into a separate conversation.",
      run: () =>
        props.ui.form({
          title: "Start side conversation",
          fields: [
            {
              name: "title",
              label: "Title",
              value: `${target.title} (side conversation)`,
              required: true,
            },
          ],
          onSubmit: async ({ title = "" }) => {
            guard();
            const id = ThreadId.make(SecureRandom.uuidV4Unsafe());
            await request(props.client, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
              type: "thread.fork",
              commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
              sourceThreadId: target.id,
              targetThreadId: id,
              sourcePoint: { type: "latest_stable" },
              title: title.trim(),
              sideChat: true,
              createdBy: "user",
              creationSource: "web",
            });
            guard();
            props.ui.openThread(id);
          },
        }),
    },
    {
      title: parent ? "Merge context back to source…" : "Merge context into another conversation…",
      description: "Transfer the latest stable context using T3's existing merge workflow.",
      run: () => {
        const targets =
          props
            .state()
            ?.shell?.threads.filter((thread) => thread.id !== target.id && !thread.archivedAt) ??
          [];
        props.ui.choose(
          "Merge context into",
          targets
            .sort((a, b) => Number(b.id === parent) - Number(a.id === parent))
            .map((destination) => ({
              title: destination.title,
              description: destination.id === parent ? "Source conversation" : undefined,
              run: () =>
                props.ui.confirm(
                  "Merge conversation context",
                  `Merge the latest stable context from ${target.title} into ${destination.title}.`,
                  async () => {
                    guard();
                    await request(props.client, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
                      type: "thread.merge_back",
                      commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
                      sourceThreadId: target.id,
                      targetThreadId: destination.id,
                      sourcePoint: { type: "latest_stable" },
                      createdBy: "user",
                      creationSource: "web",
                    });
                    props.ui.notify("Context transfer requested.");
                  },
                  "Merge context",
                ),
            })),
        );
      },
    },
    ...projection.contextTransfers.map((transfer) => ({
      title: transfer.type.replaceAll("_", " "),
      description: `${transfer.status} · ${transfer.sourceThreadId} → ${transfer.targetThreadId}`,
      run: () => props.ui.text("Context transfer", JSON.stringify(transfer, null, 2)),
    })),
    ...family.threads
      .filter((thread) => thread.id !== target.id)
      .map((thread) => ({
        title: thread.title,
        description:
          thread.lineage.parentThreadId === target.id
            ? "Child conversation"
            : "Related conversation",
        run: () => props.ui.openThread(thread.id),
      })),
  ]);
}
