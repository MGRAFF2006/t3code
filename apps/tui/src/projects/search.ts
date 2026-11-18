import {
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  THREAD_SEARCH_QUERY_MAX_LENGTH,
} from "@t3tools/contracts";
import { request } from "../rpc/request.ts";
import type { FeatureProps } from "../ui/controller.ts";

export function conversationSearch(props: FeatureProps, projectId?: string) {
  const environmentId = props.state()?.environmentId;
  props.ui.form({
    title: projectId ? "Search project conversations" : "Search conversations",
    description: "Search user and agent messages, including older stopped threads.",
    fields: [{ name: "query", label: "Words or phrase", required: true }],
    submitLabel: "Search",
    onSubmit: async ({ query = "" }) => {
      const value = query.trim();
      if (value.length < 2 || value.length > THREAD_SEARCH_QUERY_MAX_LENGTH) {
        throw new Error(`Enter 2 to ${THREAD_SEARCH_QUERY_MAX_LENGTH} characters.`);
      }
      if (props.state()?.environmentId !== environmentId)
        throw new Error("The environment changed. Search again in the selected environment.");
      const scoped = props.state()?.config?.shellOlderSettled === true;
      const result = await request(props.client, ORCHESTRATION_V2_WS_METHODS.searchThreads, {
        query: value,
        limit: 50,
        ...(scoped
          ? {
              environmentLabel: props.state()?.label ?? "",
              ...(projectId ? { projectIds: [ProjectId.make(projectId)] } : {}),
            }
          : {}),
      });
      if (props.state()?.environmentId !== environmentId) return;
      const shell = props.state()?.shell;
      const threads = [
        ...(result.threads ?? []),
        ...(shell?.threads ?? []),
        ...(shell?.archivedThreads ?? []),
      ];
      const matches = result.matches.filter((match) => !projectId || match.projectId === projectId);
      if (projectId && !scoped)
        props.ui.notify(
          "This older server searches the newest 50 matches before filtering by project.",
        );
      props.ui.choose(
        `${matches.length}${result.matches.length === 50 ? "+" : ""} matching conversations`,
        matches.map((match) => ({
          title: threads.find((thread) => thread.id === match.threadId)?.title ?? match.threadId,
          category:
            shell?.projects.find((project) => project.id === match.projectId)?.title ??
            "Conversation",
          description: `${match.source === "user" ? "You" : "Agent"}: ${match.snippet}`,
          run: () => {
            if (props.state()?.environmentId !== environmentId)
              return props.ui.notify("The environment changed. Search again.", true);
            props.ui.openThread(match.threadId);
          },
        })),
      );
    },
  });
}
