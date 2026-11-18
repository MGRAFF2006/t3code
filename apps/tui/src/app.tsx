import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  CommandId,
  type AssetResource,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { TuiClient, TuiSnapshot } from "./runtime/client.ts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import { newProjectActions } from "./projects/new-project.ts";
import { projectActions } from "./projects/actions.ts";
import { conversationSearch } from "./projects/search.ts";
import { request } from "./rpc/request.ts";
import { setTheme, theme } from "./theme/index.ts";
import { SecretForm } from "./forms.tsx";
import { FieldForm } from "./ui/field-form.tsx";
import { Dialog } from "./ui/dialog.tsx";
import { DialogSelect, type DialogSelectOption } from "./ui/dialog-select.tsx";
import type { Area, Choice, FieldFormOptions, UiController } from "./ui/controller.ts";
import { ConversationPanel } from "./conversation/panel.tsx";
import { WorkspacePanel } from "./workspace/panel.tsx";
import {
  IssuesPanel,
  PullRequestsPanel,
  SchedulesPanel,
  SettingsPanel,
} from "./management/panels.tsx";
import { DetailText } from "./presentation/text.tsx";
import { BrowserPanel } from "./presentation/browser-panel.tsx";
import { createTerminalCapabilities, terminalCapabilitiesReport } from "./presentation/terminal.ts";
import { NativeImagePreview } from "./presentation/media.tsx";
import { createHtmlPreview, openBrowser } from "./presentation/opener.ts";
import { AdvancedPanel } from "./features/advanced.tsx";
import { openTerminal } from "./terminal/session.ts";

type Modal =
  | {
      kind: "choose";
      title: string;
      options: DialogSelectOption<() => void>[];
      onCancel?: () => void;
    }
  | { kind: "form"; options: FieldFormOptions }
  | { kind: "secret"; description: string; resolve: (value: string | null) => void }
  | { kind: "text"; title: string; content: string; language?: string | undefined }
  | { kind: "image"; label: string; resource: AssetResource; environmentId: string | null };
type ThreadFilter = "active" | "all" | "settled" | "snoozed" | "archived";
const destinations: { area: Area; title: string; shortcut: string }[] = [
  { area: "chat", title: "Threads", shortcut: "1" },
  { area: "workspace", title: "Workspace", shortcut: "2" },
  { area: "pull-requests", title: "Pull requests", shortcut: "3" },
  { area: "issues", title: "Issues", shortcut: "4" },
  { area: "schedules", title: "Scheduled tasks", shortcut: "5" },
  { area: "settings", title: "Settings", shortcut: "6" },
  { area: "browser", title: "Browser", shortcut: "7" },
];

