import { pathToFiletype, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { WS_METHODS, type ProjectEntry, type ProjectReadFileResult } from "@t3tools/contracts";
import { request } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { createSyntax } from "../theme/syntax.ts";
import { FileEditor } from "./editor.tsx";
import { basename, fileSaveProblem } from "./logic.ts";
import type { WorkspaceContext } from "./types.ts";

interface OpenFile {
  cwd: string;
  environmentId: string | null;
  file: ProjectReadFileResult;
  draft: string;
  editing: boolean;
}

export function FilesPanel(
  props: WorkspaceContext & {
    visible: boolean;
    openPath?: string | undefined;
    compact?: boolean | undefined;
  },
) {
  const syntax = createSyntax(useRenderer().nativeScene);
  onCleanup(() => syntax.destroy());
  const [revision, setRevision] = createSignal(0);
  const [children, setChildren] = createSignal(new Map<string, readonly ProjectEntry[]>());
  const [expanded, setExpanded] = createSignal(new Set<string>());
  const [selected, setSelected] = createSignal(0);
  const [preferences, setPreferences] = createSignal(props.client.preferences());
  onCleanup(props.client.subscribePreferences(setPreferences));
  const [opened, setOpened] = createSignal<OpenFile | null>(null);
  const [preview, setPreview] = createSignal(false);
  const [reading, setReading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const environment = createMemo(() => props.state()?.environmentId ?? null);
  const connection = createMemo(() => props.state()?.connection);
  let readVersion = 0;
  let treeScroll: ScrollBoxRenderable | undefined;
  let codeScroll: ScrollBoxRenderable | undefined;
  const key = (path: string) => `${environment() ?? ""}\0${props.cwd() ?? ""}\0${path}`;
  const [listing] = createResource(
    () => ({
      cwd: props.cwd(),
      environment: environment(),
      connection: connection(),
      mutation: props.mutation(),
      revision: revision(),
    }),
    async ({ cwd }) => {
      if (!cwd)
        return { entries: [], truncated: false, error: "Select a project to browse its files." };
      try {
        const result = await request(props.client, WS_METHODS.projectsListEntries, {
          cwd,
          directoryPath: "",
        });
        return { ...result, error: "" };
      } catch (cause) {
        return {
          entries: [],
          truncated: false,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
  );
  const rows = createMemo(() => {
    const result: { entry: ProjectEntry; depth: number }[] = [];
    function visit(entries: readonly ProjectEntry[], depth: number) {
      for (const entry of [...entries].sort(
        (a, b) =>
          Number(b.kind === "directory") - Number(a.kind === "directory") ||
          a.path.localeCompare(b.path),
      )) {
        result.push({ entry, depth });
        if (entry.kind === "directory" && expanded().has(key(entry.path))) {
          visit(children().get(key(entry.path)) ?? [], depth + 1);
        }
      }
    }
    visit(listing.loading ? [] : (listing()?.entries ?? []), 0);
    return result;
  });
  const dirty = () => {
    const value = opened();
    return value !== null && value.draft !== value.file.contents;
  };
  const active = () => Math.max(0, Math.min(selected(), rows().length - 1));
  onCleanup(
    props.ui.registerNavigationGuard(
      () => (dirty() ? `Unsaved edits in ${opened()!.file.relativePath}` : null),
      () => {
        readVersion += 1;
        setReading(false);
        setOpened(null);
        setPreview(false);
      },
    ),
  );

  async function readFile(path: string, line = 1, reveal = true) {
    const cwd = props.cwd();
    if (!cwd) return;
    if (reveal && /\.(png|jpe?g|webp|gif|avif|bmp|svg|ico)$/i.test(path) && props.ui.previewImage) {
      props.ui.previewImage({ _tag: "draft-workspace-file", cwd, path }, path);
      return;
    }
    const environmentId = props.state()?.environmentId ?? null;
    const version = ++readVersion;
    setReading(true);
    try {
      const file = await request(props.client, WS_METHODS.projectsReadFile, {
        cwd,
        relativePath: path,
      });
      if (
        version !== readVersion ||
        environmentId !== props.state()?.environmentId ||
        cwd !== props.cwd()
      )
        return;
      setOpened({ cwd, environmentId, file, draft: file.contents, editing: false });
      if (reveal) {
        setPreview(true);
        codeScroll?.scrollTo(Math.max(0, line - 1));
      }
    } finally {
      if (version === readVersion) setReading(false);
    }
  }

  function openFile(path: string, line = 1) {
    if (saving()) return;
    const action = () => readFile(path, line);
    if (dirty())
      props.ui.confirm(
        "Discard unsaved changes?",
        opened()!.file.relativePath,
        action,
        "Discard and open",
      );
    else void props.ui.run(action);
  }

  createEffect(
    on(
      () => [props.openPath, props.cwd(), environment()] as const,
      ([path]) => {
        if (path) openFile(path);
      },
    ),
  );

  createEffect(() => {
    const cwd = props.cwd();
    const environmentId = environment();
    const current = opened();
    if (
      current &&
      (current.cwd !== cwd || current.environmentId !== environmentId) &&
      !current.editing
    ) {
      setOpened(null);
      setPreview(false);
    }
  });

  async function refreshExpanded() {
    const cwd = props.cwd();
    const destination = environment();
    if (!cwd) return;
    const prefix = key("");
    const directories = [...expanded()].filter((path) => path.startsWith(prefix));
    const results = await Promise.all(
      directories.map(async (directoryKey) => {
        const result = await request(props.client, WS_METHODS.projectsListEntries, {
          cwd,
          directoryPath: directoryKey.slice(prefix.length),
        });
        return [directoryKey, result.entries] as const;
      }),
    );
    if (cwd !== props.cwd() || destination !== environment()) return;
    setChildren((previous) => new Map([...previous, ...results]));
    const current = opened();
    if (
      current &&
      !current.editing &&
      !reading() &&
      current.cwd === cwd &&
      current.environmentId === destination
    ) {
      await readFile(current.file.relativePath, 1, false);
    }
  }

  createEffect(
    on(
      () => [props.mutation(), connection()] as const,
      () => {
        if (connection() !== "connected") return;
        void refreshExpanded().catch((cause) =>
          props.ui.notify(cause instanceof Error ? cause.message : String(cause), true),
        );
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    readVersion += 1;
  });

  async function toggleDirectory(entry: ProjectEntry) {
    const cwd = props.cwd();
    if (!cwd) return;
    const directoryKey = key(entry.path);
    if (expanded().has(directoryKey)) {
      setExpanded((previous) => {
        const next = new Set(previous);
        next.delete(directoryKey);
        return next;
      });
      return;
    }
    if (!children().has(directoryKey)) {
      const result = await request(props.client, WS_METHODS.projectsListEntries, {
        cwd,
        directoryPath: entry.path,
      });
      setChildren((previous) => new Map(previous).set(directoryKey, result.entries));
      if (result.truncated)
        props.ui.notify("This directory listing was truncated. Use Find file to narrow it down.");
    }
    setExpanded((previous) => new Set(previous).add(directoryKey));
  }

  function activate(index = active()) {
    const row = rows()[index];
    if (!row) return;
    setSelected(index);
    if (row.entry.kind === "directory") void props.ui.run(() => toggleDirectory(row.entry));
    else openFile(row.entry.path);
  }

  function move(delta: number) {
    const index = Math.max(0, Math.min(rows().length - 1, active() + delta));
    setSelected(index);
    const path = rows()[index]?.entry.path;
    if (path) treeScroll?.scrollChildIntoView(`workspace-file-${path}`);
  }

  function search(contents = false) {
    props.ui.form({
      title: contents ? "Search in files" : "Find file",
      fields: [{ name: "query", label: contents ? "Text" : "File name or path", required: true }],
      submitLabel: "Search",
      onSubmit: async ({ query = "" }) => {
        const cwd = props.cwd();
        if (!cwd) return;
        if (contents) {
          const result = await request(props.client, WS_METHODS.projectsSearchContents, {
            cwd,
            query,
            limit: 100,
            caseSensitive: false,
            wholeWord: false,
            useRegex: false,
          });
          props.ui.choose(
            `${result.matches.length}${result.truncated ? "+" : ""} matching lines`,
            result.matches.map((match) => ({
              title: `${match.path}:${match.lineNumber}`,
              description: match.lineContent.trim(),
              run: () => openFile(match.path, match.lineNumber),
            })),
          );
        } else {
          const result = await request(props.client, WS_METHODS.projectsSearchEntries, {
            cwd,
            query,
            limit: 100,
            kind: "file",
          });
          props.ui.choose(
            `${result.entries.length}${result.truncated ? "+" : ""} matching files`,
            result.entries.map((entry) => ({
              title: entry.path,
              run: () => openFile(entry.path),
            })),
          );
        }
      },
    });
  }

  function edit() {
    const current = opened();
    if (!current || current.editing || saving() || reading()) return;
    const problem = fileSaveProblem(current.file, current.file);
    if (problem) return props.ui.notify(problem, true);
    setOpened({ ...current, editing: true });
    setPreview(true);
  }

  function leaveEditor() {
    if (saving()) return;
    const close = async () => {
      setOpened((value) => value && { ...value, draft: value.file.contents, editing: false });
    };
    if (dirty())
      props.ui.confirm(
        "Discard unsaved changes?",
        opened()!.file.relativePath,
        close,
        "Discard changes",
      );
    else void close();
  }

  async function save() {
    const current = opened();
    if (!current?.editing || saving()) return;
    if (current.environmentId !== props.state()?.environmentId)
      throw new Error(
        "This draft belongs to another environment. Reconnect to that environment before saving.",
      );
    setSaving(true);
    try {
      const latest = await request(props.client, WS_METHODS.projectsReadFile, {
        cwd: current.cwd,
        relativePath: current.file.relativePath,
      });
      const problem = fileSaveProblem(current.file, latest);
      if (problem) throw new Error(problem);
      if (current.environmentId !== props.state()?.environmentId)
        throw new Error("The connected environment changed. The draft has been kept.");
      await request(props.client, WS_METHODS.projectsWriteFile, {
        cwd: current.cwd,
        relativePath: current.file.relativePath,
        contents: current.draft,
      });
      setOpened({ ...current, file: { ...current.file, contents: current.draft }, editing: false });
      props.ui.notify(`Saved ${current.file.relativePath}`);
      await props.refresh();
    } finally {
      setSaving(false);
    }
  }

  useKeyboard((event) => {
    if (!props.visible || !props.focused || props.ui.modal() || event.meta) return;
    if (opened()?.editing) {
      if (event.ctrl && event.name === "s") void props.ui.run(save);
      else if (event.name === "escape") leaveEditor();
      else return;
    } else if (event.ctrl && event.name === "f") search(true);
    else if (event.name === "/") search();
    else if (event.name === "e" && preview()) edit();
    else if (event.name === "escape" && preview()) setPreview(false);
    else if (event.name === "r") {
      setChildren(new Map());
      setExpanded(new Set<string>());
      setRevision((value) => value + 1);
    } else if (preview()) {
      if (event.name === "up") codeScroll?.scrollBy(-1);
      else if (event.name === "down") codeScroll?.scrollBy(1);
      else if (event.name === "pageup") codeScroll?.scrollBy(-1, "viewport");
      else if (event.name === "pagedown") codeScroll?.scrollBy(1, "viewport");
      else if (event.name === "home") codeScroll?.scrollTo(0);
      else if (event.name === "end") codeScroll?.scrollTo(Infinity);
      else return;
    } else if (event.name === "up") move(-1);
    else if (event.name === "down") move(1);
    else if (event.name === "return" || event.name === "right") activate();
    else if (event.name === "left") {
      const row = rows()[active()];
      if (row?.entry.kind === "directory" && expanded().has(key(row.entry.path)))
        void props.ui.run(() => toggleDirectory(row.entry));
      else if (row && row.depth > 0) {
        const parent = rows().findLastIndex(
          (entry, index) => index < active() && entry.depth === row.depth - 1,
        );
        setSelected(Math.max(0, parent));
        treeScroll?.scrollChildIntoView(`workspace-file-${rows()[parent]?.entry.path}`);
      }
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });

  return (
    <box visible={props.visible} flexGrow={1} minHeight={0} onMouseDown={props.onFocus}>
      <box flexDirection="row" gap={2} paddingX={1} height={1} flexShrink={0}>
        <text fg={theme.primary} onMouseDown={() => search()}>
          Find file
        </text>
        <text fg={theme.textMuted} onMouseDown={() => search(true)}>
          Search text
        </text>
        <Show when={opened() && !opened()?.editing}>
          <text fg={theme.primary} onMouseDown={edit}>
            Edit
          </text>
        </Show>
        <Show when={opened()?.editing}>
          <text fg={theme.primary} onMouseDown={() => void props.ui.run(save)}>
            {saving() ? "Saving…" : "Save"}
          </text>
          <text fg={theme.textMuted} onMouseDown={leaveEditor}>
            Cancel
          </text>
        </Show>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection={props.compact ? "column" : "row"}>
        <Show when={!props.compact || !preview()}>
          <scrollbox
            ref={(value) => {
              treeScroll = value;
            }}
            width={props.compact ? "100%" : "34%"}
            flexGrow={props.compact ? 1 : 0}
            paddingX={1}
            scrollY
            minHeight={0}
            onMouseDown={() => {
              props.onFocus();
              if (!opened()?.editing) setPreview(false);
            }}
          >
            <Show when={listing.loading}>
              <text fg={theme.textMuted}>Loading files…</text>
            </Show>
            <Show when={listing()?.error}>
              <text fg={theme.error} wrapMode="word">
                {listing()?.error}
              </text>
            </Show>
            <For each={rows()}>
              {({ entry, depth }, index) => (
                <text
                  id={`workspace-file-${entry.path}`}
                  height={1}
                  truncate
                  fg={entry.ignored ? theme.textMuted : theme.text}
                  bg={
                    !preview() && active() === index() ? theme.backgroundElement : theme.background
                  }
                  onMouseDown={() => {
                    props.onFocus();
                    activate(index());
                  }}
                >
                  {`${"  ".repeat(depth)}${entry.kind === "directory" ? (expanded().has(key(entry.path)) ? "▾ " : "▸ ") : "  "}${basename(entry.path)}${entry.kind === "directory" ? "/" : ""}`}
                </text>
              )}
            </For>
            <Show when={listing()?.truncated}>
              <text fg={theme.warning}>More entries available through Find file.</text>
            </Show>
          </scrollbox>
        </Show>
        <Show when={!props.compact || preview()}>
          <box flexGrow={1} minWidth={0} minHeight={0} paddingX={1}>
            <Show
              when={opened()}
              fallback={
                <text fg={theme.textMuted} wrapMode="word">
                  Select a file to preview its contents.
                </text>
              }
            >
              {(current) => (
                <>
                  <text
                    fg={theme.textMuted}
                    truncate
                    flexShrink={0}
                  >{`${current().file.relativePath}${dirty() ? " *" : ""}${reading() ? "  Loading…" : ""}`}</text>
                  <Show
                    when={
                      current().cwd !== props.cwd() ||
                      current().environmentId !== props.state()?.environmentId
                    }
                  >
                    <text
                      fg={theme.warning}
                      wrapMode="word"
                    >{`Draft from ${current().cwd}. Reconnect to its environment before saving.`}</text>
                  </Show>
                  <Show when={current().file.truncated}>
                    <text fg={theme.warning} wrapMode="word">
                      Truncated preview. This file is read-only.
                    </text>
                  </Show>
                  <Show
                    when={current().editing}
                    fallback={
                      <scrollbox
                        ref={(value) => {
                          codeScroll = value;
                        }}
                        flexGrow={1}
                        minHeight={0}
                        scrollX
                        scrollY
                        onMouseDown={() => {
                          props.onFocus();
                          setPreview(true);
                        }}
                      >
                        <code
                          content={current().file.contents}
                          filetype={pathToFiletype(current().file.relativePath) ?? "text"}
                          syntaxStyle={syntax}
                          drawUnstyledText
                          wrapMode={preferences().wordWrap ? "word" : "none"}
                        />
                      </scrollbox>
                    }
                  >
                    <FileEditor
                      wrap={preferences().wordWrap}
                      path={current().file.relativePath}
                      contents={current().draft}
                      focused={props.visible && props.focused && !props.ui.modal() && !saving()}
                      onFocus={props.onFocus}
                      onChange={(draft) => setOpened((value) => value && { ...value, draft })}
                      onHighlightError={(message) => props.ui.notify(message)}
                    />
                  </Show>
                </>
              )}
            </Show>
          </box>
        </Show>
      </box>
      <Show when={!opened()?.editing}>
        <text fg={theme.textMuted} paddingX={1} flexShrink={0}>
          {preview()
            ? "↑↓ scroll · e edit · esc files · / find"
            : "↑↓ select · enter open · ← collapse · / find · ctrl+f search"}
        </text>
      </Show>
    </box>
  );
}
