import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  WS_METHODS,
  type PullRequestAction,
  type PullRequestActivity,
  type PullRequestDetail,
  type PullRequestListEntry,
  type PullRequestListResult,
  type PullRequestRef,
} from "@t3tools/contracts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { PullRequestDiffPanel } from "./pr-diff.tsx";
import { reactionActions } from "./reactions.ts";
import { Action, createProjectScope, destinationGuard, errorMessage, Section } from "./common.tsx";

const entryKey = (entry: PullRequestListEntry) =>
  `${entry.host}\0${entry.repository}\0${entry.number}`;
const actionLabels: Record<PullRequestAction, string> = {
  merge: "Merge",
  ready: "Mark ready for review",
  draft: "Convert to draft",
  close: "Close",
  reopen: "Reopen",
  "delete-branch": "Delete branch",
  "update-branch": "Update branch",
  "enable-auto-merge": "Enable auto-merge",
  "disable-auto-merge": "Disable auto-merge",
  revert: "Revert",
  "approve-workflows": "Approve workflows",
};

export function PullRequestsPanel(props: FeatureProps) {
  const scope = createProjectScope(props);
  const environment = createMemo(() => props.state()?.environmentId);
  const projectId = createMemo(() => scope.project()?.id);
  const [filter, setFilter] = createSignal<{
    state: "all" | "open" | "closed" | "merged";
    involvement: "all" | "reviewing" | "authored";
    query: string;
  }>({ state: "open", involvement: "all", query: "" });
  const [revision, setRevision] = createSignal(0);
  const [result, setResult] = createSignal<PullRequestListResult | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [selection, setSelection] = createSignal("");
  const [review, setReview] = createSignal<PullRequestRef | null>(null);
  const [pane, setPane] = createSignal<"list" | "detail">("list");
  const [detail, setDetail] = createSignal<PullRequestDetail | null>(null);
  const [activity, setActivity] = createSignal<PullRequestActivity | null>(null);
  const [detailFailure, setDetailFailure] = createSignal<string | null>(null);
  const [accountId, setAccountId] = createSignal<string | undefined>();
  const entries = () => result()?.entries ?? [];
  const selected = createMemo(
    () => entries().find((entry) => entryKey(entry) === selection()) ?? entries()[0],
  );
  let generation = 0;

  createEffect(() => {
    const environmentId = environment();
    const id = projectId();
    const filters = filter();
    revision();
    const current = ++generation;
    let active = true;
    setReview(null);
    setResult(null);
    setFailure(null);
    setLoading(true);
    if (!environmentId || !id) {
      setLoading(false);
      return;
    }
    void request(props.client, WS_METHODS.pullRequestsList, {
      projectId: id,
      state: filters.state,
      involvement: filters.involvement,
      ...(filters.query ? { query: filters.query } : {}),
      limit: 50,
    })
      .then(
        (value) => {
          if (active && current === generation) setResult(value);
        },
        (error) => {
          if (active) setFailure(errorMessage(error));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    onCleanup(() => {
      active = false;
    });
  });

  createEffect(() => {
    const entry = selected();
    const environmentId = environment();
    setDetail(null);
    setActivity(null);
    setDetailFailure(null);
    setAccountId(undefined);
    if (!entry || !environmentId) return;
    let active = true;
    const ref = {
      projectId: entry.projectId,
      repository: entry.repository,
      number: entry.number,
      host: entry.host,
    };
    void Promise.allSettled([
      request(props.client, WS_METHODS.pullRequestsDetail, ref).then((value) => {
        if (active) setDetail(value);
      }),
      request(props.client, WS_METHODS.pullRequestsActivity, ref).then((value) => {
        if (active) setActivity(value);
      }),
      request(props.client, WS_METHODS.pullRequestsRoutingIdentity, { host: entry.host }).then(
        (value) => {
          if (active) setAccountId(value.accountId);
        },
      ),
    ]).then((results) => {
      if (!active) return;
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        setDetailFailure(failures.map((result) => errorMessage(result.reason)).join("\n"));
    });
    onCleanup(() => {
      active = false;
    });
  });

  function refresh() {
    setRevision((value) => value + 1);
  }
  function search() {
    const initial = filter();
    props.ui.form({
      title: "Search pull requests",
      fields: [
        { name: "query", label: "Search", value: initial.query },
        {
          name: "state",
          label: "State",
          type: "select",
          value: initial.state,
          options: ["open", "closed", "merged", "all"].map((value) => ({ label: value, value })),
        },
        {
          name: "involvement",
          label: "Involvement",
          type: "select",
          value: initial.involvement,
          options: [
            { label: "All pull requests", value: "all" },
            { label: "Requested review", value: "reviewing" },
            { label: "Authored by me", value: "authored" },
          ],
        },
      ],
      submitLabel: "Search",
      onSubmit: async (values) => {
        setFilter({
          query: values.query?.trim() ?? "",
          state:
            values.state === "closed" || values.state === "merged" || values.state === "all"
              ? values.state
              : "open",
          involvement:
            values.involvement === "reviewing" || values.involvement === "authored"
              ? values.involvement
              : "all",
        });
      },
    });
  }

  function loadMore() {
    const previous = result();
    const id = projectId();
    if (!previous || !id || !Object.keys(previous.nextCursors).length) return;
    const current = generation;
    const filters = filter();
    const guard = destinationGuard(props);
    void props.ui.run(async () => {
      guard();
      const next = await request(props.client, WS_METHODS.pullRequestsList, {
        projectId: id,
        state: filters.state,
        involvement: filters.involvement,
        ...(filters.query ? { query: filters.query } : {}),
        cursors: previous.nextCursors,
        limit: 50,
      });
      if (current !== generation) return;
      const merged = new Map(previous.entries.map((entry) => [entryKey(entry), entry]));
      for (const entry of next.entries) merged.set(entryKey(entry), entry);
      setResult({
        ...next,
        entries: [...merged.values()].toSorted((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        ),
      });
    });
  }

  function actions() {
    const value = detail();
    const entry = selected();
    if (
      !value ||
      !entry ||
      value.number !== entry.number ||
      value.repository !== entry.repository ||
      value.projectId !== entry.projectId
    )
      return;
    const guard = destinationGuard(props);
    const ref: PullRequestRef = {
      projectId: value.projectId,
      repository: value.repository,
      number: value.number,
      host: entry.host,
      ...(accountId() ? { expectedAccountId: accountId()! } : {}),
    };
    async function mutate(action: () => Promise<unknown>) {
      guard();
      await action();
      guard();
      refresh();
    }
    const options: Choice[] = [];
    if (value.capabilities.reactions)
      options.push({
        title: "React to pull request",
        run: () =>
          reactionActions(props, activity()?.reactions, (content, reacted) =>
            mutate(() =>
              request(props.client, WS_METHODS.pullRequestsSetReaction, {
                ...ref,
                content,
                reacted,
              }),
            ),
          ),
      });
    if (activity()?.comments.length)
      options.push({
        title: "Conversation comments",
        run: () =>
          props.ui.choose(
            "Pull request comments",
            activity()!.comments.map((comment) => ({
              title: `${comment.author?.login ?? "Unknown"}: ${comment.body}`,
              description: comment.createdAt,
              run: () => {
                const kind = comment.kind;
                props.ui.choose("Comment actions", [
                  {
                    title: "Read comment",
                    run: () => props.ui.text("Pull request comment", comment.body, "markdown"),
                  },
                  ...(value.capabilities.reactions
                    ? [
                        {
                          title: "React to comment",
                          run: () =>
                            reactionActions(props, comment.reactions, (content, reacted) =>
                              mutate(() =>
                                request(props.client, WS_METHODS.pullRequestsSetReaction, {
                                  ...ref,
                                  subjectId: comment.id,
                                  content,
                                  reacted,
                                }),
                              ),
                            ),
                        },
                      ]
                    : []),
                  ...(comment.canEdit && (kind === "issue-comment" || kind === "review-comment")
                    ? [
                        {
                          title: "Edit your comment",
                          run: () =>
                            props.ui.form({
                              title: "Edit pull request comment",
                              fields: [
                                {
                                  name: "body",
                                  label: "Comment",
                                  type: "multiline",
                                  value: comment.body,
                                  required: true,
                                },
                              ],
                              submitLabel: "Save comment",
                              onSubmit: async ({ body = "" }) => {
                                await mutate(() =>
                                  request(props.client, WS_METHODS.pullRequestsUpdateComment, {
                                    ...ref,
                                    commentId: comment.id,
                                    kind,
                                    body,
                                  }),
                                );
                              },
                            }),
                        },
                      ]
                    : []),
                ]);
              },
            })),
          ),
      });
    options.push(
      {
        title: "Review guide",
        run: () =>
          void props.ui.run(async () => {
            guard();
            const result = await request(props.client, WS_METHODS.pullRequestsReviewGuide, ref);
            guard();
            const guide = result.guide;
            props.ui.choose("Review guide", [
              ...(guide
                ? [
                    {
                      title: "Read guide",
                      description: `${guide.stops.length} stops${result.currentHeadSha !== guide.headSha ? " · Written for an older revision" : ""}`,
                      run: () =>
                        props.ui.text(
                          "Review guide",
                          guide.stops
                            .map((stop, index) =>
                              [
                                `${index + 1}. ${stop.title}`,
                                stop.summary,
                                stop.attention
                                  ? `${stop.attention.kind}: ${stop.attention.note}`
                                  : "",
                                ...stop.files.map(
                                  (file) => `${file.path}${file.note ? `: ${file.note}` : ""}`,
                                ),
                                ...stop.excerpts.map(
                                  (excerpt) =>
                                    `${excerpt.path}:${excerpt.start}–${excerpt.end} (${excerpt.side}): ${excerpt.caption}`,
                                ),
                                ...stop.notes.map(
                                  (note) =>
                                    `${note.path}:${note.line} · ${note.title}\n${note.body}`,
                                ),
                                ...stop.questions.map((question) => `Question: ${question}`),
                              ]
                                .filter(Boolean)
                                .join("\n\n"),
                            )
                            .join("\n\n---\n\n"),
                          "markdown",
                        ),
                    },
                  ]
                : []),
              {
                title: result.run?._tag === "Running" ? "Generation in progress" : "Generate guide",
                description:
                  result.run?._tag === "Failed"
                    ? result.run.detail
                    : "Uses the environment's configured review-guide model.",
                run: () => {
                  if (result.run?._tag === "Running") {
                    props.ui.notify("Guide generation is running. Reopen this action to refresh.");
                    return;
                  }
                  props.ui.confirm(
                    "Generate review guide",
                    "Run the configured review-guide model for this pull request? This may use provider credits.",
                    async () => {
                      guard();
                      await request(props.client, WS_METHODS.pullRequestsGenerateReviewGuide, ref);
                      guard();
                      props.ui.notify(
                        "Guide generation requested. Reopen Review guide to inspect its progress.",
                      );
                    },
                    "Generate guide",
                  );
                },
              },
            ]);
          }),
      },
      {
        title: "Stack layers",
        run: () =>
          void props.ui.run(async () => {
            guard();
            const stack = await request(props.client, WS_METHODS.pullRequestsStack, ref);
            guard();
            if (!stack) {
              props.ui.notify("This pull request is not part of a stack.");
              return;
            }
            props.ui.choose(
              `Stack #${stack.number}`,
              stack.layers.map((layer) => ({
                title: `#${layer.number} ${layer.title ?? layer.headBranch}`,
                description: `${layer.state}${layer.isDraft ? " · Draft" : ""}`,
                run: () => {
                  guard();
                  setReview({ ...ref, number: layer.number });
                },
              })),
            );
          }),
      },
      {
        title: "Source account and workspace",
        run: () =>
          void props.ui.run(async () => {
            guard();
            const routing = await request(props.client, WS_METHODS.pullRequestsRouting, ref);
            guard();
            props.ui.text(
              "Pull request routing",
              `${routing.host}\n${routing.provider} · ${routing.viewer}\n\n${routing.projectTitle}\n${routing.workspaceRoot}\n\nAccount: ${routing.accountId}`,
            );
          }),
      },
    );
    if (value.capabilities.diff)
      options.push({
        title: "Review changed files",
        run: () => {
          guard();
          setReview(ref);
        },
      });
    if (value.capabilities.comment && value.viewerPermissions.comment)
      options.push({
        title: "Add comment",
        run: () =>
          props.ui.form({
            title: `Comment on #${value.number}`,
            fields: [{ name: "body", label: "Comment", type: "multiline", required: true }],
            submitLabel: "Post comment",
            onSubmit: async (values) => {
              await mutate(() =>
                request(props.client, WS_METHODS.pullRequestsComment, {
                  ...ref,
                  body: values.body ?? "",
                }),
              );
            },
          }),
      });
    const verdicts = value.capabilities.review.verdicts.filter((verdict) =>
      value.viewerPermissions.verdicts.includes(verdict),
    );
    if (verdicts.length)
      options.push({
        title: "Submit review",
        run: () =>
          props.ui.form({
            title: `Review #${value.number}`,
            fields: [
              {
                name: "verdict",
                label: "Review",
                type: "select",
                value: verdicts[0]!,
                options: verdicts.map((verdict) => ({
                  label:
                    verdict === "request-changes"
                      ? "Request changes"
                      : verdict === "approve"
                        ? "Approve"
                        : "Comment",
                  value: verdict,
                })),
              },
              { name: "body", label: "Review body", type: "multiline" },
            ],
            submitLabel: "Submit review",
            onSubmit: async (values) => {
              const verdict = verdicts.find((item) => item === values.verdict);
              if (!verdict) throw new Error("Choose a review verdict.");
              await mutate(() =>
                request(props.client, WS_METHODS.pullRequestsSubmitReview, {
                  ...ref,
                  verdict,
                  body: values.body ?? "",
                  comments: [],
                }),
              );
            },
          }),
      });
    if (
      value.capabilities.edit?.changeRequest &&
      value.viewerPermissions.editChangeRequest !== false
    )
      options.push({
        title: "Edit title and description",
        run: () =>
          props.ui.form({
            title: `Edit #${value.number}`,
            fields: [
              { name: "title", label: "Title", value: value.title, required: true },
              { name: "body", label: "Description", type: "multiline", value: value.body },
            ],
            submitLabel: "Save changes",
            onSubmit: async (values) => {
              await mutate(() =>
                request(props.client, WS_METHODS.pullRequestsUpdate, {
                  ...ref,
                  title: values.title ?? "",
                  body: values.body ?? "",
                }),
              );
            },
          }),
      });
    if (value.capabilities.labels && value.viewerPermissions.labels !== false)
      options.push({
        title: "Manage labels",
        run: () =>
          void props.ui.run(async () => {
            guard();
            const candidates = await request(
              props.client,
              WS_METHODS.pullRequestsLabelCandidates,
              ref,
            );
            guard();
            props.ui.choose(
              "Labels",
              candidates.candidates.map((label) => ({
                title: `${label.isApplied ? "✓ " : ""}${label.name}`,
                description: label.description ?? undefined,
                run: () =>
                  void props.ui.run(
                    () =>
                      mutate(() =>
                        request(props.client, WS_METHODS.pullRequestsSetLabels, {
                          ...ref,
                          labels: [label.name],
                          applied: !label.isApplied,
                        }),
                      ),
                    "Labels saved.",
                  ),
              })),
            );
          }),
      });
    if (
      value.capabilities.reviewers.request &&
      value.capabilities.reviewers.listCandidates &&
      value.viewerPermissions.requestReviewers
    )
      options.push({
        title: "Manage reviewers",
        run: () =>
          void props.ui.run(async () => {
            guard();
            const candidates = await request(
              props.client,
              WS_METHODS.pullRequestsReviewerCandidates,
              ref,
            );
            guard();
            props.ui.choose(
              "Reviewers",
              candidates.candidates.map((reviewer) => ({
                title: `${reviewer.isRequested ? "✓ " : ""}${reviewer.login}`,
                description: reviewer.name ?? undefined,
                run: () =>
                  void props.ui.run(
                    () =>
                      mutate(() =>
                        request(props.client, WS_METHODS.pullRequestsRequestReviewers, {
                          ...ref,
                          reviewers: [{ id: reviewer.id, kind: reviewer.kind }],
                          requested: !reviewer.isRequested,
                        }),
                      ),
                    "Reviewers saved.",
                  ),
              })),
            );
          }),
      });
    if (activity()?.reviewThreads.length)
      options.push({
        title: "Review conversations",
        run: () =>
          props.ui.choose(
            "Review conversations",
            activity()!.reviewThreads.map((thread) => ({
              title: `${thread.isResolved ? "✓ " : ""}${thread.path}:${thread.line ?? ""}`,
              description: thread.comments[0]?.body,
              run: () =>
                props.ui.choose("Conversation", [
                  {
                    title: "Read conversation",
                    run: () =>
                      props.ui.text(
                        `${thread.path}:${thread.line ?? ""}`,
                        thread.comments
                          .map(
                            (comment) => `${comment.author?.login ?? "Unknown"}\n${comment.body}`,
                          )
                          .join("\n\n"),
                      ),
                  },
                  ...(value.capabilities.review.reply && value.viewerPermissions.comment
                    ? [
                        {
                          title: "Reply",
                          run: () =>
                            props.ui.form({
                              title: "Reply to review",
                              fields: [
                                { name: "body", label: "Reply", type: "multiline", required: true },
                              ],
                              submitLabel: "Post reply",
                              onSubmit: async (values) => {
                                await mutate(() =>
                                  request(props.client, WS_METHODS.pullRequestsReplyToThread, {
                                    ...ref,
                                    threadId: thread.id,
                                    body: values.body ?? "",
                                  }),
                                );
                              },
                            }),
                        },
                      ]
                    : []),
                  ...(value.capabilities.review.resolve &&
                  value.viewerPermissions.resolve &&
                  thread.canResolve !== false
                    ? [
                        {
                          title: thread.isResolved ? "Reopen conversation" : "Resolve conversation",
                          run: () =>
                            void props.ui.run(
                              () =>
                                mutate(() =>
                                  request(
                                    props.client,
                                    WS_METHODS.pullRequestsSetThreadResolution,
                                    { ...ref, threadId: thread.id, resolved: !thread.isResolved },
                                  ),
                                ),
                              "Conversation updated.",
                            ),
                        },
                      ]
                    : []),
                ]),
            })),
          ),
      });
    for (const action of value.capabilities.actions.filter((action) =>
      value.viewerPermissions.actions.includes(action),
    )) {
      if (
        (action === "ready" && !value.isDraft) ||
        (action === "draft" && value.isDraft) ||
        (action === "close" && value.state !== "open") ||
        (action === "reopen" && value.state !== "closed") ||
        (action === "disable-auto-merge" && !value.autoMergeEnabled) ||
        (action === "enable-auto-merge" && value.autoMergeEnabled)
      )
        continue;
      if (
        ["merge", "enable-auto-merge", "update-branch", "approve-workflows"].includes(action) &&
        value.state !== "open"
      )
        continue;
      if ((action === "merge" || action === "enable-auto-merge") && value.isDraft) continue;
      if (action === "revert" && value.state !== "merged") continue;
      if (
        action === "merge" &&
        !value.capabilities.mergeMethods.some((method) => value.mergeCapabilities[method] === true)
      )
        continue;
      options.push({
        title: actionLabels[action],
        run: () => {
          const methods = value.capabilities.mergeMethods.filter(
            (method) => action === "enable-auto-merge" || value.mergeCapabilities[method] === true,
          );
          const execute = (mergeMethod?: (typeof methods)[number]) =>
            props.ui.confirm(
              `${actionLabels[action]} #${value.number}`,
              `${value.title}\n${value.headBranch} → ${value.baseBranch}${mergeMethod ? `\nMethod: ${mergeMethod}` : ""}`,
              async () => {
                await mutate(() =>
                  request(props.client, WS_METHODS.pullRequestsRunAction, {
                    ...ref,
                    action,
                    ...(mergeMethod ? { mergeMethod } : {}),
                  }),
                );
              },
              actionLabels[action],
            );
          if (action === "merge" || action === "enable-auto-merge")
            props.ui.choose(
              "Merge method",
              methods.map((method) => ({ title: method, run: () => execute(method) })),
            );
          else if (action === "update-branch" && value.capabilities.updateMethods?.length)
            props.ui.choose(
              "Update method",
              value.capabilities.updateMethods
                .filter(
                  (method) => value.viewerPermissions.updateMethods?.includes(method) !== false,
                )
                .map((method) => ({
                  title: method,
                  run: () =>
                    props.ui.confirm(
                      "Update branch",
                      `${value.headBranch} from ${value.baseBranch} using ${method}?`,
                      async () => {
                        await mutate(() =>
                          request(props.client, WS_METHODS.pullRequestsRunAction, {
                            ...ref,
                            action,
                            updateMethod: method,
                          }),
                        );
                      },
                      "Update branch",
                    ),
                })),
            );
          else execute();
        },
      });
    }
    options.push({
      title: "Open linked threads",
      run: () =>
        void props.ui.run(async () => {
          guard();
          const linked = await request(props.client, WS_METHODS.pullRequestsLinkedThreads, ref);
          guard();
          if (!linked.threads.length) {
            props.ui.notify("No linked threads for this pull request.");
            return;
          }
          props.ui.choose(
            "Linked threads",
            linked.threads.map((thread) => ({
              title: thread.title,
              run: () => props.ui.openThread(thread.id),
            })),
          );
        }),
    });
    if (props.ui.openBrowser)
      options.push({ title: "Open in browser", run: () => props.ui.openBrowser?.(value.url) });
    options.push({ title: "Show link", run: () => props.ui.text("Pull request link", value.url) });
    props.ui.choose(`#${value.number} ${value.title}`, options);
  }

  useKeyboard((event) => {
    if (!props.focused || props.ui.modal() || review() || event.ctrl || event.meta) return;
    if (event.name === "/" || event.name === "f") search();
    else if (event.name === "p") scope.choose();
    else if (event.name === "r") refresh();
    else if (event.name === "m") loadMore();
    else if (event.name === "a") actions();
    else if (event.name === "right") setPane("detail");
    else if (event.name === "left") setPane("list");
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  return (
    <>
      <Show when={review()}>
        {(reference) => (
          <PullRequestDiffPanel
            {...props}
            reference={reference()}
            details={detail()!}
            onClose={() => {
              setReview(null);
              refresh();
            }}
          />
        )}
      </Show>
      <Show when={!review()}>
        <box flexGrow={1} flexDirection="column" minHeight={0} onMouseDown={props.onFocus}>
          <box flexDirection="row" padding={1} justifyContent="space-between" gap={2}>
            <text fg={theme.text} attributes={1}>
              Pull requests
            </text>
            <Action
              label={`${scope.project()?.title ?? "Choose project"} [p]`}
              onPress={scope.choose}
            />
            <Action label="Search [/]" onPress={search} />
          </box>
          <text fg={theme.textMuted} paddingX={1}>
            {filter().state} · {filter().involvement}
            {filter().query ? ` · ${filter().query}` : ""}
            {loading() ? " · Loading…" : ""}
          </text>
          <Show when={failure()}>
            <text fg={theme.error} paddingX={1} wrapMode="word">
              {failure()}
            </text>
          </Show>
          <For each={result()?.errors}>
            {(error) => (
              <text fg={theme.warning} paddingX={1} wrapMode="word">
                {error.projectTitle}: {error.message}
              </text>
            )}
          </For>
          <For each={result()?.providers.filter((provider) => !provider.configured)}>
            {(provider) => (
              <text fg={theme.warning} paddingX={1} wrapMode="word">
                {provider.host}: {provider.detail ?? "Source control account is not configured."}
              </text>
            )}
          </For>
          <Show
            when={entries().length}
            fallback={
              <text fg={theme.textMuted} padding={2}>
                {loading()
                  ? "Loading pull requests…"
                  : "No pull requests match. Change the search or choose another project."}
              </text>
            }
          >
            <box flexGrow={1} flexDirection="row" minHeight={0}>
              <select
                width="38%"
                flexGrow={1}
                flexShrink={0}
                options={entries().map((entry) => ({
                  name: `#${entry.number} ${entry.title}`,
                  description: `${entry.isDraft ? "Draft" : entry.state} · ${entry.author?.login ?? "Unknown"} · ${entry.headBranch}`,
                }))}
                selectedIndex={Math.max(
                  0,
                  entries().findIndex((entry) => entryKey(entry) === selection()),
                )}
                onChange={(index) => {
                  const entry = entries()[index];
                  if (entry) setSelection(entryKey(entry));
                }}
                onSelect={actions}
                focused={props.focused && !props.ui.modal() && pane() === "list"}
                onMouseDown={() => setPane("list")}
                backgroundColor={theme.background}
                textColor={theme.text}
                descriptionColor={theme.textMuted}
                selectedTextColor={theme.primary}
                selectedBackgroundColor={theme.backgroundElement}
                showScrollIndicator
              />
              <scrollbox
                flexGrow={2}
                minWidth={0}
                paddingX={2}
                focused={props.focused && !props.ui.modal() && pane() === "detail"}
                onMouseDown={() => setPane("detail")}
              >
                <Show when={detailFailure()}>
                  <text fg={theme.error} wrapMode="word">
                    {detailFailure()}
                  </text>
                </Show>
                <Show when={detail()} fallback={<text fg={theme.textMuted}>Loading details…</text>}>
                  {(value) => (
                    <>
                      <Section title={`#${value().number} ${value().title}`}>
                        <text fg={theme.textMuted}>
                          {value().isDraft ? "Draft" : value().state} ·{" "}
                          {value().author?.login ?? "Unknown"}
                        </text>
                        <text fg={theme.textMuted}>
                          {value().headBranch} → {value().baseBranch}
                        </text>
                        <box flexDirection="row" gap={1}>
                          <text fg={theme.success}>+{value().additions}</text>
                          <text fg={theme.error}>−{value().deletions}</text>
                          <text fg={theme.textMuted}>· {value().changedFiles} files</text>
                        </box>
                        <text fg={theme.textMuted}>Mergeability: {value().mergeability}</text>
                        <Action label="Actions [a]" onPress={actions} />
                      </Section>
                      <Show when={value().body}>
                        <Section title="Description">
                          <text fg={theme.text} wrapMode="word">
                            {value().body}
                          </text>
                        </Section>
                      </Show>
                      <Show when={value().checks.length}>
                        <Section title="Checks">
                          <For each={value().checks}>
                            {(check) => (
                              <text fg={theme.textMuted} wrapMode="word">
                                {check.name}: {check.status}
                              </text>
                            )}
                          </For>
                        </Section>
                      </Show>
                      <Show when={value().reviewers.length}>
                        <Section title="Reviewers">
                          <text fg={theme.textMuted}>
                            {value()
                              .reviewers.map((reviewer) => reviewer.login)
                              .join(", ")}
                          </text>
                        </Section>
                      </Show>
                      <Show when={value().labels.length}>
                        <Section title="Labels">
                          <text fg={theme.textMuted}>
                            {value()
                              .labels.map((label) => label.name)
                              .join(", ")}
                          </text>
                        </Section>
                      </Show>
                      <For each={activity()?.comments}>
                        {(comment) => (
                          <Section
                            title={`${comment.author?.login ?? "Unknown"} · ${comment.createdAt}`}
                          >
                            <text fg={theme.text} wrapMode="word">
                              {comment.body}
                            </text>
                          </Section>
                        )}
                      </For>
                      <Show when={activity()?.commentsTruncated}>
                        <text fg={theme.warning}>
                          The host returned part of this conversation. Open the pull request link
                          for the full history.
                        </text>
                      </Show>
                    </>
                  )}
                </Show>
              </scrollbox>
            </box>
          </Show>
          <Show when={Object.keys(result()?.nextCursors ?? {}).length}>
            <box paddingX={1}>
              <Action label="Load more [m]" onPress={loadMore} />
            </box>
          </Show>
          <text fg={theme.textMuted} paddingX={1}>
            ↑↓ select · → details · ← list · enter actions · / search · p project · r refresh
          </text>
        </box>
      </Show>
    </>
  );
}