export function App(props: { client: TuiClient | null; demo?: boolean; onExit: () => void }) {
  const dimensions = useTerminalDimensions();
  const renderer = useRenderer();
  const capabilities = createTerminalCapabilities(renderer);
  const [state, setState] = createSignal<TuiSnapshot | null>(props.client?.snapshot() ?? null);
  const [area, setArea] = createSignal<Area>("chat");
  const [focus, setFocus] = createSignal<"sidebar" | "main" | "workspace">("main");
  const [sidebar, setSidebar] = createSignal(true);
  const [workspace, setWorkspace] = createSignal(false);
  const [workspaceTab, setWorkspaceTab] = createSignal<"changes" | "files" | "git">("changes");
  const [openPath, setOpenPath] = createSignal<string | undefined>(undefined, { equals: false });
  const [modal, setModalState] = createSignal<Modal | null>(null);
  let pendingNavigation: { modal: Modal; resolve: (approved: boolean) => void } | undefined;
  function setModal(value: Modal | null) {
    if (pendingNavigation && pendingNavigation.modal !== value) {
      const pending = pendingNavigation;
      pendingNavigation = undefined;
      pending.resolve(false);
    }
    setModalState(value);
  }
  const [notice, setNotice] = createSignal<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [filter, setFilter] = createSignal<ThreadFilter>("active");
  const [selectedRow, setSelectedRow] = createSignal(0);
  let sidebarScroll: ScrollBoxRenderable | undefined;
  let outputScroll: ScrollBoxRenderable | undefined;
  const htmlPreviews = new Set<() => Promise<void>>();
  const navigationGuards = new Map<() => string | null, (() => void) | undefined>();
  let operationCount = 0;
  let pendingPassword: ((value: string | null) => void) | undefined;
  const unsubscribe = props.client?.subscribe(setState);
  const unsubscribePreferences = props.client?.subscribePreferences((value) =>
    setTheme(value.theme),
  );
  props.client?.setPasswordPrompt(
    (prompt) =>
      new Promise((resolve) => {
        pendingPassword?.(null);
        pendingPassword = resolve;
        setModal({
          kind: "secret",
          description: `${prompt.username ? `${prompt.username}@` : ""}${prompt.destination}\n${prompt.prompt}`,
          resolve,
        });
      }),
  );
  onCleanup(() => {
    unsubscribe?.();
    unsubscribePreferences?.();
    pendingPassword?.(null);
    pendingNavigation?.resolve(false);
    for (const dispose of htmlPreviews) void dispose();
  });
  const shell = createMemo(() => state()?.shell);
  const environment = createMemo(() => state()?.environmentId);
  const allThreads = createMemo(() => [
    ...new Map(
      [...(shell()?.threads ?? []), ...(shell()?.archivedThreads ?? [])].map((entry) => [
        entry.id,
        entry,
      ]),
    ).values(),
  ]);
  const [snoozeRevision, setSnoozeRevision] = createSignal(0);
  // Schedule a single wake at the next snooze deadline without repainting on a clock interval.
  createEffect(() => {
    snoozeRevision();
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const deadlines = allThreads().flatMap((entry) =>
      entry.snoozedUntil && DateTime.toEpochMillis(entry.snoozedUntil) > now
        ? [DateTime.toEpochMillis(entry.snoozedUntil)]
        : [],
    );
    if (!deadlines.length) return;
    const timer = Effect.runFork(
      Effect.sleep(Math.max(1, Math.min(...deadlines) - now)).pipe(
        Effect.andThen(Effect.sync(() => setSnoozeRevision((value) => value + 1))),
      ),
    );
    onCleanup(() => {
      Effect.runFork(Fiber.interrupt(timer));
    });
  });
  const project = createMemo(() => {
    const current = state();
    const id =
      current?.thread?.thread.projectId ??
      current?.shell?.threads.find((thread) => thread.id === current.selectedThreadId)?.projectId;
    return current?.shell?.projects.find((entry) => entry.id === id);
  });
  const thread = () => state()?.thread?.thread;
  const shellThread = () => allThreads().find((entry) => entry.id === state()?.selectedThreadId);
  const cwd = () => thread()?.worktreePath ?? project()?.workspaceRoot;
  const showSidebar = () => sidebar() && dimensions().width >= 86;
  const showWorkspace = () => workspace() && area() === "chat" && dimensions().width >= 132;
  const activeFocus = () =>
    (focus() === "workspace" && !showWorkspace()) || (focus() === "sidebar" && !showSidebar())
      ? "main"
      : focus();
  function client() {
    if (!props.client) throw new Error("Restart without --demo to connect to a T3 environment.");
    return props.client;
  }
  function notify(text: string, error = false) {
    setNotice({ text, error });
  }
  async function run(action: () => Promise<unknown>, success?: string) {
    operationCount += 1;
    setBusy(true);
    try {
      await action();
      if (success) notify(success);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), true);
    } finally {
      operationCount -= 1;
      setBusy(operationCount > 0);
    }
  }
  function choose(title: string, options: Choice[]) {
    const check = scope();
    setModal({
      kind: "choose",
      title,
      options: options.map(({ run: action, ...option }) => ({
        ...option,
        value: () => {
          try {
            check();
            action();
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error), true);
          }
        },
      })),
    });
  }
  function form(options: FieldFormOptions) {
    const check = scope();
    const guarded: FieldFormOptions = {
      ...options,
      onSubmit: async (values) => {
        if (notice()?.error) setNotice(null);
        try {
          check();
          await options.onSubmit(values);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notify(message, true);
          if (modal() === null)
            setModal({
              kind: "form",
              options: {
                ...guarded,
                description: [options.description, message].filter(Boolean).join("\n\n"),
                fields: options.fields.map((field) => ({
                  ...field,
                  value: values[field.name] ?? field.value ?? "",
                })),
              },
            });
          throw error;
        }
      },
    };
    setModal({ kind: "form", options: guarded });
  }
  function confirm(title: string, message: string, action: () => Promise<void>, label = "Confirm") {
    choose(title, [
      { title: label, description: message, run: () => void run(action) },
      { title: "Cancel", run: () => {} },
    ]);
  }
  function beforeNavigate(): Promise<boolean> {
    const messages = [...navigationGuards.keys()]
      .map((guard) => guard())
      .filter((message) => message !== null);
    if (!messages.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (approved: boolean) => {
        pendingNavigation = undefined;
        if (approved) for (const discard of navigationGuards.values()) discard?.();
        resolve(approved);
      };
      const choice: Modal = {
        kind: "choose",
        title: "Discard unsaved edits?",
        onCancel: () => finish(false),
        options: [
          { title: "Keep editing", description: messages.join("\n"), value: () => finish(false) },
          { title: "Discard edits and continue", value: () => finish(true) },
        ],
      };
      setModal(choice);
      pendingNavigation = { modal: choice, resolve };
    });
  }
  function exit() {
    void beforeNavigate().then((approved) => {
      if (approved) props.onExit();
    });
  }
  function openThread(id: string) {
    if (id === state()?.selectedThreadId && area() === "chat") {
      setFocus("main");
      return;
    }
    const destination = state()?.environmentId;
    void run(async () => {
      if (!(await beforeNavigate()) || state()?.environmentId !== destination) return;
      client().selectThread(id);
      setArea("chat");
      setFocus("main");
      await request(client(), ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
        type: "thread.visit",
        commandId: commandId(),
        threadId: ThreadId.make(id),
        visitedAt: DateTime.formatIso(DateTime.nowUnsafe()),
        opened: true,
      });
    });
  }
  function openArea(next: Area) {
    if (next === area()) {
      setFocus("main");
      return;
    }
    void beforeNavigate().then((approved) => {
      if (approved) {
        setArea(next);
        setFocus("main");
      }
    });
  }
  function views() {
    choose(
      "Switch view",
      destinations.map((item) => ({
        title: item.title,
        description: `Alt+${item.shortcut}${area() === item.area ? " · Current view" : ""}`,
        run: () => openArea(item.area),
      })),
    );
  }
  function toggleWorkspace() {
    if (dimensions().width < 132) {
      openArea("workspace");
      return;
    }
    if (!workspace()) {
      setWorkspace(true);
      return;
    }
    void beforeNavigate().then((approved) => {
      if (approved) setWorkspace(false);
    });
  }
  function showChanges() {
    if (dimensions().width >= 132 && area() !== "chat") {
      void beforeNavigate().then((approved) => {
        if (approved) {
          setWorkspaceTab("changes");
          setArea("chat");
          setWorkspace(true);
          setFocus("workspace");
        }
      });
      return;
    }
    setWorkspaceTab("changes");
    if (dimensions().width >= 132) {
      setArea("chat");
      setWorkspace(true);
      setFocus("workspace");
    } else openArea("workspace");
  }
  function openFile(path: string) {
    if (dimensions().width >= 132 && area() !== "chat") {
      void beforeNavigate().then((approved) => {
        if (approved) {
          setOpenPath(path);
          setWorkspaceTab("files");
          setArea("chat");
          setWorkspace(true);
          setFocus("workspace");
        }
      });
      return;
    }
    setOpenPath(path);
    setWorkspaceTab("files");
    if (dimensions().width >= 132) {
      setArea("chat");
      setWorkspace(true);
      setFocus("workspace");
    } else openArea("workspace");
  }
  function commandId() {
    return CommandId.make(SecureRandom.uuidV4Unsafe());
  }
  function scope() {
    const destination = state()?.environmentId;
    return () => {
      if (state()?.environmentId !== destination)
        throw new Error("The environment changed. Reopen this action in its destination.");
    };
  }
  async function dispatch(command: OrchestrationV2Command) {
    await request(client(), ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command);
  }
  function pair() {
    const check = scope();
    form({
      title: "Pair environment",
      description: "Paste a fresh pairing URL from your T3 server.",
      fields: [{ name: "url", label: "Pairing URL", type: "secret", required: true }],
      submitLabel: "Connect",
      onSubmit: async (values) => {
        if (!(await beforeNavigate())) return;
        check();
        await client().connect(values.url!.trim());
      },
    });
  }
  function environments() {
    void run(async () => {
      const available = await client().environments();
      choose("Switch environment", [
        ...available.map((entry) => ({
          title: entry.label,
          category: entry.environmentId === state()?.environmentId ? "Connected" : "",
          run: () =>
            void run(async () => {
              if (await beforeNavigate()) await client().selectEnvironment(entry.environmentId);
            }),
        })),
        { title: "Pair another environment…", run: pair },
        { title: "Manage connections…", run: () => openArea("settings") },
      ]);
    });
  }
  function feature() {
    return { client: client(), state, ui, focused: true, onFocus: () => setFocus("main") };
  }
  function newProject() {
    newProjectActions(feature());
  }
  function currentProjectActions() {
    choose(
      "Project actions",
      (shell()?.projects ?? []).map((entry) => ({
        title: entry.title,
        description: entry.workspaceRoot,
        run: () => projectActions(feature(), entry.id),
      })),
    );
  }
  function newThread(projectId?: string) {
    const check = scope();
    if (!projectId) {
      choose("New thread", [
        ...(state()?.shell?.projects ?? []).map((entry) => ({
          title: entry.title,
          description: entry.workspaceRoot,
          run: () => newThread(entry.id),
        })),
        { title: "Add project…", run: newProject },
      ]);
      return;
    }
    void run(async () => {
      if (!(await beforeNavigate())) return;
      check();
      const destination = state()?.environmentId;
      const selected = state()?.selectedThreadId;
      const origin = area();
      const unchanged = () =>
        state()?.environmentId === destination &&
        state()?.selectedThreadId === selected &&
        area() === origin;
      const id = await client().createThread(projectId);
      if (!unchanged() || !(await beforeNavigate()) || !unchanged()) {
        notify("Thread created. Your current view was kept.");
        return;
      }
      client().selectThread(id);
      setArea("chat");
      setFocus("main");
    });
  }
  function chooseModel() {
    const check = scope();
    const selected = state()?.selectedThreadId;
    choose(
      "Choose model",
      (state()?.config?.providers ?? []).flatMap((provider) =>
        provider.enabled && provider.installed
          ? provider.models.map((model) => ({
              title: model.name,
              category: provider.displayName ?? provider.driver,
              description: model.slug,
              run: () =>
                void run(async () => {
                  check();
                  if (state()?.selectedThreadId !== selected)
                    throw new Error("The thread changed. Choose the model again.");
                  await client().setModel({ instanceId: provider.instanceId, model: model.slug });
                }, "Model updated"),
            }))
          : [],
      ),
    );
  }
  function threadActions(target = shellThread()) {
    if (!target) {
      notify("Select a thread first.");
      return;
    }
    const check = scope();
    const id = target.id;
    const action = (
      type:
        | "thread.archive"
        | "thread.unarchive"
        | "thread.pin"
        | "thread.unpin"
        | "thread.settle"
        | "thread.mark-unread",
    ) => {
      void run(async () => {
        check();
        await dispatch({ type, commandId: commandId(), threadId: id });
      });
    };
    choose(target.title, [
      {
        title: "Rename thread…",
        run: () =>
          form({
            title: "Rename thread",
            fields: [{ name: "title", label: "Title", value: target.title, required: true }],
            onSubmit: async (values) => {
              check();
              await dispatch({
                type: "thread.metadata.update",
                commandId: commandId(),
                threadId: id,
                title: values.title!.trim(),
              });
            },
          }),
      },
      {
        title: target.pinnedAt ? "Unpin thread" : "Pin thread",
        run: () => action(target.pinnedAt ? "thread.unpin" : "thread.pin"),
      },
      {
        title: target.settledOverride === "settled" ? "Move to active" : "Settle thread",
        run: () => {
          if (target.settledOverride !== "settled") action("thread.settle");
          else
            void run(async () => {
              check();
              await dispatch({
                type: "thread.unsettle",
                commandId: commandId(),
                threadId: id,
                reason: "user",
              });
            });
        },
      },
      {
        title: target.snoozedUntil ? "Unsnooze thread" : "Snooze thread…",
        run: () => {
          if (target.snoozedUntil)
            void run(async () => {
              check();
              await dispatch({
                type: "thread.unsnooze",
                commandId: commandId(),
                threadId: id,
                reason: "user",
              });
            });
          else
            form({
              title: "Snooze thread",
              description: "Use an ISO date and time including its timezone.",
              fields: [
                {
                  name: "until",
                  label: "Until",
                  value: DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { hours: 1 })),
                  required: true,
                },
              ],
              onSubmit: async (values) => {
                check();
                const until = DateTime.makeUnsafe(values.until!);
                if (DateTime.toEpochMillis(until) <= DateTime.toEpochMillis(DateTime.nowUnsafe()))
                  throw new Error("Choose a future time.");
                await dispatch({
                  type: "thread.snooze",
                  commandId: commandId(),
                  threadId: id,
                  snoozedUntil: DateTime.formatIso(until),
                });
              },
            });
        },
      },
      { title: "Mark unread", run: () => action("thread.mark-unread") },
      {
        title: "Fork thread…",
        run: () =>
          form({
            title: "Fork thread",
            fields: [
              { name: "title", label: "Title", value: `${target.title} (fork)`, required: true },
            ],
            onSubmit: async (values) => {
              check();
              const targetId = ThreadId.make(SecureRandom.uuidV4Unsafe());
              await dispatch({
                type: "thread.fork",
                commandId: commandId(),
                sourceThreadId: id,
                targetThreadId: targetId,
                sourcePoint: { type: "latest_stable" },
                createdBy: "user",
                creationSource: "web",
                title: values.title!.trim(),
              });
              check();
              openThread(targetId);
            },
          }),
      },
      {
        title: "Regenerate title",
        run: () =>
          void run(async () => {
            check();
            await dispatch({
              type: "thread.metadata.update",
              commandId: commandId(),
              threadId: id,
              regenerateTitle: true,
            });
          }),
      },
      {
        title: target.autoSettleDisabledAt
          ? "Enable automatic settling"
          : "Disable automatic settling",
        run: () =>
          void run(async () => {
            check();
            await dispatch({
              type: "thread.auto-settle.set",
              commandId: commandId(),
              threadId: id,
              enabled: !!target.autoSettleDisabledAt,
            });
          }),
      },
      {
        title: "Restart agent session",
        description:
          "The next message starts a new provider session with the conversation retained.",
        run: () => {
          confirm(
            "Restart agent session",
            "Detach the provider sessions; your next message resumes from T3's conversation.",
            async () => {
              check();
              await client().stopSession({ threadId: id });
            },
            "Restart session",
          );
        },
      },
      {
        title: "Tags…",
        run: () =>
          form({
            title: "Thread tags",
            description: "One tag per line.",
            fields: [
              {
                name: "tags",
                label: "Tags",
                type: "multiline",
                value: (target.tags ?? []).join("\n"),
              },
            ],
            onSubmit: async (values) => {
              check();
              const tags = [
                ...new Set(
                  (values.tags ?? "")
                    .split("\n")
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                ),
              ];
              if (tags.some((tag) => tag.length > 64))
                throw new Error("Tags can contain at most 64 characters.");
              for (const tag of target.tags ?? [])
                if (!tags.includes(tag)) {
                  check();
                  await dispatch({
                    type: "thread.tag.set",
                    commandId: commandId(),
                    threadId: id,
                    tag,
                    tagged: false,
                  });
                }
              for (const tag of tags)
                if (!target.tags?.includes(tag)) {
                  check();
                  await dispatch({
                    type: "thread.tag.set",
                    commandId: commandId(),
                    threadId: id,
                    tag,
                    tagged: true,
                  });
                }
            },
          }),
      },
      {
        title: "Turn into project",
        run: () =>
          confirm(
            "Turn thread into project",
            "Create a project from this thread's workspace.",
            async () => {
              check();
              await request(client(), WS_METHODS.projectsCreateFromThread, { threadId: id });
            },
            "Create project",
          ),
      },
      { title: "Checkpoints…", run: checkpoints },
      {
        title: target.archivedAt ? "Reopen thread" : "Archive thread",
        run: () => action(target.archivedAt ? "thread.unarchive" : "thread.archive"),
      },
      {
        title: "Delete thread…",
        run: () =>
          confirm(
            "Delete thread",
            "Permanently delete this conversation and its history.",
            async () => {
              if (!(await beforeNavigate())) return;
              check();
              await dispatch({ type: "thread.delete", commandId: commandId(), threadId: id });
              if (state()?.selectedThreadId === id) client().selectThread(null);
            },
            "Delete thread permanently",
          ),
      },
    ]);
  }
  function checkpoints() {
    const projection = state()?.thread;
    const check = scope();
    if (!projection) return;
    choose(
      "Checkpoints",
      projection.checkpoints.map((checkpoint) => ({
        title: `Checkpoint ${checkpoint.ordinalWithinScope + 1}`,
        category: checkpoint.status,
        description: `${checkpoint.files.length} files · ${DateTime.formatIso(checkpoint.capturedAt)}`,
        run: () =>
          choose("Checkpoint", [
            ...(checkpoint.appRunOrdinal === null
              ? []
              : [
                  {
                    title: "Review checkpoint changes",
                    run: () =>
                      void run(async () => {
                        check();
                        const diff = await request(
                          client(),
                          ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
                          {
                            threadId: projection.thread.id,
                            fromTurnCount: checkpoint.appRunOrdinal! - 1,
                            toTurnCount: checkpoint.appRunOrdinal!,
                          },
                        );
                        check();
                        ui.text(
                          `Checkpoint ${checkpoint.ordinalWithinScope + 1}`,
                          diff.diff || "No file changes in this checkpoint.",
                          "diff",
                        );
                      }),
                  },
                ]),
            {
              title: "Restore conversation to here",
              run: () =>
                confirm(
                  "Restore checkpoint",
                  "The conversation returns to this checkpoint. Workspace files remain as they are.",
                  async () => {
                    check();
                    await dispatch({
                      type: "checkpoint.rollback",
                      commandId: commandId(),
                      threadId: projection.thread.id,
                      checkpointId: checkpoint.id,
                      scopeId: checkpoint.scopeId,
                      restoreFiles: false,
                    });
                  },
                  "Restore conversation",
                ),
            },
            {
              title: "Restore conversation and files",
              run: () =>
                confirm(
                  "Restore checkpoint and files",
                  "Tracked workspace files and conversation return to this checkpoint.",
                  async () => {
                    check();
                    await dispatch({
                      type: "checkpoint.rollback",
                      commandId: commandId(),
                      threadId: projection.thread.id,
                      checkpointId: checkpoint.id,
                      scopeId: checkpoint.scopeId,
                      restoreFiles: true,
                    });
                  },
                  "Restore files and conversation",
                ),
            },
          ]),
      })),
    );
  }
  function terminal(terminalId?: string) {
    void run(() =>
      openTerminal({
        client: client(),
        renderer,
        cwd: cwd() ?? "",
        ...(terminalId ? { terminalId } : {}),
      }),
    );
  }
  const ui: UiController = {
    modal: () => modal() !== null,
    beforeNavigate,
    registerNavigationGuard: (guard, discard) => {
      navigationGuards.set(guard, discard);
      return () => navigationGuards.delete(guard);
    },
    notify,
    run,
    choose,
    form,
    confirm,
    text: (title, content, language) => setModal({ kind: "text", title, content, language }),
    openTerminal: terminal,
    openBrowser: (url) => {
      void run(() => openBrowser(url));
    },
    openHtml: (html, title = "HTML preview") => {
      void run(async () => {
        const preview = await createHtmlPreview(html);
        htmlPreviews.add(preview.dispose);
        try {
          await openBrowser(preview.url);
          notify(`${title} opened in your browser`);
        } catch (error) {
          ui.text(
            title,
            `${error instanceof Error ? error.message : String(error)}\n\n${preview.url}`,
          );
        }
      });
    },
    previewImage: (resource, label) =>
      setModal({ kind: "image", resource, label, environmentId: state()?.environmentId ?? null }),
    openThread,
    openArea,
    openFile,
    showChanges,
    chooseModel,
    threadActions: () => threadActions(),
  };
  function switchThread() {
    choose(
      "Switch thread",
      allThreads().map((entry) => ({
        title: entry.title,
        description: entry.latestVisibleMessage?.text,
        category: state()?.shell?.projects.find((candidate) => candidate.id === entry.projectId)
          ?.title,
        run: () => openThread(entry.id),
      })),
    );
  }
  function palette() {
    choose("Commands", [
      { title: "New thread", category: "Threads", run: () => newThread() },
      { title: "Switch thread", category: "Threads", run: switchThread },
      { title: "Thread actions", category: "Threads", run: () => threadActions() },
      { title: "Add project", category: "Projects", run: newProject },
      { title: "Project actions and settings", category: "Projects", run: currentProjectActions },
      {
        title: "Search conversations",
        category: "Threads",
        run: () => conversationSearch(feature()),
      },
      { title: "Choose model", category: "Agent", run: chooseModel },
      {
        title: "Interrupt turn",
        category: "Agent",
        run: () => void run(() => client().interrupt(), "Stop requested"),
      },
      {
        title: "Earlier conversation history",
        category: "Threads",
        run: () => void run(() => client().loadEarlier()),
      },
      { title: "Checkpoints", category: "Threads", run: checkpoints },
      { title: "Review changes", category: "Workspace", run: showChanges },
      {
        title: "Browse files",
        category: "Workspace",
        run: () => {
          setWorkspaceTab("files");
          openArea("workspace");
        },
      },
      {
        title: "Source control",
        category: "Workspace",
        run: () => {
          setWorkspaceTab("git");
          openArea("workspace");
        },
      },
      { title: "Open terminal", category: "Workspace", run: terminal },
      { title: "Switch view", category: "Navigate", run: views },
      ...destinations
        .filter((item) => item.area !== "chat")
        .map((item) => ({
          title: item.title,
          category: "Navigate",
          run: () => openArea(item.area),
        })),
      { title: "Switch environment", category: "Connections", run: environments },
      { title: "Pair environment", category: "Connections", run: pair },
      {
        title: "Reconnect",
        category: "Connections",
        run: () => void run(() => client().reconnect()),
      },
      { title: "Toggle sidebar", category: "Layout", run: () => setSidebar((value) => !value) },
      { title: "Toggle workspace panel", category: "Layout", run: toggleWorkspace },
      {
        title: "Terminal capabilities",
        category: "Help",
        run: () => ui.text("Terminal capabilities", terminalCapabilitiesReport(capabilities())),
      },
      { title: "Service inspector", category: "Developer", run: () => openArea("advanced") },
      { title: "Keyboard shortcuts", category: "Help", run: shortcuts },
      { title: "Quit", category: "App", run: exit },
    ]);
  }
  function shortcuts() {
    ui.text(
      "Keyboard shortcuts",
      "Ctrl+P  Commands\nCtrl+K  Switch thread\nCtrl+N  New thread\nCtrl+B  Toggle sidebar\nCtrl+E  Toggle workspace panel\nCtrl+T  Open thread terminal (Ctrl+] returns)\nAlt+1…7  Navigate sections\nF6  Move focus between panes\nCtrl+Q  Quit\n\nLists: arrows to select, Enter to open; mouse also works.\nForms: Tab changes field; arrows choose options; Ctrl+S or F2 saves.\nConversation shortcuts appear below the composer.",
    );
  }
  function matches(entry: OrchestrationV2ThreadShell) {
    if (
      search() &&
      !`${entry.title} ${entry.latestVisibleMessage?.text ?? ""}`
        .toLowerCase()
        .includes(search().toLowerCase())
    )
      return false;
    if (filter() === "archived") return entry.archivedAt !== null;
    if (entry.archivedAt) return false;
    if (filter() === "all") return true;
    snoozeRevision();
    const currentEnvironment = environment();
    const snoozed =
      currentEnvironment !== null &&
      currentEnvironment !== undefined &&
      effectiveSnoozed(presentThreadShell(currentEnvironment, entry), {
        now: DateTime.formatIso(DateTime.nowUnsafe()),
      });
    if (filter() === "snoozed") return snoozed;
    if (snoozed) return false;
    if (filter() === "settled") return entry.settledOverride === "settled";
    return entry.settledOverride !== "settled";
  }
  const rows = createMemo(() => {
    const presented = allThreads()
      .filter(matches)
      .map((source) => ({
        source,
        id: source.id,
        createdAt: DateTime.formatIso(source.createdAt),
        pinOrderKey: source.pinOrderKey,
        activeOrderKey: source.activeOrderKey,
        unsettledAt: source.unsettledAt ? DateTime.formatIso(source.unsettledAt) : null,
      }));
    return [
      ...sortPinnedThreadsByOrderKey(presented.filter((value) => value.source.pinnedAt)),
      ...sortActiveThreadsByOrderKey(presented.filter((value) => !value.source.pinnedAt)),
    ].map((value) => value.source);
  });
  function moveRow(delta: number) {
    setSelectedRow((index) => Math.max(0, Math.min(rows().length - 1, index + delta)));
    sidebarScroll?.scrollChildIntoView(`thread-${rows()[selectedRow()]?.id}`);
  }
  useKeyboard((event) => {
    if (event.ctrl && event.name === "q") exit();
    else if (modal()) {
      if (modal()?.kind === "image" && event.name === "escape") setModal(null);
      else if (modal()?.kind === "text") {
        if (event.name === "escape") setModal(null);
        else if (event.name === "pageup") outputScroll?.scrollBy(-1, "viewport");
        else if (event.name === "pagedown") outputScroll?.scrollBy(1, "viewport");
        else return;
      } else return;
    } else if (event.ctrl && event.name === "p") palette();
    else if (event.ctrl && event.name === "k") switchThread();
    else if (event.ctrl && event.name === "n") newThread(project()?.id);
    else if (event.ctrl && event.name === "b") setSidebar((value) => !value);
    else if (event.ctrl && event.name === "e") toggleWorkspace();
    else if (event.ctrl && event.name === "t") terminal();
    else if (event.meta && destinations.some((entry) => entry.shortcut === event.name))
      openArea(destinations.find((entry) => entry.shortcut === event.name)!.area);
    else if (event.name === "f1") shortcuts();
    else if (event.name === "f6")
      setFocus((value) =>
        value === "main"
          ? showWorkspace()
            ? "workspace"
            : showSidebar()
              ? "sidebar"
              : "main"
          : value === "workspace" && showSidebar()
            ? "sidebar"
            : "main",
      );
    else if (activeFocus() === "sidebar" && event.name === "up") moveRow(-1);
    else if (activeFocus() === "sidebar" && event.name === "down") moveRow(1);
    else if (activeFocus() === "sidebar" && event.name === "return" && rows()[selectedRow()])
      openThread(rows()[selectedRow()]!.id);
    else if (activeFocus() === "sidebar" && event.name === "f2")
      threadActions(rows()[selectedRow()]);
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  function filterPicker() {
    choose(
      "Show threads",
      (["active", "all", "settled", "snoozed", "archived"] as const).map((value) => ({
        title: value[0]!.toUpperCase() + value.slice(1),
        run: () => {
          setFilter(value);
          setSelectedRow(0);
        },
      })),
    );
  }
  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background}>
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Show when={showSidebar()}>
          <box
            width={29}
            flexShrink={0}
            backgroundColor={theme.sidebar}
            paddingX={1}
            onMouseDown={() => setFocus("sidebar")}
          >
            <box height={3} flexShrink={0} justifyContent="center">
              <text fg={theme.text} onMouseDown={environments}>
                T3 Code ▾
              </text>
            </box>
            <text
              height={1}
              flexShrink={0}
              fg={theme.textMuted}
              truncate
              onMouseDown={environments}
            >
              {state()?.label ?? (props.demo ? "Demo" : "Connect environment")}
            </text>
            <box height={1} flexShrink={0} marginTop={1} marginBottom={1}>
              <text fg={theme.primary} onMouseDown={() => newThread(project()?.id)}>
                ＋ New thread ^N
              </text>
            </box>
            <box
              height={1}
              flexShrink={0}
              marginTop={1}
              flexDirection="row"
              justifyContent="space-between"
            >
              <text fg={theme.text}>Threads</text>
              <text fg={theme.textMuted} onMouseDown={filterPicker}>
                {filter()} ▾
              </text>
            </box>
            <input
              placeholder="Search threads…"
              value={search()}
              focused={activeFocus() === "sidebar" && !modal()}
              onInput={(value) => {
                setSearch(value);
                setSelectedRow(0);
              }}
              backgroundColor={theme.sidebar}
              textColor={theme.text}
              focusedTextColor={theme.text}
              cursorColor={theme.primary}
            />
            <scrollbox
              ref={(element) => {
                sidebarScroll = element;
              }}
              flexGrow={1}
              minHeight={0}
            >
              <For each={rows()}>
                {(entry) => {
                  const selected = () => state()?.selectedThreadId === entry.id;
                  const cursor = () =>
                    activeFocus() === "sidebar" && rows()[selectedRow()]?.id === entry.id;
                  return (
                    <box
                      id={`thread-${entry.id}`}
                      backgroundColor={
                        selected() || cursor() ? theme.sidebarSelected : theme.sidebar
                      }
                      onMouseDown={(event) => {
                        if (event.button === 2) threadActions(entry);
                        else openThread(entry.id);
                      }}
                    >
                      <text
                        height={1}
                        truncate
                        fg={
                          entry.pendingRuntimeRequest
                            ? theme.warning
                            : selected()
                              ? theme.text
                              : theme.textMuted
                        }
                      >
                        {entry.pinnedAt
                          ? "◆ "
                          : entry.pendingRuntimeRequest
                            ? "! "
                            : entry.activeRunId
                              ? "● "
                              : entry.lastError
                                ? "× "
                                : "  "}
                        {entry.title}
                      </text>
                    </box>
                  );
                }}
              </For>
              <Show when={rows().length === 0}>
                <text fg={theme.textMuted} wrapMode="word" marginTop={1}>
                  No {filter()} threads. Start a thread or choose another filter.
                </text>
              </Show>
            </scrollbox>
            <text
              height={1}
              flexShrink={0}
              fg={activeFocus() === "sidebar" ? theme.primary : theme.textMuted}
              marginTop={1}
              onMouseDown={palette}
            >
              ⌘ Commands ^P
            </text>
          </box>
        </Show>
        <box flexGrow={1} minWidth={0}>
          <box
            height={3}
            paddingX={2}
            flexDirection="row"
            alignItems="center"
            border={["bottom"]}
            borderColor={theme.border}
          >
            <Show when={!showSidebar()}>
              <text fg={theme.primary} marginRight={2} onMouseDown={palette}>
                T3
              </text>
            </Show>
            <text fg={theme.textMuted} flexShrink={0} onMouseDown={() => newThread()}>
              {project()?.title ?? "T3 Code"}
              {" / "}
            </text>
            <text fg={theme.text} flexGrow={1} truncate>
              {area() === "chat"
                ? (thread()?.title ?? "New thread")
                : destinations.find((entry) => entry.area === area())?.title}
            </text>
            <Show when={thread()?.branch}>
              <text
                fg={theme.textMuted}
                marginLeft={1}
                truncate
                onMouseDown={() => {
                  setWorkspaceTab("git");
                  openArea("workspace");
                }}
              >
                ⎇ {thread()?.branch}
              </text>
            </Show>
            <text fg={theme.textMuted} marginLeft={2} flexShrink={0} onMouseDown={views}>
              Views ▾
            </text>
            <text fg={theme.textMuted} marginLeft={2} onMouseDown={showChanges}>
              Changes
            </text>
            <text fg={theme.textMuted} marginLeft={2} onMouseDown={() => threadActions()}>
              •••
            </text>
          </box>
          <Show
            when={props.client}
            fallback={
              <box flexGrow={1} padding={3} justifyContent="center">
                <text fg={theme.text}>T3 Code in your terminal</text>
                <text marginTop={1} fg={theme.textMuted} wrapMode="word">
                  Projects, threads, conversation and source control share your T3 environment.
                </text>
                <text marginTop={1} fg={theme.textMuted}>
                  Run without --demo to connect. Ctrl+P opens commands.
                </text>
              </box>
            }
          >
            {(connectedClient) => (
              <box flexDirection="row" flexGrow={1} minHeight={0}>
                <box flexGrow={1} minWidth={0} onMouseDown={() => setFocus("main")}>
                  <Show
                    when={state()?.environmentId || area() === "settings"}
                    fallback={
                      <box flexGrow={1} padding={3} justifyContent="center">
                        <text fg={theme.text}>Connect a T3 environment</text>
                        <text fg={theme.textMuted} marginTop={1} wrapMode="word">
                          Use the same projects and agents from this terminal.
                        </text>
                        <text fg={theme.primary} marginTop={2} onMouseDown={pair}>
                          Pair environment
                        </text>
                        <text
                          fg={theme.textMuted}
                          marginTop={1}
                          onMouseDown={() => openArea("settings")}
                        >
                          Connections and SSH in Settings
                        </text>
                      </box>
                    }
                  >
                    <Show when={area() === "chat"}>
                      <ConversationPanel
                        client={connectedClient()}
                        state={state}
                        ui={ui}
                        focused={activeFocus() === "main"}
                        onFocus={() => setFocus("main")}
                      />
                    </Show>
                    <Show when={area() === "workspace"}>
                      <WorkspacePanel
                        client={connectedClient()}
                        state={state}
                        ui={ui}
                        focused={activeFocus() === "main"}
                        onFocus={() => setFocus("main")}
                        initialTab={workspaceTab()}
                        openPath={openPath()}
                      />
                    </Show>
                    <Show when={area() === "schedules"}>
                      <SchedulesPanel
                        client={connectedClient()}
                        state={state}
                        ui={ui}
                        focused={activeFocus() === "main"}
                        onFocus={() => setFocus("main")}
                      />
                    </Show>
                    <Show when={area() === "settings"}>
                      <SettingsPanel
                        client={connectedClient()}
                        state={state}
                        ui={ui}
                        focused={activeFocus() === "main"}
                        onFocus={() => setFocus("main")}
                      />
                    </Show>
                    <Show when={area() === "pull-requests"}>
                      <PullRequestsPanel
                        client={connectedClient()}
                        state={state}
                        ui={ui}
                        focused={activeFocus() === "main"}
                        onFocus={() => setFocus("main")}
                      />
                    </Show>
                    <Show when={area() === "browser"}>
                      <BrowserPanel
                        client={connectedClient()}
                        state={state}
                        ui={ui}
                        focused={activeFocus() === "main"}
                        onFocus={() => setFocus("main")}
                      />
                    </Show>
                    <Show when={area() === "advanced"}>
                      <AdvancedPanel
                        client={connectedClient()}
                        state={state}
                        ui={ui}
                        focused={activeFocus() === "main"}
                        onFocus={() => setFocus("main")}
                      />
                    </Show>
                    <Show when={area() === "issues"}>
                      <IssuesPanel
                        client={connectedClient()}
                        state={state}
                        ui={ui}
                        focused={activeFocus() === "main"}
                        onFocus={() => setFocus("main")}
                      />
                    </Show>
                  </Show>
                </box>
                <Show when={workspace() && area() === "chat"}>
                  <box
                    visible={showWorkspace()}
                    width={showWorkspace() ? "38%" : 0}
                    minWidth={showWorkspace() ? 42 : 0}
                    flexShrink={0}
                    border={["left"]}
                    borderColor={activeFocus() === "workspace" ? theme.primary : theme.border}
                    onMouseDown={() => setFocus("workspace")}
                  >
                    <WorkspacePanel
                      client={connectedClient()}
                      state={state}
                      ui={ui}
                      focused={activeFocus() === "workspace"}
                      onFocus={() => setFocus("workspace")}
                      initialTab={workspaceTab()}
                      openPath={openPath()}
                      compact
                    />
                  </box>
                </Show>
              </box>
            )}
          </Show>
        </box>
      </box>
      <box height={1} paddingX={1} flexDirection="row" backgroundColor={theme.backgroundPanel}>
        <text
          fg={notice()?.error || state()?.error ? theme.error : theme.textMuted}
          flexGrow={1}
          truncate
        >
          {busy()
            ? "Working…"
            : (notice()?.text ??
              state()?.error ??
              `${state()?.connection ?? "offline"}  ${state()?.label ?? "T3 Code"}`)}
        </text>
        <text fg={theme.textMuted} onMouseDown={shortcuts}>
          {dimensions().width >= 86
            ? "F6 focus  ^P commands  ^T terminal  ^Q quit"
            : "^P commands  ^Q quit"}
        </text>
      </box>
      <Show when={modal()} keyed>
        {(current) => {
          const close = () => {
            if (modal() === current) setModal(null);
          };
          if (current.kind === "choose")
            return (
              <DialogSelect
                title={current.title}
                options={current.options}
                onCancel={() => {
                  close();
                  current.onCancel?.();
                }}
                onSelect={(option) => {
                  option.value();
                  close();
                }}
              />
            );
          if (current.kind === "form")
            return <FieldForm options={current.options} onClose={close} />;
          if (current.kind === "secret")
            return (
              <SecretForm
                title="SSH authentication"
                description={current.description}
                onSubmit={(value) => {
                  close();
                  pendingPassword = undefined;
                  current.resolve(value);
                }}
              />
            );
          if (current.kind === "image")
            return (
              <Dialog title="Image preview" width={100} onClose={close}>
                <NativeImagePreview
                  label={current.label}
                  load={() => {
                    if (state()?.environmentId !== current.environmentId)
                      return Promise.reject(
                        new Error("Return to the image's environment to load it."),
                      );
                    return client().readAsset(current.resource);
                  }}
                />
                <text fg={theme.textMuted} marginTop={1}>
                  esc close
                </text>
              </Dialog>
            );
          return (
            <Dialog title={current.title} width={110} onClose={close}>
              <scrollbox
                ref={(element) => {
                  outputScroll = element;
                }}
                maxHeight={Math.max(2, dimensions().height - 8)}
              >
                <DetailText content={current.content} language={current.language} />
              </scrollbox>
              <text fg={theme.textMuted} marginTop={1}>
                PgUp/PgDn scroll · esc close
              </text>
            </Dialog>
          );
        }}
      </Show>
    </box>
  );
}
