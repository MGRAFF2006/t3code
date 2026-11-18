import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
  untrack,
} from "solid-js";
import {
  AuthStandardClientScopes,
  UsageDay,
  WS_METHODS,
  type AuthAccessSnapshot,
  type AuthGrantScope,
  type AuthEnvironmentScope,
  type DatabaseStorageStatus,
  type ServerProcessDiagnosticsResult,
  type ServerTraceDiagnosticsResult,
  type StorageCleanupReport,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { applyAuthAccessStreamEvent } from "@t3tools/client-runtime/state/auth";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request, subscribe } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { Action, destinationGuard, errorMessage, Section } from "./common.tsx";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";
import { usageSettingsActions } from "./usage-settings.ts";
import { secretSettingsActions } from "./secrets.tsx";
import { resourceActions } from "./resources.ts";

const permissionLabels: Record<AuthEnvironmentScope, string> = {
  "orchestration:read": "Read projects and threads",
  "orchestration:operate": "Control agents and threads",
  "settings:write": "Change environment settings",
  "providers:manage": "Manage providers and sign-in",
  "environment:maintain": "Maintain and update environment",
  "preview:operate": "Control browser previews",
  "diagnostics:read": "Read diagnostics",
  "terminal:read": "Read terminals",
  "terminal:operate": "Control terminals",
  "source-control:write": "Change source control",
  "review:write": "Submit reviews",
  "filesystem:read": "Read workspace files",
  "filesystem:write": "Write workspace files",
  "relay:read": "Read relay connections",
  "relay:write": "Manage relay connections",
  "access:read": "Read authorized clients",
  "access:write": "Authorize and revoke clients",
};

