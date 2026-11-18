import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type GitRunStackedActionInput,
  type VcsRef,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { removeUnusedWorktree, worktreeInUse } from "./worktrees.ts";
import { request, subscribe } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import type { WorkspaceContext } from "./types.ts";

export function GitPanel(props: WorkspaceContext & { visible: boolean }) {
  const [selected, setSelected] = createSignal(new Set<string>());
  const [cursor, setCursor] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal("");
  const [log, setLog] = createSignal("");
  const environment = createMemo(() => props.state()?.environmentId);
  createEffect(
    on(
      () => [environment(), props.cwd()] as const,
      () => {
        setSelected(new Set<string>());
        setCursor(0);
        if (!busy()) {
          setProgress("");
          setLog("");
        }
      },
    ),
  );
  let scroll: ScrollBoxRenderable | undefined;
  let stopAction: (() => void) | undefined;
  let finishAction: (() => void) | undefined;
  onCleanup(() => {
    stopAction?.();
    finishAction?.();
  });
  const files = () => props.status().local?.workingTree.files ?? [];
  const selectedPaths = createMemo(() =>
    files()
      .filter((file) => selected().has(file.path))
      .map((file) => file.path),
  );
  const active = () => Math.max(0, Math.min(cursor(), files().length - 1));

  function capture() {
    const state = props.state();
    const cwd = props.cwd();
    if (!cwd) throw new Error("Select a project first.");
    const thread =
      state?.thread?.thread ??
      state?.shell?.threads.find((entry) => entry.id === state.selectedThreadId);
    return { cwd, environmentId: state?.environmentId, thread };
  }

  function assertCurrent(target: ReturnType<typeof capture>) {
    if (props.state()?.environmentId !== target.environmentId)
      throw new Error("The connected environment changed. Try again in the selected environment.");
    if (props.cwd() !== target.cwd)
      throw new Error("The selected checkout changed. Try again in that checkout.");
  }

  function assertIdle(cwd: string) {
    const shell = props.state()?.shell;
    const running = shell?.threads.find((thread) => {
      const root =
        thread.worktreePath ??
        shell.projects.find((project) => project.id === thread.projectId)?.workspaceRoot;
      return root === cwd && thread.activeRunId !== null;
    });
    if (running)
      throw new Error(`Stop the running thread “${running.title}” before changing its checkout.`);
  }

  async function updateThread(
    target: ReturnType<typeof capture>,
    branch: string | null,
    worktreePath: string | null,
  ) {
    if (!target.thread) return;
    assertCurrent(target);
    await request(props.client, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
      type: "thread.metadata.update",
      commandId: CommandId.make(SecureRandom.uuidV4Unsafe()),
      threadId: target.thread.id,
      branch,
      worktreePath,
      expectedBranch: target.thread.branch,
      expectedWorktreePath: target.thread.worktreePath,
    });
  }

  async function switchBranch(ref: VcsRef) {
    const target = capture();
    assertIdle(target.cwd);
    if (ref.worktreePath && ref.worktreePath !== target.cwd) {
      if (!target.thread) throw new Error("Select a thread to use an existing worktree.");
      await updateThread(target, ref.name, ref.worktreePath);
      props.ui.notify(`Using ${ref.name} in ${ref.worktreePath}`);
      return;
    }
    const result = await request(props.client, WS_METHODS.vcsSwitchRef, {
      cwd: target.cwd,
      refName: ref.name,
    });
    await updateThread(target, result.refName, target.thread?.worktreePath ?? null);
    await props.refresh();
    props.ui.notify(`Switched to ${result.refName ?? "detached HEAD"}`);
  }

  async function branches(query?: string) {
    const target = capture();
    const result = await request(props.client, WS_METHODS.vcsListRefs, {
      cwd: target.cwd,
      refKind: "all",
      limit: 200,
      ...(query?.trim() ? { query: query.trim() } : {}),
    });
    assertCurrent(target);
    props.ui.choose(
      `Switch branch${result.nextCursor !== null ? ` (${result.totalCount} total)` : ""}`,
      [
        { title: "Create branch…", category: "Actions", run: createBranch },
        {
          title: "Find branch…",
          category: "Actions",
          run: () =>
            props.ui.form({
              title: "Find branch",
              fields: [{ name: "query", label: "Branch name", required: true }],
              submitLabel: "Find",
              onSubmit: async ({ query: value = "" }) => branches(value),
            }),
        },
        ...result.refs.map((ref) => ({
          title: `${ref.current ? "✓ " : ""}${ref.name}`,
          category: ref.isRemote ? "Remote branches" : "Branches",
          description:
            ref.worktreePath ??
            (ref.isDefault
              ? "Default branch"
              : ref.isRemote
                ? "Track this remote branch locally"
                : "Switch checkout"),
          run: () => void props.ui.run(() => switchBranch(ref)),
        })),
      ],
    );
  }

  function createBranch() {
    const target = capture();
    props.ui.form({
      title: "Create branch",
      description: `Start from ${props.status().local?.refName ?? "the current checkout"}.`,
      fields: [{ name: "name", label: "Branch name", required: true }],
      submitLabel: "Create and switch",
      onSubmit: async ({ name = "" }) => {
        assertCurrent(target);
        assertIdle(target.cwd);
        const result = await request(props.client, WS_METHODS.vcsCreateRef, {
          cwd: target.cwd,
          refName: name,
          switchRef: true,
        });
        await updateThread(target, result.refName, target.thread?.worktreePath ?? null);
        await props.refresh();
      },
    });
  }

  async function worktrees() {
    const target = capture();
    const result = await request(props.client, WS_METHODS.vcsListRefs, {
      cwd: target.cwd,
      refKind: "local",
      limit: 200,
    });
    assertCurrent(target);
    props.ui.choose("Worktrees", [
      { title: "Create worktree…", category: "Actions", run: createWorktree },
      {
        title: "Remove unused worktree…",
        category: "Actions",
        run: () => {
          void props.ui.run(async () => {
            assertCurrent(target);
            const roots = new Set(
              props.state()?.shell?.projects.map((project) => project.workspaceRoot),
            );
            const candidates = result.refs.filter(
              (ref) =>
                ref.worktreePath && ref.worktreePath !== target.cwd && !roots.has(ref.worktreePath),
            );
            const usage = await Promise.all(
              candidates.map((ref) => worktreeInUse(props.client, ref.worktreePath!)),
            );
            assertCurrent(target);
            const removable = candidates.filter((_ref, index) => !usage[index]);
            if (removable.length === 0)
              return props.ui.notify(
                "No unused worktrees. Worktrees referenced by threads are kept.",
              );
            props.ui.choose(
              "Remove unused worktree",
              removable.map((ref) => ({
                title: ref.name,
                description: ref.worktreePath!,
                run: () =>
                  props.ui.confirm(
                    "Remove worktree?",
                    `${ref.worktreePath}\nGit will refuse removal if it contains changes.`,
                    async () => {
                      assertCurrent(target);
                      await removeUnusedWorktree(props.client, target.cwd, ref.worktreePath!, () =>
                        assertCurrent(target),
                      );
                      await props.refresh();
                    },
                    "Remove worktree",
                  ),
              })),
            );
          });
        },
      },
      ...result.refs
        .filter((ref) => ref.worktreePath)
        .map((ref) => ({
          title: `${ref.worktreePath === target.cwd ? "✓ " : ""}${ref.name}`,
          description: ref.worktreePath!,
          category: "Checkouts",
          run: () => void props.ui.run(() => switchBranch(ref)),
        })),
    ]);
  }

  function createWorktree() {
    const target = capture();
    props.ui.form({
      title: "Create worktree",
      description: "Create a separate checkout and use it for this thread.",
      fields: [
        { name: "branch", label: "New branch", required: true },
        {
          name: "base",
          label: "Start from",
          value: props.status().local?.refName ?? "HEAD",
          required: true,
        },
      ],
      submitLabel: "Create worktree",
      onSubmit: async ({ branch = "", base = "HEAD" }) => {
        assertCurrent(target);
        assertIdle(target.cwd);
        if (!target.thread) throw new Error("Select a thread before creating its worktree.");
        const result = await request(props.client, WS_METHODS.vcsCreateWorktree, {
          cwd: target.cwd,
          refName: base,
          newRefName: branch,
          baseRefName: base,
          path: null,
        });
        try {
          await updateThread(target, result.worktree.refName, result.worktree.path);
        } catch (cause) {
          throw new Error(
            `Created worktree at ${result.worktree.path}, but could not attach the thread: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        }
        props.ui.notify(`Created ${result.worktree.path}`);
      },
    });
  }

  function toggle(path: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleAll() {
    setSelected(
      selectedPaths().length === files().length
        ? new Set<string>()
        : new Set(files().map((file) => file.path)),
    );
  }

  async function runAction(input: Omit<GitRunStackedActionInput, "actionId">) {
    if (busy()) throw new Error("A Git action is already running.");
    setBusy(true);
    setLog("");
    setProgress("Starting…");
    try {
      await new Promise<void>((resolve, reject) => {
        const complete = (error?: Error) => {
          stopAction?.();
          stopAction = undefined;
          finishAction = undefined;
          if (error) reject(error);
          else resolve();
        };
        finishAction = () => complete();
        stopAction = subscribe(
          props.client,
          WS_METHODS.gitRunStackedAction,
          { ...input, actionId: SecureRandom.uuidV4Unsafe() },
          (event) => {
            if (event.kind === "phase_started") setProgress(event.label);
            else if (event.kind === "hook_started") setProgress(`Running ${event.hookName}`);
            else if (event.kind === "hook_output")
              setLog((previous) => `${previous}${event.text}\n`.split("\n").slice(-160).join("\n"));
            else if (event.kind === "action_failed") complete(new Error(event.message));
            else if (event.kind === "action_finished") {
              setProgress(event.result.toast.title);
              props.ui.notify(event.result.toast.title);
              if (input.action !== "push") setSelected(new Set<string>());
              complete();
            }
          },
          complete,
        );
      });
      await props.refresh();
    } finally {
      setBusy(false);
    }
  }

  function commitFiles() {
    if (busy()) return;
    const target = capture();
    const paths = selectedPaths();
    if (paths.length === 0) return props.ui.notify("Select the files you want to commit first.");
    props.ui.form({
      title: `Commit ${paths.length} selected ${paths.length === 1 ? "file" : "files"}`,
      description: paths.join("\n"),
      fields: [{ name: "message", label: "Commit message", type: "multiline", required: true }],
      submitLabel: "Commit selected files",
      onSubmit: async ({ message = "" }) => {
        assertCurrent(target);
        await runAction({
          cwd: props.status().local?.workingTree.rootPath ?? target.cwd,
          action: "commit",
          commitMessage: message,
          filePaths: paths,
          ...(target.thread
            ? { threadId: target.thread.id, projectId: target.thread.projectId }
            : {}),
        });
      },
    });
  }

  function push() {
    const target = capture();
    void props.ui.run(() => runAction({ cwd: target.cwd, action: "push" }));
  }

  function pull() {
    const target = capture();
    void props.ui.run(async () => {
      assertIdle(target.cwd);
      const result = await request(props.client, WS_METHODS.vcsPull, { cwd: target.cwd });
      await props.refresh();
      props.ui.notify(result.status === "pulled" ? "Pulled latest changes" : "Already up to date");
    });
  }

  function gitActions() {
    props.ui.choose("Source control", [
      { title: `Commit ${selectedPaths().length} selected files`, run: commitFiles },
      { title: "Push branch", run: push },
      { title: "Pull latest changes", run: pull },
      {
        title: "Create or open pull request",
        run: () => {
          const target = capture();
          void props.ui.run(() =>
            runAction({
              cwd: target.cwd,
              action: "create_pr",
              ...(target.thread
                ? { threadId: target.thread.id, projectId: target.thread.projectId }
                : {}),
            }),
          );
        },
      },
      { title: "Branches…", run: () => void props.ui.run(branches) },
      { title: "Worktrees…", run: () => void props.ui.run(worktrees) },
      { title: "Review changes", run: props.ui.showChanges },
    ]);
  }

  function initialize() {
    const target = capture();
    void props.ui.run(async () => {
      await request(props.client, WS_METHODS.vcsInit, { cwd: target.cwd });
      await props.refresh();
    }, "Repository initialized");
  }

  useKeyboard((event) => {
    if (!props.visible || !props.focused || props.ui.modal() || busy() || event.meta) return;
    if (event.name === "up" || event.name === "down") {
      const index = Math.max(
        0,
        Math.min(files().length - 1, active() + (event.name === "up" ? -1 : 1)),
      );
      setCursor(index);
      const file = files()[index];
      if (file) scroll?.scrollChildIntoView(`workspace-git-${file.path}`);
    } else if (event.name === "space") {
      const file = files()[active()];
      if (file) toggle(file.path);
    } else if (event.name === "a") toggleAll();
    else if (event.name === "c") commitFiles();
    else if (event.name === "p") push();
    else if (event.name === "f") pull();
    else if (event.name === "b") void props.ui.run(branches);
    else if (event.name === "w") void props.ui.run(worktrees);
    else if (event.name === "g") gitActions();
    else if (event.name === "i" && props.status().local?.isRepo === false) initialize();
    else if (event.name === "r") void props.ui.run(props.refresh);
    else if (event.name === "return") props.ui.showChanges();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  return (
    <box
      visible={props.visible}
      flexGrow={1}
      minHeight={0}
      paddingX={1}
      onMouseDown={props.onFocus}
    >
      <Show
        when={props.status().local}
        fallback={<text fg={theme.textMuted}>Loading repository status…</text>}
      >
        {(local) => (
          <Show
            when={local().isRepo}
            fallback={
              <box>
                <text fg={theme.textMuted}>This project is not a Git repository.</text>
                <text fg={theme.primary} onMouseDown={initialize}>
                  Initialize repository [i]
                </text>
              </box>
            }
          >
            <box flexDirection="row" gap={2} height={1} flexShrink={0}>
              <text
                fg={theme.primary}
                onMouseDown={() => void props.ui.run(branches)}
              >{`${local().refName ?? "Detached HEAD"} ▾`}</text>
              <text fg={theme.textMuted} onMouseDown={() => void props.ui.run(worktrees)}>
                Worktrees
              </text>
              <text fg={theme.textMuted} onMouseDown={gitActions}>
                More ▾
              </text>
              <Show when={props.status().remote}>
                {(remote) => (
                  <text
                    fg={theme.textMuted}
                  >{`↑${remote().aheadCount} ↓${remote().behindCount}`}</text>
                )}
              </Show>
            </box>
            <text fg={theme.textMuted} truncate flexShrink={0}>
              {props.cwd()}
            </text>
            <box flexDirection="row" gap={2} marginY={1} flexShrink={0}>
              <text
                fg={busy() ? theme.textMuted : theme.primary}
                onMouseDown={commitFiles}
              >{`Commit (${selectedPaths().length})`}</text>
              <text
                fg={theme.primary}
                onMouseDown={() => {
                  if (!busy()) push();
                }}
              >
                Push
              </text>
              <text
                fg={theme.primary}
                onMouseDown={() => {
                  if (!busy()) pull();
                }}
              >
                Pull
              </text>
              <text fg={theme.textMuted} onMouseDown={toggleAll}>
                {selectedPaths().length === files().length && files().length > 0
                  ? "Deselect all"
                  : "Select all"}
              </text>
            </box>
            <Show when={files().length === 0}>
              <text fg={theme.textMuted}>Working tree clean.</text>
            </Show>
            <scrollbox
              ref={(value) => {
                scroll = value;
              }}
              flexGrow={1}
              minHeight={0}
              scrollY
            >
              <For each={files()}>
                {(file, index) => (
                  <box
                    id={`workspace-git-${file.path}`}
                    height={1}
                    flexShrink={0}
                    flexDirection="row"
                    backgroundColor={
                      active() === index() ? theme.backgroundElement : theme.background
                    }
                    onMouseDown={() => {
                      props.onFocus();
                      setCursor(index());
                      toggle(file.path);
                    }}
                  >
                    <text
                      fg={selected().has(file.path) ? theme.primary : theme.textMuted}
                      width={4}
                      flexShrink={0}
                    >
                      {selected().has(file.path) ? "[✓] " : "[ ] "}
                    </text>
                    <text fg={theme.text} flexGrow={1} truncate>
                      {file.path}
                    </text>
                    <text fg={theme.diffAdded} flexShrink={0}>{` +${file.insertions}`}</text>
                    <text fg={theme.diffRemoved} flexShrink={0}>{` −${file.deletions}`}</text>
                  </box>
                )}
              </For>
            </scrollbox>
            <Show when={progress()}>
              <text fg={busy() ? theme.primary : theme.textMuted} flexShrink={0}>
                {progress()}
              </text>
            </Show>
            <Show when={log()}>
              <text
                fg={theme.textMuted}
                onMouseDown={() => props.ui.text("Git output", log(), "text")}
                flexShrink={0}
              >
                View hook output
              </text>
            </Show>
            <Show when={props.status().remote?.pr}>
              {(pr) => (
                <text
                  fg={theme.primary}
                  truncate
                  flexShrink={0}
                  onMouseDown={() => props.ui.openArea("pull-requests")}
                >{`#${pr().number} ${pr().title}`}</text>
              )}
            </Show>
          </Show>
        )}
      </Show>
      <text fg={theme.textMuted} marginTop={1} flexShrink={0}>
        space select · a all · c commit · p push · f pull · g actions
      </text>
    </box>
  );
}
