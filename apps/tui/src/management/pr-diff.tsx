import { DiffRenderable, pathToFiletype } from "@opentui/core";
import { extend, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import {
  WS_METHODS,
  type PullRequestDetail,
  type PullRequestDiffResult,
  type PullRequestRef,
  type PullRequestReviewPosition,
} from "@t3tools/contracts";
import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { request } from "../rpc/request.ts";
import { patchFiles } from "./patch.ts";
import type { FeatureProps } from "../ui/controller.ts";
import { createSyntax } from "../theme/syntax.ts";
import { theme } from "../theme/index.ts";
import { Action, destinationGuard, errorMessage } from "./common.tsx";

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    pull_request_diff: typeof DiffRenderable;
  }
}
extend({ pull_request_diff: DiffRenderable });

export function PullRequestDiffPanel(
  props: FeatureProps & {
    reference: PullRequestRef;
    details: PullRequestDetail;
    onClose: () => void;
  },
) {
  const syntax = createSyntax(useRenderer().nativeScene);
  const dimensions = useTerminalDimensions();
  const [result, setResult] = createSignal<PullRequestDiffResult | null>(null);
  const [viewed, setViewed] = createSignal<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = createSignal<string | null>(null);
  const [selected, setSelected] = createSignal(0);
  const [split, setSplit] = createSignal(false);
  const [pane, setPane] = createSignal<"list" | "diff">("list");
  const [loading, setLoading] = createSignal(true);
  const files = createMemo(() => patchFiles(result()?.patch ?? ""));
  const current = createMemo(() => files()[Math.min(selected(), files().length - 1)]);
  const environment = createMemo(() => props.state()?.environmentId);
  createEffect(() => {
    const environmentId = environment();
    const reference = props.reference;
    let active = true;
    setLoading(true);
    setResult(null);
    setFailure(null);
    if (!environmentId) return;
    if (props.details.capabilities.viewedFiles)
      void request(props.client, WS_METHODS.pullRequestsFilesViewed, reference).then(
        (value) => {
          if (active)
            setViewed(
              new Set(
                value.files.filter((file) => file.state === "viewed").map((file) => file.path),
              ),
            );
        },
        (error) => {
          if (active) setFailure(errorMessage(error));
        },
      );
    void props.client
      .pullRequestDiff(reference)
      .then(
        (value) => {
          if (active) setResult(value);
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
  onCleanup(() => syntax.destroy());

  function more() {
    const value = result();
    if (!value?.nextCursor) return;
    const guard = destinationGuard(props);
    void props.ui.run(async () => {
      guard();
      const next = await props.client.pullRequestDiff({
        ...props.reference,
        cursor: value.nextCursor!,
      });
      guard();
      setResult({
        ...next,
        patch: value.patch + "\n" + next.patch,
        truncated: value.truncated || next.truncated,
        withheldFilesReadable: value.withheldFilesReadable ?? next.withheldFilesReadable,
        omittedFileStats: [
          ...new Map(
            [...(value.omittedFileStats ?? []), ...(next.omittedFileStats ?? [])].map((file) => [
              file.path,
              file,
            ]),
          ).values(),
        ],
      });
    });
  }
  function withheld() {
    const value = result();
    const guard = destinationGuard(props);
    if (!value?.withheldFilesReadable || !value.omittedFileStats?.length) return;
    props.ui.choose(
      "Large files",
      value.omittedFileStats.map((file) => ({
        title: file.path,
        description: `+${file.additions} −${file.deletions}`,
        run: () =>
          void props.ui.run(async () => {
            guard();
            const next = await props.client.pullRequestDiff({
              ...props.reference,
              path: file.path,
            });
            guard();
            setResult((previous) => ({
              ...next,
              nextCursor: previous?.nextCursor ?? null,
              withheldFilesReadable: previous?.withheldFilesReadable,
              omittedFileStats: previous?.omittedFileStats?.filter(
                (entry) => entry.path !== file.path,
              ),
              patch: `${previous?.patch ?? ""}\n${next.patch}`,
            }));
            setSelected(files().length - 1);
            setPane("diff");
          }),
      })),
    );
  }
  function comment() {
    const file = current();
    if (
      !file ||
      !/^@@ /m.test(file.patch) ||
      !props.details.capabilities.review.inlineComment ||
      !props.details.capabilities.review.verdicts.includes("comment") ||
      !props.details.viewerPermissions.verdicts.includes("comment")
    )
      return;
    const guard = destinationGuard(props);
    const ref = props.reference;
    const original = /^--- (.+)$/m.exec(file.patch)?.[1];
    const oldPath =
      original && original !== "/dev/null"
        ? unquoteGitPatchPath(original).replace(/^a\//, "")
        : undefined;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/m.exec(file.patch);
    props.ui.form({
      title: `Comment on ${file.path}`,
      fields: [
        {
          name: "position",
          label: "Line type",
          type: "select",
          value: "added",
          options: [
            { label: "Added line", value: "added" },
            { label: "Deleted line", value: "deleted" },
            { label: "Unchanged context", value: "context" },
          ],
        },
        {
          name: "newLine",
          label: "New-file line",
          type: "number",
          value: hunk?.[2] ?? "1",
          description: "Used for added lines and context.",
        },
        {
          name: "oldLine",
          label: "Old-file line",
          type: "number",
          value: hunk?.[1] ?? "1",
          description: "Used for deleted lines and context.",
        },
        {
          name: "side",
          label: "Context side",
          type: "select",
          value: "right",
          options: [
            { label: "New file", value: "right" },
            { label: "Old file", value: "left" },
          ],
        },
        { name: "body", label: "Comment", type: "multiline", required: true },
      ],
      submitLabel: "Post inline comment",
      onSubmit: async (values) => {
        guard();
        const line = (name: string) => {
          const value = Number(values[name]);
          if (!Number.isSafeInteger(value) || value < 1)
            throw new Error("Line numbers must be positive whole numbers.");
          return value;
        };
        const position: PullRequestReviewPosition =
          values.position === "deleted"
            ? { kind: "deleted", oldLine: line("oldLine") }
            : values.position === "context"
              ? {
                  kind: "context",
                  oldLine: line("oldLine"),
                  newLine: line("newLine"),
                  side: values.side === "left" ? "left" : "right",
                }
              : { kind: "added", newLine: line("newLine") };
        await request(props.client, WS_METHODS.pullRequestsSubmitReview, {
          ...ref,
          verdict: "comment",
          body: "",
          comments: [
            {
              path: file.path,
              ...(oldPath && oldPath !== file.path ? { oldPath } : {}),
              position,
              body: values.body ?? "",
            },
          ],
        });
        props.ui.notify("Inline review comment posted.");
      },
    });
  }
  function markViewed() {
    const file = current();
    if (!file || !props.details.capabilities.viewedFiles) return;
    const guard = destinationGuard(props);
    const ref = props.reference;
    const next = !viewed().has(file.path);
    void props.ui.run(
      async () => {
        guard();
        await request(props.client, WS_METHODS.pullRequestsSetFilesViewed, {
          ...ref,
          files: [
            {
              path: file.path,
              viewed: next,
              ...(props.details.headSha ? { revision: props.details.headSha } : {}),
            },
          ],
        });
        guard();
        setViewed((previous) => {
          const set = new Set(previous);
          if (next) set.add(file.path);
          else set.delete(file.path);
          return set;
        });
      },
      next ? "File marked viewed." : "File marked unviewed.",
    );
  }
  useKeyboard((event) => {
    if (!props.focused || props.ui.modal() || event.ctrl || event.meta) return;
    if (event.name === "escape") props.onClose();
    else if (event.name === "right" || event.name === "return") setPane("diff");
    else if (event.name === "left") setPane("list");
    else if (event.name === "v") setSplit((value) => !value);
    else if (event.name === "m") more();
    else if (event.name === "l") withheld();
    else if (event.name === "c") comment();
    else if (event.name === "w") markViewed();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  return (
    <box flexGrow={1} flexDirection="column" minHeight={0} onMouseDown={props.onFocus}>
      <box padding={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={1}>
          #{props.reference.number} changes
        </text>
        <Action label="Back [esc]" onPress={props.onClose} />
      </box>
      <box flexDirection="row" paddingX={1} gap={2}>
        <Show
          when={
            current() &&
            /^@@ /m.test(current()!.patch) &&
            props.details.capabilities.review.inlineComment &&
            props.details.capabilities.review.verdicts.includes("comment") &&
            props.details.viewerPermissions.verdicts.includes("comment")
          }
        >
          <Action label="Comment on line [c]" onPress={comment} />
        </Show>
        <Show when={props.details.capabilities.viewedFiles}>
          <Action
            label={
              current() && viewed().has(current()!.path) ? "Mark unviewed [w]" : "Mark viewed [w]"
            }
            onPress={markViewed}
          />
        </Show>
      </box>
      <Show when={loading()}>
        <text fg={theme.textMuted}>Loading changed files…</text>
      </Show>
      <Show when={failure()}>
        <text fg={theme.error} wrapMode="word">
          {failure()}
        </text>
      </Show>
      <Show when={result()?.truncated}>
        <text fg={theme.warning}>The host omitted content from this page.</text>
      </Show>
      <box flexGrow={1} flexDirection="row" minHeight={0}>
        <select
          width="32%"
          flexGrow={1}
          flexShrink={0}
          focused={props.focused && !props.ui.modal() && pane() === "list"}
          options={files().map((file) => ({
            name: `${viewed().has(file.path) ? "✓ " : ""}${file.path}`,
            description: "",
          }))}
          showDescription={false}
          selectedIndex={selected()}
          onChange={setSelected}
          onSelect={() => setPane("diff")}
          onMouseDown={() => setPane("list")}
          backgroundColor={theme.background}
          textColor={theme.text}
          selectedTextColor={theme.primary}
          selectedBackgroundColor={theme.backgroundElement}
          showScrollIndicator
        />
        <scrollbox
          flexGrow={2}
          minWidth={0}
          scrollX
          scrollY
          focused={props.focused && !props.ui.modal() && pane() === "diff"}
          onMouseDown={() => setPane("diff")}
        >
          <Show when={current()}>
            {(file) => (
              <Show
                when={/^@@ /m.test(file().patch)}
                fallback={
                  <text fg={theme.textMuted} wrapMode="word">
                    {file().patch}
                  </text>
                }
              >
                <pull_request_diff
                  diff={file().patch}
                  view={split() && dimensions().width >= 110 ? "split" : "unified"}
                  filetype={pathToFiletype(file().path) ?? "text"}
                  syntaxStyle={syntax}
                  showLineNumbers
                  wrapMode="none"
                  fg={theme.text}
                  contextBg={theme.background}
                  contextContentBg={theme.background}
                  addedBg={theme.diffAddedBg}
                  addedContentBg={theme.diffAddedBg}
                  removedBg={theme.diffRemovedBg}
                  removedContentBg={theme.diffRemovedBg}
                  addedSignColor={theme.diffAdded}
                  removedSignColor={theme.diffRemoved}
                />
              </Show>
            )}
          </Show>
        </scrollbox>
      </box>
      <Show when={result()?.nextCursor}>
        <Action label="Load more changes [m]" onPress={more} />
      </Show>
      <Show when={result()?.withheldFilesReadable && result()?.omittedFileStats?.length}>
        <Action label="Read large files [l]" onPress={withheld} />
      </Show>
      <text fg={theme.textMuted} paddingX={1}>
        ↑↓ files · → review · ← files · v split/unified · esc pull request
      </text>
    </box>
  );
}
