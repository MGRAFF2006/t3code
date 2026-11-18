import { useKeyboard, useRenderer } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  resolveBrowserProfiles,
  WS_METHODS,
  type DiscoveredLocalServer,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request, subscribe } from "../rpc/request.ts";
import { createTerminalCapabilities, terminalHyperlink } from "./terminal.ts";
import { theme } from "../theme/index.ts";
import { controlBrowser } from "./browser-control.ts";

const viewportFor = (value: string): PreviewViewportSetting =>
  value === "phone"
    ? { _tag: "freeform", width: 390, height: 844 }
    : value === "tablet"
      ? { _tag: "freeform", width: 820, height: 1180 }
      : value === "desktop"
        ? { _tag: "freeform", width: 1440, height: 900 }
        : { _tag: "fill" };

export function BrowserPanel(props: FeatureProps) {
  const capabilities = createTerminalCapabilities(useRenderer());
  const [sessions, setSessions] = createSignal<ReadonlyArray<PreviewSessionSnapshot>>([]);
  const [servers, setServers] = createSignal<ReadonlyArray<DiscoveredLocalServer>>([]);
  const [selected, setSelected] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const environment = createMemo(() => props.state()?.environmentId);
  const threadId = createMemo(() => props.state()?.selectedThreadId);
  const session = () => sessions()[selected()];
  const profiles = () =>
    resolveBrowserProfiles(
      sessions().flatMap((value) =>
        value.profileId
          ? [{ id: value.profileId, name: value.profileId, kind: "persistent" as const }]
          : [],
      ),
    );
  let refresh: () => Promise<void> = async () => {};
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setFailure(message);
  };
  createEffect(() => {
    const destinationEnvironment = environment();
    const destinationThread = threadId();
    setSessions([]);
    setServers([]);
    setSelected(0);
    setFailure(null);
    if (!destinationEnvironment || !destinationThread) return;
    let active = true;
    let generation = 0;
    const current = () =>
      active && environment() === destinationEnvironment && threadId() === destinationThread;
    refresh = async () => {
      const requestGeneration = ++generation;
      setLoading(true);
      try {
        const value = await request(props.client, WS_METHODS.previewList, {
          threadId: destinationThread,
        });
        if (current() && requestGeneration === generation) {
          setSessions(value.sessions);
          setFailure(null);
        }
      } catch (error) {
        if (current() && requestGeneration === generation) report(error);
      } finally {
        if (current() && requestGeneration === generation) setLoading(false);
      }
    };
    const stopEvents = subscribe(
      props.client,
      WS_METHODS.subscribePreviewEvents,
      {},
      (event) => {
        if (current() && event.threadId === destinationThread) void refresh();
      },
      (error) => {
        if (current()) report(error);
      },
    );
    const stopServers = subscribe(
      props.client,
      WS_METHODS.subscribeDiscoveredLocalServers,
      {},
      (value) => {
        if (current()) setServers(value.servers);
      },
      (error) => {
        if (current()) report(error);
      },
    );
    void refresh();
    onCleanup(() => {
      active = false;
      stopEvents();
      stopServers();
    });
  });
  const destination = () => {
    const environmentId = environment();
    const id = threadId();
    if (!environmentId || !id) throw new Error("Select a thread before opening its browser.");
    return {
      id,
      check: () => {
        if (environment() !== environmentId || threadId() !== id)
          throw new Error("Return to this browser's environment and thread to continue.");
      },
    };
  };
  function newTab(initialUrl = "", profileId = "default") {
    if (!threadId()) {
      props.ui.notify("Select a thread before opening its browser.");
      return;
    }
    const target = destination();
    props.ui.form({
      title: "New browser tab",
      description:
        "Runs in your T3 environment's browser. Agents and your other T3 clients share these tabs.",
      fields: [
        { name: "url", label: "URL", value: initialUrl, required: true },
        {
          name: "profile",
          label: "Browser profile",
          type: "select",
          value: profileId,
          options: profiles().map((value) => ({ label: value.name, value: value.id })),
        },
        {
          name: "viewport",
          label: "Viewport",
          type: "select",
          value: "desktop",
          options: [
            { label: "Desktop · 1440 × 900", value: "desktop" },
            { label: "Tablet · 820 × 1180", value: "tablet" },
            { label: "Phone · 390 × 844", value: "phone" },
            { label: "Fit viewer", value: "fill" },
          ],
        },
      ],
      submitLabel: "Open tab",
      onSubmit: async (values) => {
        target.check();
        const url = new URL(values.url ?? "");
        if (url.protocol !== "http:" && url.protocol !== "https:")
          throw new Error("Enter an http or https URL.");
        await request(props.client, WS_METHODS.previewOpen, {
          threadId: target.id,
          url: url.href,
          profileId: values.profile ?? "default",
          runtime: "server",
          reveal: false,
          viewport: viewportFor(values.viewport ?? "desktop"),
        });
        if (threadId() === target.id) await refresh();
      },
    });
  }
  function tabActions(value = session()) {
    if (!value) return;
    const target = destination();
    const tabId = value.tabId;
    const nav = value.navStatus;
    const actions: Choice[] = [];
    if (value.runtime === "server" || value.headless) {
      const perform = async (input: Parameters<typeof controlBrowser>[3]) => {
        target.check();
        const access = await props.client.previewStreamAccess();
        target.check();
        await controlBrowser(access, target.id, tabId, input, target.check);
      };
      actions.push({
        title: "Navigate to URL…",
        description: "Takes control briefly, then releases it.",
        run: () =>
          props.ui.form({
            title: "Navigate browser",
            description: "Takes control of the shared page for this action, then releases it.",
            fields: [
              {
                name: "url",
                label: "URL",
                required: true,
                value: nav._tag === "Idle" ? "" : nav.url,
              },
            ],
            submitLabel: "Navigate",
            onSubmit: async ({ url = "" }) => {
              const parsed = new URL(url);
              if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
                throw new Error("Enter an http or https URL.");
              await perform({ type: "navigate", url: parsed.href });
            },
          }),
      });
      if (value.canGoBack)
        actions.push({
          title: "Back",
          description: "Takes control briefly, then releases it.",
          run: () => void props.ui.run(() => perform({ type: "history", delta: -1 })),
        });
      if (value.canGoForward)
        actions.push({
          title: "Forward",
          description: "Takes control briefly, then releases it.",
          run: () => void props.ui.run(() => perform({ type: "history", delta: 1 })),
        });
      if (nav._tag === "Loading")
        actions.push({
          title: "Stop loading",
          run: () => void props.ui.run(() => perform({ type: "stopLoading" })),
        });
    }
    if (nav._tag !== "Idle")
      actions.push({
        title: "Open URL in this device's browser",
        description: nav.url,
        run: () => props.ui.openBrowser?.(nav.url),
      });
    actions.push({
      title: "Reload page",
      run: () => {
        void props.ui.run(async () => {
          target.check();
          await request(props.client, WS_METHODS.previewAdjust, {
            threadId: target.id,
            tabId,
            hardReload: true,
          });
        });
      },
    });
    actions.push({
      title: "Viewport…",
      run: () =>
        props.ui.choose(
          "Viewport",
          ["desktop", "tablet", "phone", "fill"].map((name) => ({
            title: name === "fill" ? "Fit viewer" : `${name[0]!.toUpperCase()}${name.slice(1)}`,
            run: () => {
              void props.ui.run(async () => {
                target.check();
                await request(props.client, WS_METHODS.previewResize, {
                  threadId: target.id,
                  tabId,
                  viewport: viewportFor(name),
                });
              });
            },
          })),
        ),
    });
    actions.push({
      title: "Appearance…",
      run: () =>
        props.ui.choose(
          "Page appearance",
          (["system", "light", "dark"] as const).map((colorScheme) => ({
            title: colorScheme,
            run: () => {
              void props.ui.run(async () => {
                target.check();
                await request(props.client, WS_METHODS.previewAdjust, {
                  threadId: target.id,
                  tabId,
                  colorScheme,
                });
              });
            },
          })),
        ),
    });
    actions.push({
      title: "Zoom…",
      run: () =>
        props.ui.choose(
          "Page zoom",
          ([0.5, 0.75, 1, 1.25, 1.5, 2] as const).map((zoomFactor) => ({
            title: `${zoomFactor * 100}%`,
            run: () => {
              void props.ui.run(async () => {
                target.check();
                await request(props.client, WS_METHODS.previewAdjust, {
                  threadId: target.id,
                  tabId,
                  zoomFactor,
                });
              });
            },
          })),
        ),
    });
    actions.push({
      title: "Clear cookies…",
      run: () =>
        props.ui.confirm(
          "Clear this tab's cookies?",
          "This can sign you out of websites using this browser profile.",
          async () => {
            target.check();
            await request(props.client, WS_METHODS.previewAdjust, {
              threadId: target.id,
              tabId,
              clear: "cookies",
            });
          },
          "Clear cookies",
        ),
    });
    actions.push({
      title: "Clear cache…",
      run: () =>
        props.ui.confirm(
          "Clear this tab's cache?",
          "Removes cached page resources for this browser profile.",
          async () => {
            target.check();
            await request(props.client, WS_METHODS.previewAdjust, {
              threadId: target.id,
              tabId,
              clear: "cache",
            });
          },
          "Clear cache",
        ),
    });
    actions.push({
      title: "Close tab",
      run: () => {
        void props.ui.run(async () => {
          target.check();
          await request(props.client, WS_METHODS.previewClose, { threadId: target.id, tabId });
          if (threadId() === target.id) await refresh();
        });
      },
    });
    props.ui.choose(nav._tag === "Idle" ? "Browser tab" : nav.title || nav.url, actions);
  }
  function serverActions(server: DiscoveredLocalServer) {
    const target = destination();
    const choices: Choice[] = [
      {
        title: "Open in shared browser",
        run: () => {
          target.check();
          newTab(server.url);
        },
      },
      {
        title: "Open URL in this device's browser",
        run: () => {
          target.check();
          props.ui.openBrowser?.(server.url);
        },
      },
    ];
    if (server.pid !== null) {
      const pid = server.pid;
      choices.push({
        title: "Stop development server",
        description: `${server.processName ?? "Process"} · PID ${pid} · port ${server.port}`,
        run: () =>
          props.ui.confirm(
            "Stop development server?",
            "Stops this server's process group. T3 refuses shared groups that would also stop an agent or terminal shell.",
            async () => {
              target.check();
              await request(props.client, WS_METHODS.previewStopLocalServer, {
                pid,
                port: server.port,
              });
            },
            "Stop server",
          ),
      });
    }
    props.ui.choose(server.url, choices);
  }
  function developmentServers() {
    props.ui.choose(
      "Development servers",
      servers().map((server) => ({
        title: server.url,
        description: server.processName ?? undefined,
        run: () => serverActions(server),
      })),
    );
  }
  function profileActions() {
    if (!threadId()) {
      props.ui.notify("Select a thread before managing its browser profiles.");
      return;
    }
    const target = destination();
    props.ui.choose(
      "Browser profiles",
      profiles().map((profile) => ({
        title: profile.name,
        description:
          profile.kind === "incognito"
            ? "Temporary browsing session"
            : "Persistent cookies and logins",
        run: () =>
          props.ui.choose(profile.name, [
            { title: "Open a new tab with this profile", run: () => newTab("", profile.id) },
            {
              title: "Clear profile…",
              run: () =>
                props.ui.confirm(
                  `Clear ${profile.name}?`,
                  "This removes saved cookies, cache and logins from this profile.",
                  async () => {
                    target.check();
                    await request(props.client, WS_METHODS.previewClearProfile, {
                      profileId: profile.id,
                    });
                  },
                  "Clear profile",
                ),
            },
          ]),
      })),
    );
  }
  useKeyboard((key) => {
    if (!props.focused || props.ui.modal() || key.ctrl || key.meta) return;
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setSelected((value) =>
        Math.max(0, Math.min(sessions().length - 1, value + (key.name === "up" ? -1 : 1))),
      );
    }
    if (key.name === "return") {
      key.preventDefault();
      tabActions();
    }
    if (key.name === "n" && !key.ctrl) {
      key.preventDefault();
      newTab();
    }
    if (key.name === "r" && !key.ctrl) {
      key.preventDefault();
      void refresh();
    }
    if (key.name === "s" && !key.ctrl) {
      key.preventDefault();
      developmentServers();
    }
  });
  return (
    <box flexGrow={1} minHeight={0} paddingX={2} onMouseDown={props.onFocus}>
      <box flexDirection="row" height={2} alignItems="center" gap={2}>
        <text fg={theme.text} flexGrow={1}>
          Browser
        </text>
        <text fg={theme.textMuted} onMouseDown={profileActions}>
          Profiles
        </text>
        <text fg={theme.textMuted} onMouseDown={developmentServers}>
          Servers
        </text>
        <text fg={theme.primary} onMouseDown={() => newTab()}>
          New tab [N]
        </text>
      </box>
      <Show
        when={threadId()}
        fallback={<text fg={theme.textMuted}>Select a thread to view its browser tabs.</text>}
      >
        <Show when={failure()}>
          <text fg={theme.error} wrapMode="word">
            {failure()}
          </text>
          <text
            fg={theme.primary}
            onMouseDown={() => {
              void refresh();
            }}
          >
            Retry
          </text>
        </Show>
        <scrollbox flexGrow={1} minHeight={0} scrollY>
          <Show
            when={!loading() || sessions().length > 0}
            fallback={<text fg={theme.textMuted}>Loading browser tabs…</text>}
          >
            <Show
              when={sessions().length > 0}
              fallback={
                <box marginTop={1} gap={1}>
                  <text fg={theme.text}>No browser tabs in this thread.</text>
                  <text fg={theme.textMuted} wrapMode="word">
                    Open your app or use a detected development server below. Page content opens
                    through the browser; this terminal keeps the shared tab, profile and viewport
                    controls.
                  </text>
                </box>
              }
            >
              <For each={sessions()}>
                {(value, index) => (
                  <box
                    marginBottom={1}
                    padding={1}
                    backgroundColor={
                      selected() === index() ? theme.backgroundElement : theme.background
                    }
                    onMouseDown={() => {
                      setSelected(index());
                      tabActions(value);
                    }}
                  >
                    <text
                      fg={selected() === index() ? theme.primary : theme.text}
                    >{`${selected() === index() ? "› " : ""}${value.navStatus._tag === "Idle" ? "New tab" : value.navStatus.title || value.navStatus.url}`}</text>
                    <Show when={value.navStatus._tag !== "Idle"}>
                      <text fg={theme.textMuted} truncate>
                        <Show
                          when={terminalHyperlink(
                            value.navStatus._tag !== "Idle" ? value.navStatus.url : "",
                            capabilities(),
                          )}
                          fallback={value.navStatus._tag !== "Idle" ? value.navStatus.url : ""}
                        >
                          {(href) => (
                            <a href={href()}>
                              {value.navStatus._tag !== "Idle" ? value.navStatus.url : ""}
                            </a>
                          )}
                        </Show>
                      </text>
                    </Show>
                    <text
                      fg={value.navStatus._tag === "LoadFailed" ? theme.error : theme.textMuted}
                    >
                      {value.navStatus._tag === "LoadFailed"
                        ? value.navStatus.description
                        : value.navStatus._tag === "Loading"
                          ? "Loading…"
                          : `${profiles().find((profile) => profile.id === value.profileId)?.name ?? value.profileId ?? "Default"} · ${value.viewport?._tag === "freeform" || value.viewport?._tag === "preset" ? `${value.viewport.width} × ${value.viewport.height}` : "Fit viewer"} · ${Math.round((value.zoomFactor ?? 1) * 100)}%`}
                    </text>
                  </box>
                )}
              </For>
            </Show>
          </Show>
          <Show when={servers().length > 0}>
            <box marginTop={1}>
              <text fg={theme.text}>Development servers</text>
              <For each={servers()}>
                {(server) => (
                  <text
                    fg={theme.primary}
                    onMouseDown={() => serverActions(server)}
                  >{`${server.url}${server.processName ? ` · ${server.processName}` : ""}`}</text>
                )}
              </For>
            </box>
          </Show>
        </scrollbox>
        <text height={1} fg={theme.textMuted}>
          ↑↓ select · Enter tab actions · N new tab · R refresh · S servers
        </text>
      </Show>
    </box>
  );
}
