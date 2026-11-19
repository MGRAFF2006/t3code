import { scrollbarOptions } from "../ui/scroll.ts";
import { DiffRenderable, pathToFiletype, type ScrollBoxRenderable } from "@opentui/core";
import { extend, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { WS_METHODS, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import { request } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { useActiveKeyboard } from "../ui/keyboard.ts";
import { createSyntax } from "../theme/syntax.ts";
import { workspaceFilePath } from "./logic.ts";
import type { WorkspaceContext } from "./types.ts";

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    workspace_diff: typeof DiffRenderable;
  }
}
extend({ workspace_diff: DiffRenderable });

export function ChangesPanel(
  props: WorkspaceContext & { visible: boolean; compact?: boolean | undefined },
) {
  const syntax = createSyntax(useRenderer().nativeScene);
  const dimensions = useTerminalDimensions();
  onCleanup(() => syntax.destroy());
  const [scope, setScope] = createSignal<"working-tree" | "branch-range" | "commit">(
    "working-tree",
  );
  const [commit, setCommit] = createSignal("");
  const [base, setBase] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [reviewing, setReviewing] = createSignal(false);
  const [preferences, setPreferences] = createSignal(props.client.preferences());
  onCleanup(props.client.subscribePreferences(setPreferences));
  const split = () => preferences().diffView === "split";
  const toggleSplit = () => {
    void props.ui.run(() =>
      props.client.updatePreferences({ diffView: split() ? "unified" : "split" }),
    );
  };
  const [ignoreWhitespace, setIgnoreWhitespace] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  const environment = createMemo(() => props.state()?.environmentId);
  const connection = createMemo(() => props.state()?.connection);
  let fileScroll: ScrollBoxRenderable | undefined;
  let diffScroll: ScrollBoxRenderable | undefined;
  const changesKey = createMemo(() =>
    props
      .status()
      .local?.workingTree.files.map((file) => `${file.path}:${file.insertions}:${file.deletions}`)
      .join("\0"),
  );
  const [metadata] = createResource(
    () => ({
      cwd: props.cwd(),
      environment: environment(),
      connection: connection(),
      mutation: props.mutation(),
      scope: scope(),
      commit: commit(),
      base: base(),
      ignoreWhitespace: ignoreWhitespace(),
      revision: revision(),
      changes: changesKey(),
    }),
    async ({ cwd, scope: sourceKind, commit: commitSha, base: baseRef, ignoreWhitespace }) => {
      if (!cwd) return { source: null, error: "Select a project to review changes." };
      try {
        const result = await request(props.client, WS_METHODS.reviewGetDiffPreview, {
          cwd,
          metadataOnly: true,
          ignoreWhitespace,
          ...(sourceKind === "commit" ? { commitSha } : { sourceKind }),
          ...(baseRef ? { baseRef } : {}),
        });
        return {
          source: result.sources.find((source) => source.kind === sourceKind) ?? null,
          error: "",
        };
      } catch (cause) {
        return { source: null, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  );
  const source = () => (metadata.loading ? null : metadata()?.source);
  const files = () => source()?.files ?? [];
  const active = () => Math.max(0, Math.min(selected(), files().length - 1));
  const currentFile = () => files()[active()];
  const [patch] = createResource(
    () => {
      const value = source();
      const file = currentFile();
      const cwd = props.cwd();
      return value && file && cwd
        ? { cwd, source: value, file, ignoreWhitespace: ignoreWhitespace(), revision: revision() }
        : null;
    },
    async ({ cwd, source: value, file, ignoreWhitespace }) => {
      try {
        const result = await request(props.client, WS_METHODS.reviewGetDiffPreview, {
          cwd,
          ignoreWhitespace,
          file: { path: file.path, previousPath: file.previousPath, sourceKind: value.kind },
          ...(value.kind === "commit" ? { commitSha: commit() } : { sourceKind: value.kind }),
          ...(base() ? { baseRef: base() } : {}),
        });
        return {
          source: result.sources.find((entry) => entry.kind === value.kind) ?? null,
          error: "",
        };
      } catch (cause) {
        return { source: null, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  );

  function select(index: number) {
    setSelected(Math.max(0, Math.min(files().length - 1, index)));
    const file = currentFile();
    if (file) fileScroll?.scrollChildIntoView(`workspace-change-${file.path}`);
    diffScroll?.scrollTo(0);
  }

  function chooseScope() {
    props.ui.choose("Review changes", [
      {
        title: "Uncommitted changes",
        description: "Working tree and untracked files",
        run: () => {
          setScope("working-tree");
          select(0);
        },
      },
      {
        title: "Branch changes",
        description: "Compare this branch with its base",
        run: () => {
          setScope("branch-range");
          select(0);
        },
      },
      {
        title: "Commit…",
        description: "Review a commit from this branch",
        run: () => void props.ui.run(chooseCommit),
      },
      {
        title: "Compare with branch…",
        run: () =>
          props.ui.form({
            title: "Compare branch",
            fields: [{ name: "base", label: "Base branch or ref", value: base(), required: true }],
            submitLabel: "Compare",
            onSubmit: async ({ base: value = "" }) => {
              setBase(value);
              setScope("branch-range");
              select(0);
            },
          }),
      },
    ]);
  }

  async function chooseCommit() {
    const cwd = props.cwd();
    if (!cwd) return;
    const result = await request(props.client, WS_METHODS.reviewGetBranchCommits, {
      cwd,
      ...(base() ? { baseRef: base() } : {}),
    });
    props.ui.choose(
      `Branch commits${result.truncated ? " (recent)" : ""}`,
      result.commits.map((entry) => ({
        title: entry.subject,
        description: `${entry.sha.slice(0, 8)}  ${entry.committedAt}`,
        run: () => {
          setCommit(entry.sha);
          setScope("commit");
          select(0);
        },
      })),
    );
  }

  function chooseFile() {
    props.ui.choose(
      "Changed files",
      files().map((file, index) => ({
        title: file.path,
        description: `+${file.additions} −${file.deletions}${file.previousPath ? `  from ${file.previousPath}` : ""}`,
        run: () => {
          select(index);
          setReviewing(true);
        },
      })),
    );
  }

  function openCurrentFile() {
    const file = currentFile();
    if (!file) return;
    const root = props.status().local?.workingTree.rootPath;
    props.ui.openFile(root ? workspaceFilePath(root, props.cwd() ?? root, file.path) : file.path);
  }

  async function fileVersions() {
    const target = source();
    const file = currentFile();
    const cwd = props.cwd();
    const destination = environment();
    if (!target || !file || !cwd) return props.ui.notify("Choose a changed file first.");
    const current = () =>
      cwd === props.cwd() &&
      destination === environment() &&
      source()?.diffHash === target.diffHash &&
      currentFile()?.path === file.path;
    const result = await request(props.client, WS_METHODS.reviewGetDiffFileContents, {
      cwd,
      sourceKind: target.kind,
      changeType: file.changeType ?? "change",
      baseRef: target.baseRef,
      headRef: target.headRef,
      oldPath: file.previousPath ?? file.path,
      newPath: file.path,
    });
    if (!current()) throw new Error("The selected diff changed. Open file versions again.");
    const show = (label: string, contents: string) => {
      if (!current()) throw new Error("The selected diff changed. Open file versions again.");
      const limit = 1024 * 1024;
      props.ui.text(
        label,
        contents.length > limit
          ? `${contents.slice(0, limit)}\n\nPreview truncated at 1,048,576 characters.`
          : contents || "This version has no contents.",
        pathToFiletype(file.path) ?? "text",
      );
    };
    props.ui.choose("File versions", [
      {
        title: "Before change",
        description: file.previousPath ?? file.path,
        run: () => show(`Before: ${file.previousPath ?? file.path}`, result.oldContents),
      },
      {
        title: "After change",
        description: file.path,
        run: () => show(`After: ${file.path}`, result.newContents),
      },
    ]);
  }

  useActiveKeyboard(
    () => props.visible && props.focused && !props.ui.modal(),
    (event) => {
      if (event.meta) return;
      if (event.name === "s") chooseScope();
      else if (event.name === "f") void props.ui.run(fileVersions);
      else if (event.name === "/") chooseFile();
      else if (event.name === "o") openCurrentFile();
      else if (event.name === "v") toggleSplit();
      else if (event.name === "w") setIgnoreWhitespace((value) => !value);
      else if (event.name === "r") {
        setRevision((value) => value + 1);
        void props.ui.run(props.refresh);
      } else if (event.name === "escape") setReviewing(false);
      else if (event.name === "return" || event.name === "right") setReviewing(true);
      else if (reviewing()) {
        if (event.name === "up") diffScroll?.scrollBy(-1);
        else if (event.name === "down") diffScroll?.scrollBy(1);
        else if (event.name === "pageup") diffScroll?.scrollBy(-1, "viewport");
        else if (event.name === "pagedown") diffScroll?.scrollBy(1, "viewport");
        else if (event.name === "home") diffScroll?.scrollTo(0);
        else if (event.name === "end") diffScroll?.scrollTo(Infinity);
        else if (event.name === "n") select(active() + 1);
        else if (event.name === "p") select(active() - 1);
        else return;
      } else if (event.name === "up") select(active() - 1);
      else if (event.name === "down") select(active() + 1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    },
  );

  return (
    <box visible={props.visible} flexGrow={1} minHeight={0} onMouseDown={props.onFocus}>
      <box flexDirection="row" gap={2} height={1} flexShrink={0} paddingX={1}>
        <text selectable={false} fg={theme.primary} onMouseDown={chooseScope}>
          {scope() === "working-tree"
            ? "Uncommitted ▾"
            : scope() === "commit"
              ? `Commit ${commit().slice(0, 7)} ▾`
              : "Branch changes ▾"}
        </text>
        <text
          selectable={false}
          fg={theme.textMuted}
          onMouseDown={chooseFile}
        >{`${files().length} files`}</text>
        <text selectable={false} fg={theme.textMuted} onMouseDown={() => toggleSplit()}>
          {split() ? "Split" : "Unified"}
        </text>
        <text
          selectable={false}
          fg={theme.textMuted}
          onMouseDown={() => void props.ui.run(fileVersions)}
        >
          Versions
        </text>
      </box>
      <Show when={metadata.loading}>
        <text fg={theme.textMuted} paddingX={1}>
          Loading changes…
        </text>
      </Show>
      <Show when={metadata()?.error}>
        <text fg={theme.error} paddingX={1} wrapMode="word">
          {metadata()?.error}
        </text>
      </Show>
      <Show when={!metadata.loading && !metadata()?.error && files().length === 0}>
        <text fg={theme.textMuted} padding={1}>
          No changes in this selection.
        </text>
      </Show>
      <box flexDirection={props.compact ? "column" : "row"} flexGrow={1} minHeight={0}>
        <Show when={!props.compact || !reviewing()}>
          <scrollbox
            scrollbarOptions={scrollbarOptions()}
            ref={(value) => {
              fileScroll = value;
            }}
            width={props.compact ? "100%" : "30%"}
            flexGrow={props.compact ? 1 : 0}
            minHeight={0}
            paddingX={1}
            scrollY
          >
            <For each={files()}>
              {(file, index) => (
                <box
                  id={`workspace-change-${file.path}`}
                  height={2}
                  flexShrink={0}
                  backgroundColor={
                    active() === index() ? theme.backgroundElement : theme.background
                  }
                  onMouseDown={() => {
                    props.onFocus();
                    select(index());
                    setReviewing(true);
                  }}
                >
                  <text selectable={false} fg={theme.text} truncate>
                    {file.path}
                  </text>
                  <text
                    selectable={false}
                    fg={theme.textMuted}
                  >{`+${file.additions} −${file.deletions}${file.changeType === "new" ? "  new" : file.changeType === "deleted" ? "  deleted" : ""}`}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </Show>
        <Show when={!props.compact || reviewing()}>
          <box flexGrow={1} minWidth={0} minHeight={0} paddingX={1}>
            <Show when={currentFile()}>
              {(file) => (
                <text
                  selectable={false}
                  fg={theme.textMuted}
                  truncate
                  onMouseDown={openCurrentFile}
                >{`${file().path}  [o] open`}</text>
              )}
            </Show>
            <Show when={patch.loading}>
              <text fg={theme.textMuted}>Loading diff…</text>
            </Show>
            <Show when={patch()?.error}>
              <text fg={theme.error} wrapMode="word">
                {patch()?.error}
              </text>
            </Show>
            <Show when={patch()?.source?.truncated}>
              <text fg={theme.warning} wrapMode="word">
                This diff was truncated by the server.
              </text>
            </Show>
            <scrollbox
              scrollbarOptions={scrollbarOptions()}
              ref={(value) => {
                diffScroll = value;
              }}
              flexGrow={1}
              minHeight={0}
              scrollX
              scrollY
              onMouseDown={() => {
                props.onFocus();
                setReviewing(true);
              }}
            >
              <Show when={!patch.loading && patch()?.source}>
                {(value) => (
                  <DiffContent
                    source={value()}
                    path={currentFile()?.path ?? ""}
                    split={split() && dimensions().width >= 110 && !props.compact}
                    syntax={syntax}
                    wrap={preferences().wordWrap}
                  />
                )}
              </Show>
            </scrollbox>
          </box>
        </Show>
      </box>
      <text fg={theme.textMuted} flexShrink={0} paddingX={1}>
        {reviewing()
          ? "↑↓ scroll · n/p file · esc files · f versions · o open · s scope"
          : "↑↓ file · enter review · / find · f versions · s scope · v view · w whitespace"}
      </text>
    </box>
  );
}

function DiffContent(props: {
  source: ReviewDiffPreviewSource;
  path: string;
  split: boolean;
  wrap: boolean;
  syntax: ReturnType<typeof createSyntax>;
}) {
  return (
    <workspace_diff
      diff={props.source.diff}
      filetype={pathToFiletype(props.path) ?? "text"}
      view={props.split ? "split" : "unified"}
      syntaxStyle={props.syntax}
      fg={theme.text}
      wrapMode={props.wrap ? "word" : "none"}
      showLineNumbers
      lineNumberFg={theme.textMuted}
      addedBg={theme.diffAddedBg}
      removedBg={theme.diffRemovedBg}
      contextBg={theme.background}
      addedSignColor={theme.diffAdded}
      removedSignColor={theme.diffRemoved}
    />
  );
}