export type ExtraSettingsSection = "usage" | "maintenance" | "access" | "secrets";
const bytes = (value: number) =>
  value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(2)} GiB`
    : `${(value / 1024 ** 2).toFixed(1)} MiB`;
const usd = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });

export function createSettingsExtras(
  props: FeatureProps,
  section: Accessor<ExtraSettingsSection | null>,
) {
  const environment = createMemo(() => props.state()?.environmentId);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [usage, setUsage] = createSignal<UsageSummary | null>(null);
  const [database, setDatabase] = createSignal<DatabaseStorageStatus | null>(null);
  const [cleanup, setCleanup] = createSignal<StorageCleanupReport | null>(null);
  const [access, setAccess] = createSignal<AuthAccessSnapshot>({
    pairingLinks: [],
    clientSessions: [],
  });
  const [processes, setProcesses] = createSignal<ServerProcessDiagnosticsResult | null>(null);
  const [trace, setTrace] = createSignal<ServerTraceDiagnosticsResult | null>(null);
  const [loading, setLoading] = createSignal(false);
  const today = DateTime.setZoneNamedUnsafe(DateTime.nowUnsafe(), "Europe/Berlin");
  const [range, setRange] = createSignal<UsageSummaryInput>({
    sinceDay: UsageDay.make(DateTime.formatIsoDate(DateTime.subtract(today, { days: 30 }))),
    untilDay: UsageDay.make(DateTime.formatIsoDate(today)),
    timeZone: "Europe/Berlin",
    resolution: "day",
  });
  let generation = 0;

  async function refreshUsage(awaitRefresh = false) {
    const guard = destinationGuard(props);
    const current = ++generation;
    setLoading(true);
    setFailure(null);
    try {
      guard();
      const value = await request(props.client, WS_METHODS.serverGetUsageSummary, {
        ...range(),
        awaitRefresh,
      });
      guard();
      if (current === generation) setUsage(value);
    } catch (error) {
      if (current === generation) setFailure(errorMessage(error));
    } finally {
      if (current === generation) setLoading(false);
    }
  }

  createEffect(() => {
    const id = environment();
    const activeSection = section();
    setFailure(null);
    if (!id) return;
    let active = true;
    const fail = (error: Error) => {
      if (active) setFailure(error.message);
    };
    const stops: (() => void)[] = [];
    if (activeSection === "usage") {
      setUsage(null);
      void untrack(() => refreshUsage());
    }
    if (activeSection === "maintenance") {
      setDatabase(null);
      setCleanup(null);
      setProcesses(null);
      setTrace(null);
      stops.push(
        subscribe(
          props.client,
          WS_METHODS.serverGetDatabaseStorage,
          {},
          (value) => {
            if (active) setDatabase(value);
          },
          fail,
        ),
      );
      stops.push(
        subscribe(
          props.client,
          WS_METHODS.serverGetStorageCleanupReport,
          {},
          (value) => {
            if (active) setCleanup(value);
          },
          fail,
        ),
      );
    }
    if (activeSection === "access") {
      setAccess({ pairingLinks: [], clientSessions: [] });
      stops.push(
        subscribe(
          props.client,
          WS_METHODS.subscribeAuthAccess,
          {},
          (event) => {
            if (active) setAccess((value) => applyAuthAccessStreamEvent(value, event));
          },
          fail,
        ),
      );
    }
    onCleanup(() => {
      active = false;
      generation += 1;
      setLoading(false);
      for (const stop of stops) stop();
    });
  });

  function usageFilter() {
    const guard = destinationGuard(props);
    const current = range();
    props.ui.form({
      title: "Usage period",
      fields: [
        {
          name: "since",
          label: "First day",
          value: current.sinceDay,
          required: true,
          description: "YYYY-MM-DD",
        },
        { name: "until", label: "Last day", value: current.untilDay, required: true },
        { name: "zone", label: "Time zone", value: current.timeZone, required: true },
        {
          name: "resolution",
          label: "Group by",
          type: "select",
          value: current.resolution ?? "day",
          options: [
            { label: "Day", value: "day" },
            { label: "Hour", value: "hour" },
          ],
        },
        {
          name: "model",
          label: "Model ID (optional)",
          value: current.modelFilter?.include?.[0]?.model ?? "",
        },
        {
          name: "provider",
          label: "Provider (optional)",
          value: current.modelFilter?.include?.[0]?.provider ?? "",
        },
      ],
      submitLabel: "Show usage",
      onSubmit: async (values) => {
        guard();
        const sinceDay = UsageDay.make(values.since?.trim() ?? "");
        const untilDay = UsageDay.make(values.until?.trim() ?? "");
        if (sinceDay > untilDay) throw new Error("The first day must be before the last day.");
        const timeZone = values.zone?.trim() ?? "";
        DateTime.zoneMakeNamedUnsafe(timeZone);
        setRange({
          sinceDay,
          untilDay,
          timeZone,
          resolution: values.resolution === "hour" ? "hour" : "day",
          ...(values.model?.trim()
            ? {
                modelFilter: {
                  include: [
                    {
                      model: values.model.trim(),
                      ...(values.provider?.trim() ? { provider: values.provider.trim() } : {}),
                    },
                  ],
                },
              }
            : {}),
        });
        await refreshUsage();
      },
    });
  }

  function cleanupSettings() {
    const guard = destinationGuard(props);
    const current = props.state()?.config?.settings.storageCleanup;
    if (!current) return;
    props.ui.form({
      title: "Storage retention",
      description:
        "Blank retention periods keep data indefinitely. Cleanup keeps worktrees according to your change policy.",
      fields: [
        {
          name: "worktree",
          label: "Worktrees after days",
          type: "number",
          value: current.worktreeAfterDays === null ? "" : String(current.worktreeAfterDays),
        },
        {
          name: "settled",
          label: "Settled worktrees after days",
          type: "number",
          value:
            current.worktreeSettledAfterDays === null
              ? ""
              : String(current.worktreeSettledAfterDays),
        },
        {
          name: "browser",
          label: "Browser artifacts after days",
          type: "number",
          value:
            current.browserArtifactsAfterDays === null
              ? ""
              : String(current.browserArtifactsAfterDays),
        },
        {
          name: "logs",
          label: "Logs after days",
          type: "number",
          value: current.logsAfterDays === null ? "" : String(current.logsAfterDays),
        },
        {
          name: "keep",
          label: "Keep worktrees with",
          type: "select",
          value: current.worktreeKeepWhen,
          options: [
            { label: "Uncommitted changes", value: "uncommitted-changes" },
            { label: "Tracked changes", value: "tracked-changes" },
          ],
        },
        {
          name: "merged",
          label: "Remove worktrees after merge",
          type: "toggle",
          value: String(current.worktreeOnMerge),
        },
        {
          name: "deleted",
          label: "Remove worktrees after thread deletion",
          type: "toggle",
          value: String(current.worktreeOnDelete),
        },
        {
          name: "unchanged",
          label: "Remove unchanged worktrees",
          type: "toggle",
          value: String(current.worktreeUnchanged),
        },
      ],
      submitLabel: "Save retention",
      onSubmit: async (values) => {
        guard();
        function days(name: string) {
          if (!values[name]?.trim()) return null;
          const value = Number(values[name]);
          if (!Number.isInteger(value) || value < 1)
            throw new Error("Retention periods must be a positive number of days, or blank.");
          return value;
        }
        await request(props.client, WS_METHODS.serverUpdateSettings, {
          patch: {
            storageCleanup: {
              worktreeAfterDays: days("worktree"),
              worktreeSettledAfterDays: days("settled"),
              browserArtifactsAfterDays: days("browser"),
              logsAfterDays: days("logs"),
              worktreeKeepWhen:
                values.keep === "tracked-changes" ? "tracked-changes" : "uncommitted-changes",
              worktreeOnMerge: values.merged === "true",
              worktreeOnDelete: values.deleted === "true",
              worktreeUnchanged: values.unchanged === "true",
            },
          },
        });
        props.ui.notify("Storage retention saved.");
      },
    });
  }

  function updates() {
    const guard = destinationGuard(props);
    props.ui.form({
      title: "Check server update",
      fields: [
        {
          name: "spec",
          label: "Release",
          type: "select",
          value: "latest",
          options: [
            { label: "Stable", value: "latest" },
            { label: "Nightly", value: "nightly" },
          ],
        },
      ],
      submitLabel: "Check release",
      onSubmit: async (values) => {
        guard();
        const release = await request(props.client, WS_METHODS.serverGetNpmRelease, {
          spec: values.spec === "nightly" ? "nightly" : "latest",
        });
        guard();
        if (!release) {
          props.ui.notify("No release was returned by the environment's registry.");
          return;
        }
        const capability = props.state()?.config?.environment.capabilities;
        props.ui.confirm(
          "Update this environment",
          `Install T3 Code ${release.version} on ${props.state()?.label}? The server will restart and active clients will reconnect.`,
          async () => {
            guard();
            const input = {
              targetVersion: release.version,
              ...(release.databaseMigration === undefined
                ? {}
                : { targetDatabaseMigration: release.databaseMigration }),
            };
            if (!capability?.serverSelfUpdate)
              throw new Error("This installation must be updated on its host.");
            await props.client.updateServer(input);
            props.ui.notify(
              `Update to ${release.version} requested. Reconnect after the server restarts.`,
            );
          },
          `Update to ${release.version}`,
        );
      },
    });
  }

  function processActions() {
    const guard = destinationGuard(props);
    void props.ui.run(async () => {
      guard();
      const result = await request(props.client, WS_METHODS.serverGetProcessDiagnostics, {});
      guard();
      setProcesses(result);
      props.ui.choose(
        "Server processes",
        result.processes.map((process) => ({
          title: `${process.pid} ${process.command}`,
          description: `${process.cpuPercent.toFixed(1)}% CPU · ${bytes(process.rssBytes)} · ${process.status}`,
          run: () =>
            props.ui.choose(`Process ${process.pid}`, [
              {
                title: "Show command",
                run: () =>
                  props.ui.text(
                    `Process ${process.pid}`,
                    `${process.command}\n\nPID ${process.pid}; parent ${process.ppid}\nCPU ${process.cpuPercent.toFixed(1)}%; RSS ${bytes(process.rssBytes)}\nElapsed ${process.elapsed}`,
                  ),
              },
              ...(process.pid !== result.serverPid
                ? (["SIGINT", "SIGKILL"] as const).map((signal) => ({
                    title: signal === "SIGINT" ? "Interrupt process" : "Force stop process",
                    run: () =>
                      props.ui.confirm(
                        "Signal server process",
                        `${signal} to PID ${process.pid}?\n${process.command}`,
                        async () => {
                          guard();
                          const value = await request(
                            props.client,
                            WS_METHODS.serverSignalProcess,
                            { pid: process.pid, startTimeMs: process.startTimeMs, signal },
                          );
                          if (!value.signaled)
                            throw new Error(
                              Option.getOrElse(
                                value.message,
                                () => "The process was not signalled.",
                              ),
                            );
                        },
                        signal === "SIGINT" ? "Interrupt" : "Force stop",
                      ),
                  }))
                : []),
            ]),
        })),
      );
    });
  }

  function createGrant() {
    const guard = destinationGuard(props);
    const scopes: readonly AuthGrantScope[] = AuthStandardClientScopes;
    props.ui.form({
      title: "Create pairing credential",
      description:
        "The credential can be used once to authorize a client. Only grant the permissions it needs.",
      fields: [
        { name: "label", label: "Client label", required: true },
        ...scopes.map((scope) => ({
          name: scope,
          label: permissionLabels[scope],
          type: "toggle" as const,
          value: String(
            [
              "orchestration:read",
              "orchestration:operate",
              "filesystem:read",
              "source-control:write",
              "preview:operate",
              "terminal:read",
              "terminal:operate",
            ].includes(scope),
          ),
        })),
      ],
      submitLabel: "Create credential",
      onSubmit: async (values) => {
        guard();
        const result = await props.client.access.createPairingCredential({
          label: values.label?.trim() ?? "",
          scopes: scopes.filter((scope) => values[scope] === "true"),
        });
        guard();
        const urls = (props.state()?.config?.directEndpoints ?? []).map((endpoint) => {
          const url = new URL(endpoint.httpBaseUrl);
          url.pathname = "/pair";
          return setPairingTokenOnUrl(url, result.credential).href;
        });
        props.ui.text(
          "Pairing credential",
          `${urls.join("\n\n")}${urls.length ? "\n\nCode: " : ""}${result.credential}\n\nExpires ${DateTime.formatIso(result.expiresAt)}\nShare only with the client you are authorizing.`,
        );
      },
    });
  }

  const entries = createMemo<Choice[]>(() => {
    if (section() === "usage")
      return [
        ...usageSettingsActions(props),
        {
          title: "Period and filters",
          description: `${range().sinceDay} through ${range().untilDay} (${range().timeZone})`,
          run: usageFilter,
        },
        {
          title: "Refresh usage",
          description: "Read fresh usage from the providers on this environment.",
          run: () => void props.ui.run(() => refreshUsage(true)),
        },
        {
          title: "Refresh model prices",
          description: usage()?.pricing.source,
          run: () => {
            const guard = destinationGuard(props);
            void props.ui.run(async () => {
              guard();
              const pricing = await request(props.client, WS_METHODS.serverRefreshUsageRates, {});
              props.ui.notify(`Model prices: ${pricing.status}, ${pricing.knownModels} models.`);
            });
          },
        },
      ];
    if (section() === "maintenance") {
      const guard = destinationGuard(props);
      const canUpdate = props.state()?.config?.environment.capabilities.npmReleaseLookup;
      return [
        {
          title: "Storage retention",
          description: "Choose which worktrees, logs and browser artifacts cleanup can remove.",
          run: cleanupSettings,
        },
        {
          title: "Run storage cleanup",
          description: "Apply the saved retention policy now.",
          run: () =>
            props.ui.confirm(
              "Run storage cleanup",
              "Remove eligible worktrees, logs and browser artifacts according to this environment's retention settings?",
              async () => {
                guard();
                const value = await request(props.client, WS_METHODS.serverRunStorageCleanup, {});
                guard();
                setCleanup(value);
                props.ui.notify(`Cleanup freed ${bytes(value.bytesFreed)}.`);
              },
              "Run cleanup",
            ),
        },
        ...(database()?.canReclaim
          ? [
              {
                title: "Reclaim database space",
                description: `${bytes(database()?.reclaimableBytes ?? 0)} reclaimable. The server restarts during repair.`,
                run: () =>
                  props.ui.confirm(
                    "Reclaim database space",
                    "The server stops and repairs its database, then reconnects. Wait for active turns to finish before continuing.",
                    async () => {
                      guard();
                      await request(props.client, WS_METHODS.serverReclaimDatabaseSpace, {});
                    },
                    "Reclaim space",
                  ),
              },
            ]
          : []),
        { title: "Process diagnostics", run: processActions },
        { title: "CPU, memory and resource history", run: () => resourceActions(props) },
        {
          title: "Trace diagnostics",
          run: () =>
            void props.ui.run(async () => {
              guard();
              const value = await request(props.client, WS_METHODS.serverGetTraceDiagnostics, {});
              guard();
              setTrace(value);
            }),
        },
        ...(canUpdate
          ? [
              {
                title: "Check server updates",
                description: props.state()?.config?.environment.serverVersion,
                run: updates,
              },
            ]
          : []),
        {
          title: "Refresh provider status",
          run: () =>
            void props.ui.run(async () => {
              guard();
              await request(props.client, WS_METHODS.serverRefreshProviders, {
                reloadSecrets: true,
              });
            }, "Provider status refreshed."),
        },
      ];
    }
    if (section() === "access") {
      const guard = destinationGuard(props);
      return [
        { title: "Create pairing credential", run: createGrant },
        {
          title: "Revoke other clients",
          run: () =>
            props.ui.confirm(
              "Revoke other clients",
              "Disconnect every other client authorized on this environment? This terminal keeps its session.",
              async () => {
                guard();
                await props.client.access.revokeOtherClients();
              },
              "Revoke others",
            ),
        },
        ...access().pairingLinks.map((link) => ({
          title: link.connectDeviceRequest
            ? `Approve ${link.connectDeviceRequest.client?.label ?? "T3 Connect device"}`
            : (link.label ?? "Pairing credential"),
          description: link.connectDeviceRequest
            ? `Verify code: ${link.connectDeviceRequest.verificationCode}`
            : `Expires ${DateTime.formatIso(link.expiresAt)}`,
          run: () =>
            props.ui.choose("Pairing access", [
              ...(link.connectDeviceRequest
                ? [
                    {
                      title: "Approve device",
                      description: `Compare ${link.connectDeviceRequest.verificationCode} with the code on the device.`,
                      run: () =>
                        props.ui.confirm(
                          "Approve device",
                          `Trust the device showing ${link.connectDeviceRequest!.verificationCode}?`,
                          async () => {
                            guard();
                            await props.client.access.approveConnectDevice({
                              pairingLinkId: link.id,
                            });
                          },
                          "Approve device",
                        ),
                    },
                  ]
                : []),
              {
                title: "Revoke pairing credential",
                run: () =>
                  props.ui.confirm(
                    "Revoke credential",
                    link.label ?? link.subject,
                    async () => {
                      guard();
                      await props.client.access.revokePairingLink({ id: link.id });
                    },
                    "Revoke",
                  ),
              },
            ]),
        })),
        ...access().clientSessions.map((session) => ({
          title: `${session.current ? "This terminal: " : ""}${session.client.label ?? session.subject}`,
          description: `${session.connected ? "Connected" : "Offline"} · ${session.method}`,
          run: () =>
            props.ui.choose("Client access", [
              {
                title: "View permissions",
                run: () =>
                  props.ui.text(
                    "Client permissions",
                    `${session.client.label ?? session.subject}\n\n${(session.permissions ?? session.scopes)?.map((scope) => permissionLabels[scope] ?? scope).join("\n") ?? "No scopes reported."}\n\nExpires ${DateTime.formatIso(session.expiresAt)}`,
                  ),
              },
              {
                title: "Revoke client",
                run: () =>
                  props.ui.confirm(
                    "Revoke client",
                    session.current
                      ? "This will disconnect this terminal from the environment."
                      : `Disconnect ${session.client.label ?? session.subject}?`,
                    async () => {
                      guard();
                      await props.client.access.revokeClient({ sessionId: session.sessionId });
                    },
                    "Revoke",
                  ),
              },
            ]),
        })),
        ...(access().connectDevices ?? []).map((device) => ({
          title: device.client?.label ?? `Trusted device ${device.verificationCode}`,
          description: `Approved ${DateTime.formatIso(device.approvedAt)}`,
          run: () =>
            props.ui.confirm(
              "Revoke trusted device",
              `Require approval again for ${device.client?.label ?? device.verificationCode}?`,
              async () => {
                guard();
                await props.client.access.revokeConnectDevice({
                  proofKeyThumbprint: device.proofKeyThumbprint,
                });
              },
              "Revoke device",
            ),
        })),
      ];
    }
    if (section() === "secrets") return secretSettingsActions(props);
    return [];
  });

  function Details() {
    return (
      <>
        <Show when={failure()}>
          <text fg={theme.error} wrapMode="word">
            {failure()}
          </text>
        </Show>
        <Show when={section() === "usage"}>
          <Show when={loading()}>
            <text fg={theme.textMuted}>Reading usage…</text>
          </Show>
          <Show when={usage()}>
            {(value) => (
              <>
                <Section title="Usage">
                  <text fg={theme.text}>
                    {usd(value().buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0))} total ·{" "}
                    {value().sources.reduce((sum, source) => sum + source.distinctSessions, 0)}{" "}
                    sessions
                  </text>
                  <text fg={theme.textMuted}>
                    {value().sinceDay} through {value().untilDay} · {value().timeZone}
                  </text>
                  <text fg={theme.textMuted}>
                    Prices: {value().pricing.status} · {value().pricing.source}
                  </text>
                </Section>
                <For each={value().buckets}>
                  {(bucket) => (
                    <Section title={`${bucket.hourStart ?? bucket.day} · ${bucket.model}`}>
                      <text fg={theme.textMuted}>
                        {bucket.provider} · {usd(bucket.costUsd)} · {bucket.costSource}
                      </text>
                      <text fg={theme.textMuted}>
                        Input {bucket.totals.uncachedInputTokens.toLocaleString()} · cached{" "}
                        {bucket.totals.cachedInputTokens.toLocaleString()} · output{" "}
                        {bucket.totals.outputTokens.toLocaleString()}
                      </text>
                      <Show when={bucket.unpricedRecords}>
                        <text fg={theme.warning}>
                          {bucket.unpricedRecords} records have no price.
                        </text>
                      </Show>
                    </Section>
                  )}
                </For>
                <For
                  each={value().sources.filter(
                    (source) => source.message || source.status !== "ok" || source.refreshing,
                  )}
                >
                  {(source) => (
                    <text
                      fg={source.status === "failed" ? theme.error : theme.textMuted}
                      wrapMode="word"
                    >
                      {source.status}
                      {source.refreshing ? " (refreshing)" : ""}: {source.message ?? ""}
                    </text>
                  )}
                </For>
              </>
            )}
          </Show>
        </Show>
        <Show when={section() === "maintenance"}>
          <Section title="Environment">
            <text fg={theme.textMuted}>
              T3 Code {props.state()?.config?.environment.serverVersion}
            </text>
            <text fg={theme.textMuted}>{props.state()?.label}</text>
          </Section>
          <Show when={database()}>
            {(value) => (
              <Section title="Database">
                <text fg={theme.text}>{bytes(value().databaseBytes)} on disk</text>
                <text fg={theme.textMuted}>{bytes(value().reclaimableBytes)} can be reclaimed</text>
                <Show when={value().reclaimFailure}>
                  <text fg={theme.error} wrapMode="word">
                    {value().reclaimFailure}
                  </text>
                </Show>
                <Show when={!value().canReclaim}>
                  <text fg={theme.textMuted} wrapMode="word">
                    Offline repair: {value().compactCommand}
                  </text>
                </Show>
              </Section>
            )}
          </Show>
          <Show when={cleanup()}>
            {(value) => (
              <Section title="Last cleanup">
                <text fg={theme.textMuted}>
                  {value().finishedAt} · {bytes(value().bytesFreed)} freed
                </text>
                <text fg={theme.textMuted}>
                  {value().counts.removed} removed · {value().counts.kept} kept ·{" "}
                  {value().counts.failed} failed
                </text>
                <For each={value().entries}>
                  {(entry) => (
                    <text
                      fg={entry.outcome === "failed" ? theme.error : theme.textMuted}
                      wrapMode="word"
                    >
                      {entry.outcome}: {entry.path ?? entry.threadTitle ?? entry.kind} ·{" "}
                      {entry.reason}
                    </text>
                  )}
                </For>
              </Section>
            )}
          </Show>
          <Show when={processes()}>
            {(value) => (
              <Section title="Processes">
                <text fg={theme.textMuted}>
                  {value().processCount} processes · {value().totalCpuPercent.toFixed(1)}% CPU ·{" "}
                  {bytes(value().totalRssBytes)} RSS
                </text>
                <For each={value().processes}>
                  {(process) => (
                    <text fg={theme.textMuted} wrapMode="word">
                      {process.pid} · {process.cpuPercent.toFixed(1)}% · {bytes(process.rssBytes)} ·{" "}
                      {process.command}
                    </text>
                  )}
                </For>
                <Show when={Option.isSome(value().error)}>
                  <text fg={theme.error}>{Option.getOrNull(value().error)?.message}</text>
                </Show>
              </Section>
            )}
          </Show>
          <Show when={trace()}>
            {(value) => (
              <Section title="Trace diagnostics">
                <text fg={theme.textMuted}>
                  {value().recordCount} records · {value().failureCount} failures ·{" "}
                  {value().slowSpanCount} slow spans
                </text>
                <text fg={theme.textMuted} wrapMode="word">
                  {value().traceFilePath}
                </text>
                <For each={value().commonFailures}>
                  {(entry) => (
                    <text fg={theme.warning} wrapMode="word">
                      {entry.name} ({entry.count}): {entry.cause}
                    </text>
                  )}
                </For>
                <Show when={Option.isSome(value().error)}>
                  <text fg={theme.error}>{Option.getOrNull(value().error)?.message}</text>
                </Show>
              </Section>
            )}
          </Show>
        </Show>
        <Show when={section() === "access"}>
          <Section title="Authorized clients">
            <text fg={theme.textMuted} wrapMode="word">
              Pair a new client, inspect its permissions, approve a T3 Connect device, or revoke
              access. Compare a device's verification code before approving it.
            </text>
            <text fg={theme.textMuted}>
              {access().clientSessions.length} clients · {access().pairingLinks.length} pending
              credentials · {access().connectDevices?.length ?? 0} trusted devices
            </text>
          </Section>
        </Show>
        <Show when={section() === "secrets"}>
          <Section title="Secret sources">
            <text fg={theme.textMuted} wrapMode="word">
              Secrets are read on this environment. Configure a source to use saved credentials
              without putting them in chat.
            </text>
            <Show when={props.state()?.config?.secretProviderSettings !== true}>
              <text fg={theme.warning}>
                This server does not support configuring secret sources.
              </text>
            </Show>
            <Action
              label="Pending requests and sources"
              onPress={() => props.ui.choose("Secrets", entries())}
            />
          </Section>
        </Show>
      </>
    );
  }
  return { entries, Details };
}
