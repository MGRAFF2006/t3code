import { scrollbarOptions } from "../ui/scroll.ts";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  WS_METHODS,
  type IssueDetail,
  type IssueListResult,
  type IssueRef,
  type IssueScopeRef,
  type IssueTemplate,
} from "@t3tools/contracts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { reactionActions } from "./reactions.ts";
import {
  Action,
  createProjectScope,
  destinationGuard,
  errorMessage,
  Section,
  splitNames,
} from "./common.tsx";

const issueKey = (entry: IssueRef) =>
  `${entry.projectId}\0${entry.tracker}\0${entry.host ?? ""}\0${entry.scope}\0${entry.key}`;
const scopeKey = (entry: IssueScopeRef) =>
  `${entry.projectId}\0${entry.tracker}\0${entry.host ?? ""}\0${entry.scope}`;

export function IssuesPanel(props: FeatureProps) {
  const scope = createProjectScope(props);
  const environment = createMemo(() => props.state()?.environmentId);
  const projectId = createMemo(() => scope.project()?.id);
  const [filter, setFilter] = createSignal<{
    state: "open" | "closed" | "all";
    involvement: "all" | "assigned" | "authored" | "mentioned";
    query: string;
    labels: string;
    assignee: string;
    sort: "created" | "updated";
  }>({ state: "open", involvement: "all", query: "", labels: "", assignee: "", sort: "updated" });
  const [revision, setRevision] = createSignal(0);
  const [result, setResult] = createSignal<IssueListResult | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [selection, setSelection] = createSignal("");
  const [detail, setDetail] = createSignal<IssueDetail | null>(null);
  const [detailFailure, setDetailFailure] = createSignal<string | null>(null);
  const [pane, setPane] = createSignal<"list" | "detail">("list");
  const entries = () => result()?.entries ?? [];
  const selected = createMemo(
    () => entries().find((entry) => issueKey(entry) === selection()) ?? entries()[0],
  );
  let generation = 0;
  const input = () => {
    const id = projectId();
    const value = filter();
    return {
      ...(id ? { projectId: id } : {}),
      state: value.state,
      involvement: value.involvement,
      sort: value.sort,
      ...(value.query ? { query: value.query } : {}),
      ...(value.labels.trim() ? { labels: splitNames(value.labels) } : {}),
      ...(value.assignee.trim() ? { assignee: value.assignee.trim() } : {}),
      limit: 50,
    };
  };

  createEffect(() => {
    const environmentId = environment();
    const id = projectId();
    const payload = input();
    revision();
    const current = ++generation;
    let active = true;
    setResult(null);
    setFailure(null);
    setLoading(true);
    if (!environmentId || !id) {
      setLoading(false);
      return;
    }
    void request(props.client, WS_METHODS.issuesList, payload)
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
    setDetailFailure(null);
    if (!entry || !environmentId) return;
    let active = true;
    void request(props.client, WS_METHODS.issuesDetail, refOf(entry)).then(
      (value) => {
        if (active) setDetail(value);
      },
      (error) => {
        if (active) setDetailFailure(errorMessage(error));
      },
    );
    onCleanup(() => {
      active = false;
    });
  });

  function refOf(entry: IssueRef): IssueRef {
    return {
      projectId: entry.projectId,
      tracker: entry.tracker,
      host: entry.host,
      scope: entry.scope,
      key: entry.key,
    };
  }
  function refresh() {
    setRevision((value) => value + 1);
  }
  function search() {
    const value = filter();
    props.ui.form({
      title: "Search issues",
      fields: [
        { name: "query", label: "Search", value: value.query },
        {
          name: "state",
          label: "State",
          type: "select",
          value: value.state,
          options: ["open", "closed", "all"].map((value) => ({ label: value, value })),
        },
        {
          name: "involvement",
          label: "Involvement",
          type: "select",
          value: value.involvement,
          options: [
            { label: "All issues", value: "all" },
            { label: "Assigned to me", value: "assigned" },
            { label: "Authored by me", value: "authored" },
            { label: "Mentioning me", value: "mentioned" },
          ],
        },
        {
          name: "labels",
          label: "Labels",
          value: value.labels,
          description: "Comma-separated names; the issue must have every listed label.",
        },
        { name: "assignee", label: "Assignee", value: value.assignee },
        {
          name: "sort",
          label: "Sort by",
          type: "select",
          value: value.sort,
          options: [
            { label: "Recently updated", value: "updated" },
            { label: "Recently created", value: "created" },
          ],
        },
      ],
      submitLabel: "Search",
      onSubmit: async (values) => {
        setFilter({
          query: values.query?.trim() ?? "",
          state: values.state === "closed" || values.state === "all" ? values.state : "open",
          involvement:
            values.involvement === "assigned" ||
            values.involvement === "authored" ||
            values.involvement === "mentioned"
              ? values.involvement
              : "all",
          labels: values.labels ?? "",
          assignee: values.assignee ?? "",
          sort: values.sort === "created" ? "created" : "updated",
        });
      },
    });
  }

  function loadMore() {
    const previous = result();
    if (!previous || !Object.keys(previous.nextCursors).length) return;
    const payload = input();
    const current = generation;
    const guard = destinationGuard(props);
    void props.ui.run(async () => {
      guard();
      const next = await request(props.client, WS_METHODS.issuesList, {
        ...payload,
        cursors: previous.nextCursors,
      });
      if (current !== generation) return;
      const merged = new Map(previous.entries.map((entry) => [issueKey(entry), entry]));
      for (const entry of next.entries) merged.set(issueKey(entry), entry);
      setResult({
        ...next,
        entries: [...merged.values()].toSorted((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        ),
        scopes: previous.scopes ?? next.scopes,
      });
    });
  }

  function createInScope(target: IssueScopeRef, template?: IssueTemplate) {
    const guard = destinationGuard(props);
    props.ui.form({
      title: `New issue in ${target.scope}`,
      fields: [
        { name: "title", label: "Title", value: template?.title ?? "", required: true },
        { name: "body", label: "Description", value: template?.body ?? "", type: "multiline" },
        {
          name: "labels",
          label: "Labels",
          value: template?.labels.join(", ") ?? "",
          description: "Comma-separated label names.",
        },
        {
          name: "assignees",
          label: "Assignees",
          value: template?.assignees.join(", ") ?? "",
          description: "Comma-separated logins or tracker IDs.",
        },
      ],
      submitLabel: "Create issue",
      onSubmit: async (values) => {
        guard();
        const created = await request(props.client, WS_METHODS.issuesCreate, {
          ...target,
          title: values.title?.trim() ?? "",
          body: values.body ?? "",
          labels: splitNames(values.labels ?? ""),
          assignees: splitNames(values.assignees ?? ""),
        });
        guard();
        props.ui.notify(`Created ${created.displayKey}.`);
        refresh();
      },
    });
  }

  function createIssue() {
    const value = result();
    if (!value) return;
    const scopes = [
      ...new Map(
        (
          value.scopes ??
          entries().map((entry) => ({
            projectId: entry.projectId,
            tracker: entry.tracker,
            host: entry.host,
            scope: entry.scope,
          }))
        ).map((entry) => [scopeKey(entry), entry]),
      ).values(),
    ].filter((entry) =>
      value.trackers.some(
        (tracker) =>
          tracker.tracker === entry.tracker &&
          tracker.host === entry.host &&
          tracker.capabilities?.create,
      ),
    );
    if (!scopes.length) {
      props.ui.notify("No writable issue tracker is configured for this project.", true);
      return;
    }
    const guard = destinationGuard(props);
    function chooseTemplate(target: IssueScopeRef) {
      const tracker = value!.trackers.find(
        (entry) => entry.tracker === target.tracker && entry.host === target.host,
      );
      if (!tracker?.capabilities?.templates) {
        createInScope(target);
        return;
      }
      void props.ui.run(async () => {
        guard();
        const templates = await request(props.client, WS_METHODS.issuesTemplates, target);
        guard();
        if (
          templates.blankIssuesEnabled &&
          !templates.templates.length &&
          !templates.externalTemplates?.length
        ) {
          createInScope(target);
          return;
        }
        props.ui.choose("Issue template", [
          ...(templates.blankIssuesEnabled
            ? [{ title: "Blank issue", run: () => createInScope(target) }]
            : []),
          ...templates.templates.map((template) => ({
            title: template.name,
            description: template.about,
            run: () => createInScope(target, template),
          })),
          ...(templates.externalTemplates ?? []).map((template) => ({
            title: template.name,
            description: "This template requires the tracker's website.",
            run: () =>
              props.ui.choose(template.name, [
                ...(props.ui.openBrowser
                  ? [
                      {
                        title: "Open template in browser",
                        run: () => props.ui.openBrowser?.(template.url),
                      },
                    ]
                  : []),
                { title: "Show link", run: () => props.ui.text(template.name, template.url) },
              ]),
          })),
        ]);
      });
    }
    if (scopes.length === 1) chooseTemplate(scopes[0]!);
    else
      props.ui.choose(
        "Create issue in",
        scopes.map((target) => ({
          title: target.scope,
          description: `${target.tracker} · ${target.host}`,
          run: () => chooseTemplate(target),
        })),
      );
  }

  function loadComments() {
    const value = detail();
    if (!value?.commentsCursor) return;
    const guard = destinationGuard(props);
    const key = issueKey(value);
    void props.ui.run(async () => {
      guard();
      const page = await request(props.client, WS_METHODS.issuesComments, {
        ...refOf(value),
        cursor: value.commentsCursor!,
      });
      guard();
      const current = detail();
      if (!current || issueKey(current) !== key || current.commentsCursor !== value.commentsCursor)
        return;
      const comments = new Map(
        [...page.comments, ...current.comments].map((comment) => [comment.id, comment]),
      );
      setDetail({ ...current, comments: [...comments.values()], commentsCursor: page.nextCursor });
    });
  }

  function actions() {
    const value = detail();
    if (!value || !selected() || issueKey(value) !== issueKey(selected()!)) return;
    const ref = refOf(value);
    const guard = destinationGuard(props);
    const options: Choice[] = [];
    async function mutate(action: () => Promise<unknown>) {
      guard();
      await action();
      guard();
      refresh();
    }
    if (value.writable) {
      if (value.capabilities.reactions) {
        options.push({
          title: "React to issue",
          run: () =>
            reactionActions(props, value.reactions, (content, reacted) =>
              mutate(() =>
                request(props.client, WS_METHODS.issuesReact, { ...ref, content, reacted }),
              ),
            ),
        });
        if (value.comments.length)
          options.push({
            title: "React to a comment",
            run: () =>
              props.ui.choose(
                "Issue comments",
                value.comments.map((comment) => ({
                  title: `${comment.author?.login ?? "Unknown"}: ${comment.body}`,
                  description: comment.createdAt,
                  run: () =>
                    reactionActions(props, comment.reactions, (content, reacted) =>
                      mutate(() =>
                        request(props.client, WS_METHODS.issuesReact, {
                          ...ref,
                          subjectId: comment.id,
                          content,
                          reacted,
                        }),
                      ),
                    ),
                })),
              ),
          });
      }
      if (value.capabilities.comment && value.viewerPermissions.comment)
        options.push({
          title: "Add comment",
          run: () =>
            props.ui.form({
              title: `Comment on ${value.displayKey}`,
              fields: [{ name: "body", label: "Comment", type: "multiline", required: true }],
              submitLabel: "Post comment",
              onSubmit: async (values) => {
                await mutate(() =>
                  request(props.client, WS_METHODS.issuesComment, {
                    ...ref,
                    body: values.body ?? "",
                  }),
                );
              },
            }),
        });
      if (value.capabilities.edit && value.viewerPermissions.edit)
        options.push({
          title: "Edit title and description",
          run: () =>
            props.ui.form({
              title: `Edit ${value.displayKey}`,
              fields: [
                { name: "title", label: "Title", required: true, value: value.title },
                { name: "body", label: "Description", type: "multiline", value: value.body },
              ],
              submitLabel: "Save changes",
              onSubmit: async (values) => {
                await mutate(() =>
                  request(props.client, WS_METHODS.issuesUpdate, {
                    ...ref,
                    title: values.title?.trim() ?? "",
                    body: values.body ?? "",
                  }),
                );
              },
            }),
        });
      if (value.viewerPermissions.setState && value.states.length)
        options.push({
          title: "Change state",
          run: () =>
            props.ui.choose(
              `State of ${value.displayKey}`,
              value.states
                .filter((state) => state.name !== value.state.name)
                .map((state) => ({
                  title: state.name,
                  description: state.category,
                  run: () =>
                    void props.ui.run(
                      () =>
                        mutate(() =>
                          request(props.client, WS_METHODS.issuesSetState, {
                            ...ref,
                            state: state.name,
                          }),
                        ),
                      "Issue state updated.",
                    ),
                })),
            ),
        });
      if (value.capabilities.labels && value.viewerPermissions.labels)
        options.push({
          title: "Manage labels",
          run: () =>
            void props.ui.run(async () => {
              guard();
              const candidates = await request(props.client, WS_METHODS.issuesCandidates, {
                projectId: value.projectId,
                tracker: value.tracker,
                host: value.host,
                scope: value.scope,
              });
              guard();
              props.ui.choose(
                "Labels",
                candidates.labels.map((label) => {
                  const selected = value.labels.some((entry) => entry.name === label.name);
                  return {
                    title: `${selected ? "✓ " : ""}${label.name}`,
                    description: label.description ?? undefined,
                    run: () =>
                      void props.ui.run(
                        () =>
                          mutate(() =>
                            request(props.client, WS_METHODS.issuesUpdate, {
                              ...ref,
                              labels: selected
                                ? value.labels
                                    .filter((entry) => entry.name !== label.name)
                                    .map((entry) => entry.name)
                                : [...value.labels.map((entry) => entry.name), label.name],
                            }),
                          ),
                        "Labels saved.",
                      ),
                  };
                }),
              );
            }),
        });
      if (value.capabilities.assignees && value.viewerPermissions.assignees)
        options.push({
          title: "Manage assignees",
          run: () =>
            void props.ui.run(async () => {
              guard();
              const candidates = await request(props.client, WS_METHODS.issuesCandidates, {
                projectId: value.projectId,
                tracker: value.tracker,
                host: value.host,
                scope: value.scope,
              });
              guard();
              props.ui.choose(
                "Assignees",
                candidates.assignees.map((assignee) => {
                  const selected = value.assignees.some((entry) => entry.login === assignee.login);
                  return {
                    title: `${selected ? "✓ " : ""}${assignee.login}`,
                    description: assignee.name ?? undefined,
                    run: () =>
                      void props.ui.run(
                        () =>
                          mutate(() =>
                            request(props.client, WS_METHODS.issuesUpdate, {
                              ...ref,
                              assignees: selected
                                ? value.assignees
                                    .filter((entry) => entry.login !== assignee.login)
                                    .map(
                                      (entry) =>
                                        candidates.assignees.find(
                                          (candidate) => candidate.login === entry.login,
                                        )?.id ?? entry.login,
                                    )
                                : [
                                    ...value.assignees.map(
                                      (entry) =>
                                        candidates.assignees.find(
                                          (candidate) => candidate.login === entry.login,
                                        )?.id ?? entry.login,
                                    ),
                                    assignee.id,
                                  ],
                            }),
                          ),
                        "Assignees saved.",
                      ),
                  };
                }),
              );
            }),
        });
    }
    if (value.commentsCursor) options.push({ title: "Load older comments", run: loadComments });
    if (props.ui.openBrowser)
      options.push({ title: "Open in browser", run: () => props.ui.openBrowser?.(value.url) });
    options.push({ title: "Show link", run: () => props.ui.text(value.displayKey, value.url) });
    props.ui.choose(`${value.displayKey} ${value.title}`, options);
  }

  useKeyboard((event) => {
    if (!props.focused || props.ui.modal() || event.ctrl || event.meta) return;
    if (event.name === "/" || event.name === "f") search();
    else if (event.name === "p") scope.choose();
    else if (event.name === "r") refresh();
    else if (event.name === "n") createIssue();
    else if (event.name === "m") loadMore();
    else if (event.name === "a") actions();
    else if (event.name === "right") setPane("detail");
    else if (event.name === "left") setPane("list");
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  return (
    <box flexGrow={1} flexDirection="column" minHeight={0} onMouseDown={props.onFocus}>
      <box padding={1} flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.text} attributes={1}>
          Issues
        </text>
        <Action
          label={`${scope.project()?.title ?? "Choose project"} [p]`}
          onPress={scope.choose}
        />
        <Action label="New issue [n]" onPress={createIssue} />
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
      <For each={result()?.trackers.filter((tracker) => !tracker.configured)}>
        {(tracker) => (
          <text fg={theme.warning} paddingX={1} wrapMode="word">
            {tracker.host}: {tracker.detail ?? "Issue tracker is not configured."}
          </text>
        )}
      </For>
      <Show
        when={entries().length}
        fallback={
          <text fg={theme.textMuted} padding={2}>
            {loading()
              ? "Loading issues…"
              : "No issues match. Change the search, create an issue, or choose another project."}
          </text>
        }
      >
        <box flexGrow={1} flexDirection="row" minHeight={0}>
          <select
            width="38%"
            flexGrow={1}
            flexShrink={0}
            options={entries().map((entry) => ({
              name: `${entry.displayKey} ${entry.title}`,
              description: `${entry.state.name} · ${entry.author?.login ?? "Unknown"} · ${entry.scope}`,
            }))}
            selectedIndex={Math.max(
              0,
              entries().findIndex((entry) => issueKey(entry) === selection()),
            )}
            onChange={(index) => {
              const entry = entries()[index];
              if (entry) setSelection(issueKey(entry));
            }}
            onSelect={actions}
            onMouseDown={() => setPane("list")}
            focused={props.focused && !props.ui.modal() && pane() === "list"}
            backgroundColor={theme.background}
            textColor={theme.text}
            descriptionColor={theme.textMuted}
            selectedTextColor={theme.primary}
            selectedBackgroundColor={theme.backgroundElement}
            showScrollIndicator
          />
          <scrollbox
            scrollbarOptions={scrollbarOptions()}
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
                  <Section title={`${value().displayKey} ${value().title}`}>
                    <text
                      fg={value().state.category === "closed" ? theme.textMuted : theme.success}
                    >
                      {value().state.name} · {value().author?.login ?? "Unknown"}
                    </text>
                    <text fg={theme.textMuted}>
                      {value().scope} · updated {value().updatedAt}
                    </text>
                    <Show when={!value().writable}>
                      <text fg={theme.warning}>
                        This issue is read-only from the selected environment.
                      </text>
                    </Show>
                    <Action label="Actions [a]" onPress={actions} />
                  </Section>
                  <Show when={value().body}>
                    <Section title="Description">
                      <text fg={theme.text} wrapMode="word">
                        {value().body}
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
                  <Show when={value().assignees.length}>
                    <Section title="Assignees">
                      <text fg={theme.textMuted}>
                        {value()
                          .assignees.map((assignee) => assignee.login)
                          .join(", ")}
                      </text>
                    </Section>
                  </Show>
                  <Show when={value().commentsCursor}>
                    <Action label="Load older comments" onPress={loadComments} />
                  </Show>
                  <For each={value().comments}>
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
                  <Show when={value().events.length}>
                    <Section title="Activity">
                      <For each={value().events}>
                        {(event) => (
                          <text fg={theme.textMuted} wrapMode="word">
                            {event.actor?.login ?? "Unknown"} {event.kind.replaceAll("-", " ")}
                            {event.detail ? `: ${event.detail}` : ""}
                          </text>
                        )}
                      </For>
                    </Section>
                  </Show>
                  <Show when={value().linkedPullRequests.length}>
                    <Section title="Linked pull requests">
                      <For each={value().linkedPullRequests}>
                        {(pr) => (
                          <text
                            selectable={false}
                            fg={theme.primary}
                            wrapMode="word"
                            onMouseDown={() => props.ui.text(pr.title, pr.url)}
                          >
                            #{pr.number} {pr.title} · {pr.state}
                          </text>
                        )}
                      </For>
                    </Section>
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
        ↑↓ select · → details · ← list · enter actions · n new · / search · p project · r refresh
      </text>
    </box>
  );
}
