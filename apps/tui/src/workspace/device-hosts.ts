import {
  EasDeviceHostConfig,
  SimlockDeviceHostConfig,
  SshDeviceHostConfig,
  SecretProviderId,
  isSecretReference,
  WS_METHODS,
  type DeviceHostConfig,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { request } from "../rpc/request.ts";
import type { Field, FeatureProps } from "../ui/controller.ts";

const isSshHost = Schema.is(SshDeviceHostConfig);
const isEasHost = Schema.is(EasDeviceHostConfig);
const isSimlockHost = Schema.is(SimlockDeviceHostConfig);

export async function deviceHostActions(
  props: FeatureProps,
  changed: () => Promise<void>,
  supported: { eas: boolean; simlock: boolean },
) {
  const environment = props.state()?.environmentId;
  const check = () => {
    if (!environment || props.state()?.environmentId !== environment)
      throw new Error("The environment changed. Open device hosts again.");
  };
  check();
  const settings = await request(props.client, WS_METHODS.serverGetSettings, {});
  check();
  const hosts: readonly DeviceHostConfig[] = [
    ...settings.deviceHosts,
    ...settings.easDeviceHosts,
    ...settings.simlockDeviceHosts,
  ];
  async function save(host: DeviceHostConfig, previous?: DeviceHostConfig) {
    check();
    const current = await request(props.client, WS_METHODS.serverGetSettings, {});
    check();
    const list =
      host.kind === "ssh"
        ? current.deviceHosts
        : host.kind === "eas"
          ? current.easDeviceHosts
          : current.simlockDeviceHosts;
    if (previous && !list.some((value) => value.id === previous.id))
      throw new Error("This host was removed. Open device hosts again.");
    if (
      !previous &&
      [...current.deviceHosts, ...current.easDeviceHosts, ...current.simlockDeviceHosts].some(
        (value) => value.id === host.id,
      )
    )
      throw new Error("Choose a unique device host ID.");
    if (host.kind === "ssh") {
      await request(props.client, WS_METHODS.serverUpdateSettings, {
        patch: {
          deviceHosts: previous
            ? current.deviceHosts.map((value) => (value.id === host.id ? host : value))
            : [...current.deviceHosts, host],
        },
      });
    } else if (host.kind === "eas") {
      await request(props.client, WS_METHODS.serverUpdateSettings, {
        patch: {
          easDeviceHosts: previous
            ? current.easDeviceHosts.map((value) => (value.id === host.id ? host : value))
            : [...current.easDeviceHosts, host],
        },
      });
    } else {
      await request(props.client, WS_METHODS.serverUpdateSettings, {
        patch: {
          simlockDeviceHosts: previous
            ? current.simlockDeviceHosts.map((value) => (value.id === host.id ? host : value))
            : [...current.simlockDeviceHosts, host],
        },
      });
    }
    check();
    await changed();
    props.ui.notify("Device host saved.");
  }
  function edit(kind: DeviceHostConfig["kind"], previous?: DeviceHostConfig) {
    const fields: Field[] = [
      ...(!previous
        ? [{ name: "id", label: "Host ID", value: SecureRandom.uuidV4Unsafe(), required: true }]
        : []),
      { name: "label", label: "Host name", value: previous?.label ?? "", required: true },
    ];
    if (kind === "ssh")
      fields.push(
        {
          name: "target",
          label: "SSH target (user@host)",
          value: previous?.kind === "ssh" ? previous.target : "",
          required: true,
        },
        {
          name: "identity",
          label: "Identity file on the environment (optional)",
          value: previous?.kind === "ssh" ? (previous.identityFile ?? "") : "",
        },
        {
          name: "port",
          label: "SSH port",
          type: "number",
          value: String(previous?.kind === "ssh" ? (previous.port ?? 22) : 22),
          required: true,
        },
      );
    else if (kind === "eas")
      fields.push(
        {
          name: "app",
          label: "Expo project ID (optional)",
          value: previous?.kind === "eas" ? (previous.appId ?? "") : "",
        },
        { name: "token", label: "New Expo access token (blank keeps saved token)", type: "secret" },
        {
          name: "clear",
          label: "Clear saved token and use environment or eas login",
          type: "toggle",
          value: "false",
        },
        {
          name: "session",
          label: "Maximum session minutes (1…115)",
          type: "number",
          value: String(previous?.kind === "eas" ? previous.maxSessionMinutes : 30),
          required: true,
        },
        {
          name: "idle",
          label: "Idle minutes (less than session limit)",
          type: "number",
          value: String(previous?.kind === "eas" ? previous.idleMinutes : 10),
          required: true,
        },
        {
          name: "sessions",
          label: "Concurrent sessions (1…20)",
          type: "number",
          value: String(previous?.kind === "eas" ? previous.maxConcurrentSessions : 2),
          required: true,
        },
      );
    else
      fields.push(
        {
          name: "gateway",
          label: "Simlock gateway origin",
          value: previous?.kind === "simlock" ? previous.gatewayUrl : "",
          required: true,
        },
        { name: "token", label: "New agent token (blank keeps saved token)", type: "secret" },
        { name: "clear", label: "Clear saved token", type: "toggle", value: "false" },
        {
          name: "leases",
          label: "Concurrent leases (1…20)",
          type: "number",
          value: String(previous?.kind === "simlock" ? previous.maxLeases : 2),
          required: true,
        },
        {
          name: "duration",
          label: "Maximum lease minutes (5…240)",
          type: "number",
          value: String(previous?.kind === "simlock" ? previous.maxLeaseMinutes : 60),
          required: true,
        },
      );
    if (kind !== "ssh")
      fields.push(
        {
          name: "provider",
          label: "Secret provider (optional)",
          type: "select",
          value: "",
          options: [
            { label: "Keep saved or entered token", value: "" },
            ...Object.entries(settings.secretProviders).map(([id, source]) => ({
              label: source.label || id,
              value: id,
            })),
          ],
        },
        { name: "reference", label: "Secret reference path (when a provider is selected)" },
      );
    function token(
      values: Record<string, string>,
      saved: SettingsSecretValue,
    ): SettingsSecretValue {
      if (values.clear === "true") return "";
      if (values.provider) {
        const reference = {
          provider: SecretProviderId.make(values.provider),
          reference: values.reference?.trim() ?? "",
        };
        if (!isSecretReference(reference)) throw new Error("Enter a valid secret reference path.");
        return reference;
      }
      return values.token?.trim() || saved;
    }
    props.ui.form({
      title: `${previous ? "Edit" : "Add"} ${kind === "eas" ? "Expo" : kind === "ssh" ? "SSH" : "Simlock"} device host`,
      description:
        kind === "eas"
          ? "Expo simulator sessions use the configured account and its billing. No session starts when saving a host."
          : "The selected T3 environment owns this connection.",
      fields,
      submitLabel: "Save host",
      onSubmit: async (values) => {
        check();
        const common = { id: previous?.id ?? values.id ?? "", label: values.label?.trim() ?? "" };
        if (kind === "ssh") {
          const host = {
            kind: "ssh" as const,
            ...common,
            target: values.target?.trim() ?? "",
            port: Number(values.port),
            ...(values.identity?.trim() ? { identityFile: values.identity.trim() } : {}),
          };
          if (!isSshHost(host))
            throw new Error("Check the host ID, SSH target, identity path and port.");
          await save(host, previous);
        } else if (kind === "eas") {
          const host = {
            kind: "eas" as const,
            ...common,
            ...(values.app?.trim() ? { appId: values.app.trim() } : {}),
            accessToken: token(values, previous?.kind === "eas" ? previous.accessToken : ""),
            maxSessionMinutes: Number(values.session),
            idleMinutes: Number(values.idle),
            maxConcurrentSessions: Number(values.sessions),
          };
          if (!isEasHost(host))
            throw new Error(
              "Check the host ID and session limits; idle minutes must be less than the session limit.",
            );
          await save(host, previous);
        } else {
          const host = {
            kind: "simlock" as const,
            ...common,
            gatewayUrl: values.gateway?.trim() ?? "",
            agentToken: token(values, previous?.kind === "simlock" ? previous.agentToken : ""),
            maxLeases: Number(values.leases),
            maxLeaseMinutes: Number(values.duration),
          };
          if (!isSimlockHost(host))
            throw new Error("Check the host ID, gateway origin and lease limits.");
          await save(host, previous);
        }
      },
    });
  }
  async function test(host: DeviceHostConfig) {
    check();
    if (host.kind === "ssh") {
      const result = await request(props.client, WS_METHODS.deviceTestHost, host);
      check();
      props.ui.text(
        host.label,
        result.platforms
          .map(
            (value) =>
              `${value.platform}: ${value.available ? "available" : (value.reason ?? "unavailable")}`,
          )
          .join("\n"),
      );
    } else if (host.kind === "eas") {
      const account = await request(props.client, WS_METHODS.deviceEasAccount, { hostId: host.id });
      check();
      props.ui.text(
        "Expo account",
        [
          `Signed in as ${account.signedInAs}`,
          `Credential source: ${account.credentialSource}`,
          ...account.apps.map((app) => `${app.fullName} (${app.id})`),
        ].join("\n"),
      );
    } else {
      const identity = await request(props.client, WS_METHODS.deviceSimlockIdentity, {
        hostId: host.id,
      });
      check();
      props.ui.text(
        "Simlock identity",
        [
          identity.gatewayUrl,
          `Signed in as ${identity.signedInAs}`,
          `Credential source: ${identity.tokenSource}`,
        ].join("\n"),
      );
    }
  }
  const kinds: DeviceHostConfig["kind"][] = ["ssh"];
  if (supported.eas) kinds.push("eas");
  if (supported.simlock) kinds.push("simlock");
  props.ui.choose("Configured device hosts", [
    ...kinds.map((kind) => ({
      title: `Add ${kind === "ssh" ? "SSH" : kind === "eas" ? "Expo" : "Simlock"} host…`,
      run: () => edit(kind),
    })),
    ...hosts.map((host) => ({
      title: host.label,
      description: host.kind,
      run: () =>
        props.ui.choose(host.label, [
          { title: "Edit host…", run: () => edit(host.kind, host) },
          {
            title: host.kind === "ssh" ? "Test SSH host" : "Check account and identity",
            run: () => void props.ui.run(() => test(host)),
          },
          {
            title: "Remove host…",
            run: () =>
              props.ui.confirm(
                "Remove device host?",
                "Removes this host configuration. Stop active sessions before removing it.",
                async () => {
                  check();
                  const current = await request(props.client, WS_METHODS.serverGetSettings, {});
                  check();
                  const patch =
                    host.kind === "ssh"
                      ? { deviceHosts: current.deviceHosts.filter((value) => value.id !== host.id) }
                      : host.kind === "eas"
                        ? {
                            easDeviceHosts: current.easDeviceHosts.filter(
                              (value) => value.id !== host.id,
                            ),
                          }
                        : {
                            simlockDeviceHosts: current.simlockDeviceHosts.filter(
                              (value) => value.id !== host.id,
                            ),
                          };
                  await request(props.client, WS_METHODS.serverUpdateSettings, { patch });
                  check();
                  await changed();
                  props.ui.notify("Device host removed.");
                },
                "Remove host",
              ),
          },
        ]),
    })),
  ]);
}
