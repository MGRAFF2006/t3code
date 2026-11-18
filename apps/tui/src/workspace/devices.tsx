import {
  DeviceActionInput,
  DeviceAppearance,
  DeviceColorFilter,
  DeviceOrientation,
  DevicePermission,
  DeviceTextSize,
  WS_METHODS,
  type DeviceServiceState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { request, subscribe } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { useActiveKeyboard } from "../ui/keyboard.ts";
import type { Choice, Field, FeatureProps } from "../ui/controller.ts";
import { deviceHostActions } from "./device-hosts.ts";

const decodeAction = Schema.decodeUnknownSync(DeviceActionInput);
const options = (values: readonly string[]) =>
  values.map((value) => ({ label: value.replaceAll("_", " "), value }));

export function DevicesPanel(props: FeatureProps & { visible: boolean }) {
  const [state, setState] = createSignal<DeviceServiceState | null>(null);
  const [failure, setFailure] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const environment = createMemo(() => props.state()?.environmentId);
  const thread = createMemo(() => props.state()?.selectedThreadId);
  const devices = () => state()?.devices ?? [];
  createEffect(() => {
    const destination = environment();
    if (!props.visible || !destination) return;
    setState(null);
    setFailure("");
    setSelected(0);
    const stop = subscribe(
      props.client,
      WS_METHODS.subscribeDeviceState,
      {},
      (value) => {
        if (environment() === destination) setState(value);
      },
      (error) => setFailure(error.message),
    );
    onCleanup(stop);
  });
  function capture() {
    const id = environment();
    if (!id) throw new Error("Connect an environment before using its devices.");
    return () => {
      if (environment() !== id)
        throw new Error("The environment changed. Open device actions again.");
    };
  }
  async function refresh(
    input: Parameters<typeof request<typeof WS_METHODS.deviceList>>[2] = { inspectOnly: true },
  ) {
    const check = capture();
    const next = await request(props.client, WS_METHODS.deviceList, input);
    check();
    setState(next);
    setFailure("");
  }
  function settings() {
    const check = capture();
    const current = state();
    props.ui.form({
      title: "Device support",
      fields: [
        {
          name: "enabled",
          label: "Enable devices",
          type: "toggle",
          value: String(current?.hostStatus !== "disabled"),
        },
        {
          name: "agents",
          label: "Allow agent device access",
          type: "toggle",
          value: String(current?.agentAccessEnabled ?? false),
        },
      ],
      submitLabel: "Save",
      onSubmit: async (values) => {
        check();
        const next = await request(props.client, WS_METHODS.deviceConfigure, {
          enabled: values.enabled === "true",
          agentAccessEnabled: values.agents === "true",
          onboardingCompleted: true,
        });
        check();
        setState(next);
      },
    });
  }
  function hosts() {
    const check = capture();
    props.ui.choose("Device hosts", [
      {
        title: "Configure device hosts…",
        run: () =>
          void props.ui.run(() =>
            deviceHostActions(props, () => refresh({ inspectOnly: true }), {
              eas: !!state()?.supportsEasHosts,
              simlock: !!state()?.supportsSimlockHosts,
            }),
          ),
      },
      ...(state()?.hosts ?? []).map((host) => ({
        title: host.label,
        description: `${host.kind} · ${state()?.hostStatuses[host.id]?.status ?? "unknown"}`,
        run: () =>
          props.ui.choose(host.label, [
            {
              title: "Host status and tool versions",
              run: () =>
                props.ui.text(
                  host.label,
                  [
                    state()?.hostStatuses[host.id]?.detail,
                    ...host.platforms.map(
                      (platform) =>
                        `${platform.platform}: ${platform.available ? "available" : (platform.reason ?? "unavailable")}`,
                    ),
                    ...(host.tools
                      ? Object.entries(host.tools).map(
                          ([name, tool]) =>
                            `${name}: required ${tool.requiredVersion}; installed ${tool.installedVersions.join(", ") || "none"}; running ${tool.runningVersion ?? "none"}`,
                        )
                      : []),
                  ]
                    .filter(Boolean)
                    .join("\n"),
                ),
            },
            ...(state()?.supportsHostRetry
              ? [
                  {
                    title: "Reconnect host",
                    run: () =>
                      void props.ui.run(async () => {
                        check();
                        await refresh({ retryHostId: host.id });
                      }),
                  },
                ]
              : []),
          ]),
      })),
    ]);
  }
  function tools() {
    const check = capture();
    props.ui.choose("Device tools", [
      {
        title: "Inspect installed tool versions",
        run: () =>
          void props.ui.run(async () => {
            check();
            await refresh({ inspectOnly: true });
            hosts();
          }),
      },
      ...(state()?.supportsToolUpdate
        ? (["hub", "agent"] as const).map((updateTool) => ({
            title: `Update ${updateTool === "hub" ? "device hub" : "agent tools"}`,
            run: () =>
              props.ui.confirm(
                "Update device tools?",
                "Installs the versions chosen by this T3 environment. Downloads may be required.",
                async () => {
                  check();
                  await refresh({ updateTool });
                },
                "Update tools",
              ),
          }))
        : []),
    ]);
  }
  function actions(device = devices()[Math.max(0, Math.min(selected(), devices().length - 1))]) {
    if (!device) return;
    const check = capture();
    const target = { hostId: device.hostId, deviceId: device.id };
    const threadId = thread();
    const ownSession = () =>
      state()?.sessions.find(
        (value) =>
          value.hostId === device.hostId &&
          value.deviceId === device.id &&
          value.threadId === threadId,
      );
    const act = async (input: unknown) => {
      check();
      await request(
        props.client,
        WS_METHODS.deviceAction,
        decodeAction({ ...target, ...(input as object) }),
      );
    };
    const form = (
      title: string,
      fields: Field[],
      build: (values: Record<string, string>) => unknown,
    ) =>
      props.ui.form({
        title,
        fields,
        submitLabel: "Apply",
        onSubmit: async (values) => act(build(values)),
      });
    const select = (title: string, type: string, values: readonly string[]) =>
      form(
        title,
        [
          {
            name: "value",
            label: title,
            type: "select",
            value: values[0] ?? "",
            options: options(values),
          },
        ],
        (value) => ({ type, value: value.value }),
      );
    const detail = async () => {
      check();
      const value = await request(props.client, WS_METHODS.deviceDetail, target);
      check();
      props.ui.text(
        device.name,
        [
          `${device.platform} ${device.version}`,
          `Foreground app: ${value.foregroundApp?.name ?? value.foregroundApp?.id ?? "none"}`,
          ...Object.entries(value.settings).map(
            ([name, value]) =>
              `${name}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
          ),
        ].join("\n"),
      );
    };
    const choices: Choice[] = [
      { title: "Device details", run: () => void props.ui.run(detail) },
      {
        title: "Boot and open for this thread",
        run: () =>
          void props.ui.run(async () => {
            check();
            if (!threadId || thread() !== threadId)
              throw new Error("Select the original thread before opening its device.");
            await request(props.client, WS_METHODS.deviceOpen, {
              ...target,
              threadId,
              platform: device.platform,
              boot: true,
            });
            props.ui.notify(
              "Device opened. Its graphical view remains available in T3 web or desktop.",
            );
          }),
      },
      ...(ownSession() && threadId
        ? [
            {
              title: "Close device session",
              run: () =>
                void props.ui.run(async () => {
                  check();
                  await request(props.client, WS_METHODS.deviceClose, { ...target, threadId });
                }),
            },
          ]
        : []),
      {
        title: "Shut down device",
        run: () =>
          props.ui.confirm(
            "Shut down device?",
            "Stops this simulator or emulator, including apps running in it.",
            async () => {
              check();
              await request(props.client, WS_METHODS.deviceShutdown, {
                ...target,
                platform: device.platform,
              });
            },
            "Shut down",
          ),
      },
      {
        title: "Appearance",
        run: () => select("Appearance", "setAppearance", DeviceAppearance.literals),
      },
      {
        title: "Text size",
        run: () => select("Text size", "setTextSize", DeviceTextSize.literals),
      },
      {
        title: "Orientation",
        run: () => select("Orientation", "setOrientation", DeviceOrientation.literals),
      },
      {
        title: "Color filter",
        run: () => select("Color filter", "setColorFilter", DeviceColorFilter.literals),
      },
      {
        title: "Liquid Glass",
        run: () => select("Liquid Glass", "setLiquidGlass", ["clear", "tinted"]),
      },
      {
        title: "Accessibility and network toggles",
        run: () =>
          form(
            "Accessibility and network",
            [
              {
                name: "setting",
                label: "Setting",
                type: "select",
                value: "reduceMotion",
                options: options([
                  "reduceMotion",
                  "increaseContrast",
                  "reduceTransparency",
                  "showBorders",
                  "voiceOver",
                  "networkEnabled",
                ]),
              },
              { name: "value", label: "Enabled", type: "toggle", value: "true" },
            ],
            (values) => ({
              type: "setToggle",
              setting: values.setting,
              value: values.value === "true",
            }),
          ),
      },
      {
        title: "Set location",
        run: () =>
          form(
            "Device location",
            [
              { name: "latitude", label: "Latitude (−90…90)", type: "number", required: true },
              { name: "longitude", label: "Longitude (−180…180)", type: "number", required: true },
            ],
            (values) => ({
              type: "setLocation",
              latitude: Number(values.latitude),
              longitude: Number(values.longitude),
            }),
          ),
      },
      {
        title: "Clear simulated location",
        run: () => void props.ui.run(() => act({ type: "clearLocation" })),
      },
      {
        title: "App permissions",
        run: () =>
          form(
            "App permission",
            [
              { name: "app", label: "App or bundle ID", required: true },
              {
                name: "permission",
                label: "Permission",
                type: "select",
                value: "camera",
                options: options(DevicePermission.literals),
              },
              {
                name: "decision",
                label: "Decision",
                type: "select",
                value: "grant",
                options: options(["grant", "revoke", "reset"]),
              },
            ],
            (values) => ({
              type: "setPermission",
              appId: values.app,
              permission: values.permission,
              decision: values.decision,
            }),
          ),
      },
      {
        title: "Open URL or deep link",
        run: () =>
          form("Open device URL", [{ name: "url", label: "URL", required: true }], (values) => ({
            type: "openUrl",
            url: values.url,
          })),
      },
      ...(["launchApp", "terminateApp"] as const).map((type) => ({
        title: type === "launchApp" ? "Launch app" : "Terminate app",
        run: () =>
          form(
            type === "launchApp" ? "Launch app" : "Terminate app",
            [{ name: "app", label: "App or bundle ID", required: true }],
            (values) => ({ type, appId: values.app }),
          ),
      })),
      { title: "Shake device", run: () => void props.ui.run(() => act({ type: "shake" })) },
      {
        title: "Send push notification",
        run: () =>
          form(
            "Send push notification",
            [
              { name: "app", label: "App or bundle ID", required: true },
              {
                name: "payload",
                label: "Push payload (JSON)",
                type: "multiline",
                required: true,
                value: '{"aps":{"alert":"Test notification"}}',
              },
            ],
            (values) => ({ type: "sendPush", appId: values.app, payload: values.payload }),
          ),
      },
    ];
    props.ui.choose(device.name, choices);
  }
  useActiveKeyboard(
    () => props.visible && props.focused && !props.ui.modal(),
    (event) => {
      if (event.ctrl || event.meta) return;
      if (event.name === "up" || event.name === "down")
        setSelected((value) =>
          Math.max(0, Math.min(devices().length - 1, value + (event.name === "up" ? -1 : 1))),
        );
      else if (event.name === "return") actions();
      else if (event.name === "r") void props.ui.run(() => refresh());
      else if (event.name === "s") settings();
      else if (event.name === "h") hosts();
      else if (event.name === "t") tools();
      else return;
      event.preventDefault();
      event.stopPropagation();
    },
  );
  return (
    <box visible={props.visible} flexGrow={1} minHeight={0} paddingX={1}>
      <box height={2} flexDirection="row" gap={2} alignItems="center">
        <text fg={theme.text} flexGrow={1}>
          Devices
        </text>
        <text fg={theme.textMuted} onMouseDown={hosts}>
          Hosts
        </text>
        <text fg={theme.textMuted} onMouseDown={tools}>
          Tools
        </text>
        <text fg={theme.primary} onMouseDown={settings}>
          Settings
        </text>
      </box>
      <Show when={failure()}>
        <text fg={theme.error} wrapMode="word">
          {failure()}
        </text>
      </Show>
      <text fg={theme.textMuted} wrapMode="word">
        {state()?.hostStatusDetail ?? state()?.hostStatus ?? "Loading devices…"}
      </text>
      <scrollbox flexGrow={1} minHeight={0}>
        <For each={devices()}>
          {(device, index) => (
            <box
              paddingY={1}
              backgroundColor={selected() === index() ? theme.backgroundElement : theme.background}
              onMouseDown={() => {
                props.onFocus();
                setSelected(index());
                actions(device);
              }}
            >
              <text fg={theme.text}>{device.name}</text>
              <text fg={theme.textMuted}>
                {device.platform} {device.version} · {device.booted ? "Running" : "Stopped"}
                {device.physical ? " · Physical device" : ""}
              </text>
              <text fg={theme.textMuted}>
                {state()?.hosts.find((host) => host.id === device.hostId)?.label ?? device.hostId}
              </text>
            </box>
          )}
        </For>
        <Show when={state() && !devices().length}>
          <text fg={theme.textMuted} wrapMode="word">
            No devices found. Enable device support in Settings or configure a host in the
            environment's device settings.
          </text>
        </Show>
      </scrollbox>
      <text fg={theme.textMuted}>
        ↑↓ select · Enter actions · R refresh · H hosts · T tools · S settings
      </text>
    </box>
  );
}
