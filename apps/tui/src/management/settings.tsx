import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { getProviderClient, providerClients } from "@t3tools/client-runtime/provider-clients";
import {
  CustomModelSetting,
  DesktopSshEnvironmentTargetSchema,
  isSecretSetting,
  ProviderInstanceId,
  WS_METHODS,
  ClientServerSettingsPatch,
  type ProviderAuthState,
  type ProviderInstallState,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Choice, FeatureProps, Field } from "../ui/controller.ts";
import { request, subscribe } from "../rpc/request.ts";
import { theme } from "../theme/index.ts";
import { createTerminalSettings } from "./terminal-settings.tsx";
import { createSettingsExtras, type ExtraSettingsSection } from "./settings-extras.tsx";
import { Action, destinationGuard, Section } from "./common.tsx";
import { keybindingActions } from "./keybindings.ts";
import { registryProviderActions, searchRegistry } from "./registry.ts";
import { environmentSettingsActions } from "./environment.ts";
import { createChatGptProfileActions } from "./chatgpt.ts";
import {
  issueTrackerActions,
  linkedEnvironmentActions,
  sourceControlActions,
} from "./integrations.ts";

const decodeSshTarget = Schema.decodeSync(DesktopSshEnvironmentTargetSchema);
const providerDecoders = new Map(
  providerClients.definitions.map((definition) => [
    definition.driverKind,
    Schema.decodeSync(definition.settingsSchema as unknown as Schema.Decoder<unknown>),
  ]),
);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
const titleCase = (key: string) =>
  key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
type SectionName = "environment" | "providers" | "connections" | "terminal" | ExtraSettingsSection;
interface SettingsEntry extends Choice {
  value?: string;
}

export function SettingsPanel(props: FeatureProps) {
  const [section, setSection] = createSignal<SectionName>(
    props.state()?.environmentId ? "environment" : "connections",
  );
  const [index, setIndex] = createSignal(0);
  const [auth, setAuth] = createSignal<ProviderAuthState | null>(null);
  const [install, setInstall] = createSignal<ProviderInstallState | null>(null);
  const [identity, setIdentity] = createSignal<string | null>(null);
  const [accountPrompt, setAccountPrompt] = createSignal("");
  const [pane, setPane] = createSignal<"list" | "detail">("list");
  const settings = () => props.state()?.config?.settings;
  const providers = () => props.state()?.config?.providers ?? [];
  const extras = createSettingsExtras(props, () => {
    const value = section();
    return value === "usage" || value === "maintenance" || value === "access" || value === "secrets"
      ? value
      : null;
  });
  const ExtraDetails = extras.Details;
  const terminal = createTerminalSettings(props);
  const TerminalDetails = terminal.Details;
  const chatGptProfiles = createChatGptProfileActions(props);
  const provider = createMemo(() => (section() === "providers" ? providers()[index()] : undefined));

  const environment = createMemo(() => props.state()?.environmentId);
  const providerId = createMemo(() => provider()?.instanceId);
  createEffect(() => {
    const environmentId = environment();
    const instanceId = providerId();
    setAuth(null);
    setInstall(null);
    if (!environmentId || !instanceId) return;
    let active = true;
    const report = (error: Error) => {
      if (active) props.ui.notify(error.message, true);
    };
    const stopAuth = subscribe(
      props.client,
      WS_METHODS.providerAuthSubscribe,
      { instanceId },
      (value) => {
        if (active && environment() === environmentId) setAuth(value);
      },
      report,
    );
    const stopInstall = subscribe(
      props.client,
      WS_METHODS.providerInstallSubscribe,
      { instanceId },
      (value) => {
        if (active && environment() === environmentId) setInstall(value);
      },
      report,
    );
    onCleanup(() => {
      active = false;
      stopAuth();
      stopInstall();
    });
  });

  async function refreshIdentity() {
    const value = await props.client.cloudIdentity();
    setIdentity(Option.isSome(value) ? value.value.accountId : null);
  }
  void refreshIdentity().catch(() => setIdentity(null));

  function update(patch: typeof ClientServerSettingsPatch.Type) {
    const guard = destinationGuard(props);
    void props.ui.run(async () => {
      guard();
      await request(props.client, WS_METHODS.serverUpdateSettings, { patch });
    }, "Settings saved.");
  }

  function chooseDefault(fallback = false) {
    const guard = destinationGuard(props);
    props.ui.choose(fallback ? "Fallback model" : "Default model", [
      {
        title: "Use automatic selection",
        run: () => {
          guard();
          update(fallback ? { fallbackModelSelection: null } : { defaultModelSelection: null });
        },
      },
      ...providers()
        .filter((entry) => entry.enabled && entry.installed)
        .flatMap((entry) =>
          entry.models.map((model) => ({
            title: model.name,
            category: entry.displayName ?? entry.driver,
            run: () => {
              guard();
              update(
                fallback
                  ? { fallbackModelSelection: { instanceId: entry.instanceId, model: model.slug } }
                  : { defaultModelSelection: { instanceId: entry.instanceId, model: model.slug } },
              );
            },
          })),
        ),
    ]);
  }

  function configureProvider(entry: ServerProvider, create = false) {
    const guard = destinationGuard(props);
    const definition = getProviderClient(entry.driver);
    const current = settings()?.providerInstances[entry.instanceId];
    const config = record(current?.config);
    const annotations = definition
      ? Schema.resolveAnnotations(definition.settingsSchema)?.providerSettingsFormSchema
      : undefined;
    const order = new Map((annotations?.order ?? []).map((key, position) => [key, position]));
    const configFields = Object.entries(definition?.settingsSchema.fields ?? {})
      .toSorted(([left], [right]) => (order.get(left) ?? 1000) - (order.get(right) ?? 1000))
      .flatMap(([key, schema]) => {
        const annotation =
          Schema.resolveAnnotationsKey(schema) ?? Schema.resolveAnnotations(schema);
        const form = annotation?.providerSettingsForm;
        if (form?.hidden) return [];
        const secret = isSecretSetting(schema);
        const defaultValue = Schema.decodeOption(schema as unknown as Schema.Decoder<unknown>)(
          undefined,
        );
        const value = config[key] ?? (Option.isSome(defaultValue) ? defaultValue.value : undefined);
        const field: Field = {
          name: `config:${key}`,
          label: typeof annotation?.title === "string" ? annotation.title : titleCase(key),
          type:
            secret || form?.control === "password"
              ? "secret"
              : form?.control === "switch"
                ? "toggle"
                : form?.control === "select"
                  ? "select"
                  : form?.control === "textarea"
                    ? "multiline"
                    : "text",
          value: secret
            ? ""
            : typeof value === "boolean"
              ? String(value)
              : typeof value === "string"
                ? value
                : "",
          ...(typeof annotation?.description === "string"
            ? { description: annotation.description }
            : {}),
          ...(secret ? { description: "Leave blank to preserve the saved credential." } : {}),
          ...(form?.options ? { options: [...form.options] } : {}),
        };
        return [{ key, field, secret, form }];
      });
    props.ui.form({
      title: create
        ? `Add ${entry.displayName ?? entry.driver}`
        : `Configure ${entry.displayName ?? entry.driver}`,
      fields: [
        ...(create
          ? [{ name: "id", label: "Instance ID", value: `${entry.driver}-custom`, required: true }]
          : []),
        {
          name: "name",
          label: "Display name",
          value: current?.displayName ?? entry.displayName ?? "",
        },
        {
          name: "enabled",
          label: "Enabled",
          type: "toggle",
          value: String(create ? false : entry.enabled),
        },
        ...configFields.map(({ field }) => field),
      ],
      submitLabel: create ? "Add provider" : "Save provider",
      onSubmit: async (values) => {
        guard();
        const nextConfig = { ...config };
        for (const { key, field, secret, form } of configFields) {
          const value = values[field.name] ?? "";
          if (secret && !value) continue;
          if (field.type === "toggle") nextConfig[key] = value === "true";
          else if (!value.trim() && form?.clearWhenEmpty !== "persist") delete nextConfig[key];
          else nextConfig[key] = value;
        }
        if (definition) providerDecoders.get(definition.driverKind)?.(nextConfig);
        const instance: ProviderInstanceConfig = {
          ...Object.fromEntries(
            Object.entries(current ?? {}).filter(([key]) => key !== "displayName"),
          ),
          driver: entry.driver,
          ...(values.name?.trim() ? { displayName: values.name.trim() } : {}),
          enabled: values.enabled === "true",
          config: nextConfig,
        };
        const instanceId = create
          ? ProviderInstanceId.make(values.id?.trim() ?? "")
          : entry.instanceId;
        await request(props.client, WS_METHODS.serverUpdateSettings, {
          patch: {},
          providerInstanceMutation: {
            operation: create ? "create" : "upsert",
            instanceId,
            instance,
          },
        });
        props.ui.notify(create ? "Provider added disabled." : "Provider saved.");
      },
    });
  }

  function addProvider() {
    props.ui.choose("Add provider", [
      {
        title: "Find an ACP Registry agent",
        description: "Search compatible agent distributions.",
        run: () => searchRegistry(props),
      },
      ...providerClients.definitions.map((definition) => ({
        title: definition.label,
        run: () => {
          const existing = providers().find((entry) => entry.driver === definition.driverKind);
          if (existing) configureProvider(existing, true);
          else {
            const guard = destinationGuard(props);
            props.ui.form({
              title: `Add ${definition.label}`,
              fields: [
                {
                  name: "id",
                  label: "Instance ID",
                  value: `${definition.driverKind}-custom`,
                  required: true,
                },
                { name: "name", label: "Name", value: definition.label },
              ],
              onSubmit: async (values) => {
                guard();
                await request(props.client, WS_METHODS.serverUpdateSettings, {
                  patch: {},
                  providerInstanceMutation: {
                    operation: "create",
                    instanceId: ProviderInstanceId.make(values.id?.trim() ?? ""),
                    instance: {
                      driver: definition.driverKind,
                      displayName: values.name?.trim() || definition.label,
                      enabled: false,
                    },
                  },
                });
                props.ui.notify("Provider added disabled. Select it to configure and enable it.");
              },
            });
          }
        },
      })),
    ]);
  }

  function authActions(entry: ServerProvider) {
    const guard = destinationGuard(props);
    const state = auth();
    const interaction = state?.interaction;
    const flowId = state?.flowId;
    const actions: Choice[] = [];
    const authorizationUrl =
      interaction?.type === "browser" || interaction?.type === "deviceCode"
        ? interaction.url
        : state?.authorizationUrl;
    if (authorizationUrl)
      actions.push({
        title: "Open sign-in page",
        description:
          interaction?.type === "deviceCode" ? `Code: ${interaction.userCode}` : undefined,
        run: () => props.ui.openBrowser?.(authorizationUrl),
      });
    if (state?.methods?.length)
      for (const method of state.methods)
        actions.push({
          title: `Sign in: ${method.name}`,
          description: method.description ?? undefined,
          run: () =>
            void props.ui.run(async () => {
              guard();
              setAuth(
                await request(props.client, WS_METHODS.providerAuthStart, {
                  instanceId: entry.instanceId,
                  methodId: method.id,
                  callbackMode: "server",
                }),
              );
            }),
        });
    else
      actions.push({
        title: "Start sign-in",
        run: () =>
          void props.ui.run(async () => {
            guard();
            setAuth(
              await request(props.client, WS_METHODS.providerAuthStart, {
                instanceId: entry.instanceId,
                callbackMode: "server",
              }),
            );
          }),
      });
    if (interaction && flowId) {
      if (interaction.type === "credentials")
        actions.unshift({
          title: "Enter credentials",
          run: () =>
            props.ui.form({
              title: "Provider credentials",
              fields: interaction.fields.map((field) => ({
                name: field.name,
                label: field.label,
                type: field.secret ? "secret" : "text",
                required: true,
              })),
              submitLabel: "Sign in",
              onSubmit: async (values) => {
                guard();
                setAuth(
                  await request(props.client, WS_METHODS.providerAuthRespond, {
                    instanceId: entry.instanceId,
                    flowId,
                    interactionId: interaction.id,
                    response: { type: "credentials", values },
                  }),
                );
              },
            }),
        });
      else if (interaction.type === "terminal")
        actions.unshift({
          title: "Send terminal input",
          run: () =>
            props.ui.form({
              title: "Sign-in terminal",
              description: "Enter the response requested by the sign-in output.",
              fields: [{ name: "data", label: "Response", type: "secret" }],
              submitLabel: "Send",
              onSubmit: async (values) => {
                guard();
                setAuth(
                  await request(props.client, WS_METHODS.providerAuthRespond, {
                    instanceId: entry.instanceId,
                    flowId,
                    interactionId: interaction.id,
                    response: { type: "terminal", data: `${values.data ?? ""}\r` },
                  }),
                );
              },
            }),
        });
      else if (interaction.type === "browser" && interaction.requiresConsent)
        actions.unshift({
          title: "Continue browser sign-in",
          run: () =>
            void props.ui.run(async () => {
              guard();
              setAuth(
                await request(props.client, WS_METHODS.providerAuthRespond, {
                  instanceId: entry.instanceId,
                  flowId,
                  interactionId: interaction.id,
                  response: { type: "browser", action: "accept" },
                }),
              );
            }),
        });
      if (interaction.type === "browser" && interaction.acceptsCallback)
        actions.push({
          title: "Paste callback URL",
          run: () =>
            props.ui.form({
              title: "Finish provider sign-in",
              fields: [{ name: "url", label: "Callback URL", required: true }],
              onSubmit: async (values) => {
                guard();
                setAuth(
                  await request(props.client, WS_METHODS.providerAuthComplete, {
                    instanceId: entry.instanceId,
                    flowId,
                    callbackUrl: values.url ?? "",
                  }),
                );
              },
            }),
        });
    }
    if (flowId && state && ["starting", "waiting", "verifying"].includes(state.phase))
      actions.push({
        title: "Cancel sign-in",
        run: () =>
          void props.ui.run(async () => {
            guard();
            setAuth(
              await request(props.client, WS_METHODS.providerAuthCancel, {
                instanceId: entry.instanceId,
                flowId,
              }),
            );
          }),
      });
    if (entry.auth.canLogout)
      actions.push({
        title: "Sign out of provider",
        run: () =>
          props.ui.confirm(
            "Sign out",
            `Sign out of ${entry.displayName ?? entry.driver}?`,
            async () => {
              guard();
              await request(props.client, WS_METHODS.providerAuthLogout, {
                instanceId: entry.instanceId,
              });
            },
            "Sign out",
          ),
      });
    if (!state || !["starting", "waiting", "verifying"].includes(state.phase))
      for (const method of state?.methods ?? [])
        if (method.canRemove)
          actions.push({
            title: `Remove saved account: ${method.name}`,
            description: method.accountEmail ?? method.description ?? undefined,
            run: () =>
              props.ui.confirm(
                "Remove saved account",
                `Remove ${method.name} from this provider's saved sign-in methods?`,
                async () => {
                  guard();
                  await request(props.client, WS_METHODS.providerAuthRemoveMethod, {
                    instanceId: entry.instanceId,
                    methodId: method.id,
                  });
                },
                "Remove account",
              ),
          });
    props.ui.choose(`${entry.displayName ?? entry.driver} sign-in`, actions);
  }

  function modelActions(entry: ServerProvider) {
    const guard = destinationGuard(props);
    props.ui.choose(
      "Models",
      entry.models.map((model) => ({
        title: model.name,
        description: model.slug,
        run: () => {
          const favorite =
            settings()?.favorites?.some(
              (item) => item.provider === entry.instanceId && item.model === model.slug,
            ) ?? false;
          const hidden =
            settings()?.providerModelPreferences?.[entry.instanceId]?.hiddenModels.includes(
              model.slug,
            ) ?? false;
          props.ui.choose(model.name, [
            {
              title: "Use as default",
              run: () => {
                guard();
                update({
                  defaultModelSelection: { instanceId: entry.instanceId, model: model.slug },
                });
              },
            },
            {
              title: "Use as fallback",
              run: () => {
                guard();
                update({
                  fallbackModelSelection: { instanceId: entry.instanceId, model: model.slug },
                });
              },
            },
            {
              title: favorite ? "Remove from favorites" : "Add to favorites",
              run: () => {
                guard();
                update({
                  setModelFavorites: [
                    { provider: entry.instanceId, model: model.slug, favorite: !favorite },
                  ],
                });
              },
            },
            {
              title: hidden ? "Show in model picker" : "Hide from model picker",
              run: () => {
                guard();
                update({
                  setModelsHidden: [
                    { provider: entry.instanceId, model: model.slug, hidden: !hidden },
                  ],
                });
              },
            },
          ]);
        },
      })),
    );
  }

  function providerEnvironment(entry: ServerProvider) {
    const guard = destinationGuard(props);
    const current = settings()?.providerInstances[entry.instanceId];
    const variables = current?.environment ?? [];
    async function save(environment: NonNullable<ProviderInstanceConfig["environment"]>) {
      guard();
      await request(props.client, WS_METHODS.serverUpdateSettings, {
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: entry.instanceId,
          instance: { ...current, driver: entry.driver, environment },
        },
      });
      props.ui.notify("Environment variables saved.");
    }
    function edit(index?: number) {
      const variable = index === undefined ? undefined : variables[index];
      props.ui.form({
        title: variable ? `Edit ${variable.name}` : "Add environment variable",
        fields: [
          { name: "name", label: "Name", value: variable?.name ?? "", required: true },
          {
            name: "value",
            label: "Value",
            type: "secret",
            value:
              variable && !variable.sensitive && typeof variable.value === "string"
                ? variable.value
                : "",
            description: variable?.sensitive
              ? "Leave blank to preserve the saved secret."
              : "Passed to the provider when starting a session.",
          },
          {
            name: "sensitive",
            label: "Store as a secret",
            type: "toggle",
            value: String(variable?.sensitive ?? true),
          },
        ],
        submitLabel: "Save variable",
        onSubmit: async (values) => {
          const name = values.name?.trim() ?? "";
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
            throw new Error("Use a valid environment variable name.");
          if (variables.some((item, at) => at !== index && item.name === name))
            throw new Error("A variable with that name already exists.");
          const value =
            variable?.sensitive && !values.value ? variable.value : (values.value ?? "");
          const updated = {
            name,
            value,
            sensitive: values.sensitive === "true",
            ...(variable?.valueRedacted && !values.value ? { valueRedacted: true } : {}),
          };
          const next = [...variables];
          if (index === undefined) next.push(updated);
          else next[index] = updated;
          await save(next);
        },
      });
    }
    props.ui.choose("Provider environment", [
      { title: "Add variable", run: () => edit() },
      ...variables.map((variable, index) => ({
        title: variable.name,
        description: variable.sensitive
          ? "Secret"
          : typeof variable.value === "string"
            ? variable.value
            : "Secret reference",
        run: () =>
          props.ui.choose(variable.name, [
            { title: "Edit variable", run: () => edit(index) },
            {
              title: "Remove variable",
              run: () =>
                props.ui.confirm(
                  "Remove variable",
                  `Remove ${variable.name} from this provider?`,
                  async () => {
                    await save(variables.filter((_, at) => at !== index));
                  },
                  "Remove",
                ),
            },
          ]),
      })),
    ]);
  }

  function customModels(entry: ServerProvider) {
    const guard = destinationGuard(props);
    const current = settings()?.providerInstances[entry.instanceId];
    const config = record(current?.config);
    const models = Array.isArray(config.customModels)
      ? config.customModels.filter(Schema.is(CustomModelSetting))
      : [];
    async function save(next: readonly CustomModelSetting[]) {
      guard();
      await request(props.client, WS_METHODS.serverUpdateSettings, {
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: entry.instanceId,
          instance: {
            ...current,
            driver: entry.driver,
            config: { ...config, customModels: next },
          },
        },
      });
      props.ui.notify("Custom models saved.");
    }
    function edit(index?: number) {
      const model = index === undefined ? undefined : models[index];
      props.ui.form({
        title: model ? "Edit custom model" : "Add custom model",
        fields: [
          {
            name: "slug",
            label: "Model ID",
            value: typeof model === "string" ? model : (model?.slug ?? ""),
            required: true,
          },
          {
            name: "name",
            label: "Display name (optional)",
            value: typeof model === "object" ? (model.name ?? "") : "",
          },
        ],
        submitLabel: "Save model",
        onSubmit: async (values) => {
          const slug = values.slug?.trim() ?? "";
          if (
            models.some(
              (item, at) => at !== index && (typeof item === "string" ? item : item.slug) === slug,
            )
          )
            throw new Error("That model ID already exists.");
          const next = [...models];
          const updated = {
            ...(typeof model === "object" && model.capabilities
              ? { capabilities: model.capabilities }
              : {}),
            slug,
            ...(values.name?.trim() ? { name: values.name.trim() } : {}),
          };
          if (index === undefined) next.push(updated);
          else next[index] = updated;
          await save(next);
        },
      });
    }
    props.ui.choose("Custom models", [
      { title: "Add model", run: () => edit() },
      ...models.map((model, index) => ({
        title: typeof model === "string" ? model : (model.name ?? model.slug),
        run: () =>
          props.ui.choose("Custom model", [
            { title: "Edit model", run: () => edit(index) },
            {
              title: "Remove model",
              run: () => void props.ui.run(() => save(models.filter((_, at) => at !== index))),
            },
          ]),
      })),
    ]);
  }

  function providerActions(entry: ServerProvider) {
    const guard = destinationGuard(props);
    const current = settings()?.providerInstances[entry.instanceId];
    const progress = install();
    props.ui.choose(entry.displayName ?? entry.driver, [
      { title: "Configure provider", run: () => configureProvider(entry) },
      {
        title: entry.enabled ? "Disable provider" : "Enable provider",
        run: () =>
          void props.ui.run(async () => {
            guard();
            await request(props.client, WS_METHODS.serverUpdateSettings, {
              patch: {},
              providerInstanceMutation: {
                operation: "upsert",
                instanceId: entry.instanceId,
                instance: {
                  ...Object.fromEntries(
                    Object.entries(current ?? {}).filter(([key]) => key !== "displayName"),
                  ),
                  driver: entry.driver,
                  enabled: !entry.enabled,
                },
              },
            });
          }, "Provider saved."),
      },
      { title: "Models and favorites", run: () => modelActions(entry) },
      ...(getProviderClient(entry.driver)?.settingsSchema.fields.customModels
        ? [{ title: "Custom models", run: () => customModels(entry) }]
        : []),
      { title: "Environment variables", run: () => providerEnvironment(entry) },
      ...(entry.driver === "codex"
        ? [{ title: "ChatGPT profile connections", run: () => chatGptProfiles.open(entry, auth()) }]
        : []),
      ...(entry.nativeSessions?.canList ||
      entry.configurableProviders ||
      entry.auth.action ||
      entry.driver === "acpRegistry"
        ? [
            {
              title: "Provider sessions and endpoints",
              run: () => registryProviderActions(props, entry),
            },
          ]
        : []),
      ...(entry.setup?.canAuthenticate
        ? [{ title: "Sign-in options", run: () => authActions(entry) }]
        : []),
      ...(entry.setup?.canInstall
        ? [
            {
              title: entry.installed ? "Update provider" : "Install provider",
              run: () =>
                void props.ui.run(async () => {
                  guard();
                  setInstall(
                    await request(props.client, WS_METHODS.providerInstallStart, {
                      instanceId: entry.instanceId,
                    }),
                  );
                }),
            },
          ]
        : []),
      ...(progress?.operationId &&
      ["downloading", "extracting", "verifying"].includes(progress.phase)
        ? [
            {
              title: "Cancel installation",
              run: () =>
                void props.ui.run(async () => {
                  guard();
                  await request(props.client, WS_METHODS.providerInstallCancel, {
                    instanceId: entry.instanceId,
                    operationId: progress.operationId!,
                  });
                }),
            },
          ]
        : []),
      ...(progress?.canRemove
        ? [
            {
              title: "Remove managed installation",
              run: () =>
                props.ui.confirm(
                  "Remove installation",
                  `Remove the managed ${entry.displayName ?? entry.driver} installation?`,
                  async () => {
                    guard();
                    await request(props.client, WS_METHODS.providerInstallRemove, {
                      instanceId: entry.instanceId,
                    });
                  },
                  "Remove",
                ),
            },
          ]
        : []),
      ...(current
        ? [
            {
              title: "Remove provider settings",
              run: () =>
                props.ui.confirm(
                  "Remove provider settings",
                  "Remove this instance's saved configuration? Existing threads retain their model selections.",
                  async () => {
                    guard();
                    await request(props.client, WS_METHODS.serverUpdateSettings, {
                      patch: {},
                      providerInstanceMutation: {
                        operation: "remove",
                        instanceId: entry.instanceId,
                      },
                    });
                  },
                  "Remove",
                ),
            },
          ]
        : []),
    ]);
  }

  function connectSsh() {
    props.ui.form({
      title: "Connect over SSH",
      fields: [
        { name: "host", label: "Hostname or SSH alias", required: true },
        { name: "username", label: "Username (optional)" },
        { name: "port", label: "Port (optional)", type: "number" },
        { name: "name", label: "Display name (optional)" },
      ],
      submitLabel: "Connect",
      onSubmit: async (values) => {
        const port = values.port?.trim() ? Number(values.port) : null;
        if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))
          throw new Error("Port must be between 1 and 65535.");
        const host = values.host?.trim() ?? "";
        const target = decodeSshTarget({
          alias: host,
          hostname: host,
          username: values.username?.trim() || null,
          port,
        });
        if (!(await props.ui.beforeNavigate())) return;
        await props.client.addSsh(target, values.name?.trim() || undefined);
      },
    });
  }

  const entries = createMemo<SettingsEntry[]>(() => {
    if (["usage", "maintenance", "access", "secrets"].includes(section())) return extras.entries();
    if (section() === "terminal") return terminal.entries();
    const value = settings();
    if (section() === "connections")
      return [
        {
          title: "Current environment",
          value: props.state()?.label ?? "Disconnected",
          description: props.state()?.connection,
          run: () => void props.ui.run(() => props.client.reconnect(), "Reconnecting…"),
        },
        {
          title: "Switch environment",
          description: "Saved connections and machines discovered through your account.",
          run: () =>
            void props.ui.run(async () => {
              const entries = await props.client.environments();
              props.ui.choose(
                "Environments",
                entries.map((entry) => ({
                  title: entry.label,
                  description: entry.environmentId,
                  run: () =>
                    void props.ui.run(async () => {
                      if (await props.ui.beforeNavigate())
                        await props.client.selectEnvironment(entry.environmentId);
                    }),
                })),
              );
            }),
        },
        {
          title: "Pair another environment",
          description: "Paste a pairing URL from the target T3 server.",
          run: () =>
            props.ui.form({
              title: "Pair environment",
              fields: [{ name: "url", label: "Pairing URL", required: true, type: "secret" }],
              submitLabel: "Pair",
              onSubmit: async (values) => {
                if (await props.ui.beforeNavigate())
                  await props.client.connect(values.url?.trim() ?? "");
              },
            }),
        },
        {
          title: "Connect over SSH",
          description: "Use your existing SSH config, keys, or a password prompt.",
          run: connectSsh,
        },
        ...(props.state()?.config?.environment.capabilities.peerLinks &&
        settings()?.linkedEnvironmentsEnabled
          ? [
              {
                title: "Linked environments",
                description: "Link, inspect, or unlink servers your agents can work on.",
                run: () => linkedEnvironmentActions(props),
              },
            ]
          : []),
        {
          title: "Source-control connections",
          description: "Forge accounts, saved host tokens, and browser sign-in.",
          run: () => sourceControlActions(props),
        },
        {
          title: "Issue tracker connections",
          description: "Connect standalone trackers and select each project's team or project.",
          run: () => issueTrackerActions(props),
        },
        {
          title: identity() ? "Sign out of T3 Connect" : "Sign in to T3 Connect",
          value: identity() ?? "Signed out",
          description:
            "Discover your environments. Relay transport depends on the server's account authentication support.",
          run: () =>
            identity()
              ? props.ui.confirm(
                  "Sign out of T3 Connect",
                  "Remove this terminal's account session and discovered relay connections?",
                  async () => {
                    if (!(await props.ui.beforeNavigate())) return;
                    await props.client.logout();
                    setIdentity(null);
                  },
                  "Sign out",
                )
              : void props.ui.run(async () => {
                  await props.client.login((prompt) => {
                    setAccountPrompt(
                      `${prompt.verificationUriComplete ?? prompt.verificationUri}\n\nCode: ${prompt.userCode}`,
                    );
                    setPane("detail");
                    props.ui.notify("Open the sign-in URL shown in Connections.");
                  });
                  await refreshIdentity();
                  setAccountPrompt("");
                }, "Signed in to T3 Connect."),
        },
      ];
    if (section() === "providers")
      return providers().map((entry) => ({
        title: entry.displayName ?? entry.driver,
        value: entry.enabled ? entry.status : "Disabled",
        description: `${entry.installed ? (entry.version ?? "Installed") : "Not installed"} · ${entry.auth.email ?? entry.auth.status}`,
        run: () => providerActions(entry),
      }));
    if (!value) return [];
    const toggles: {
      key:
        | "promptSuggestionsEnabled"
        | "reviewGuidesEnabled"
        | "snoozeLimitedThreads"
        | "autoResumeLimitedThreads"
        | "linkedEnvironmentsEnabled"
        | "guestSharingEnabled";
      title: string;
      description: string;
    }[] = [
      {
        key: "promptSuggestionsEnabled",
        title: "Prompt suggestions",
        description: "Suggest a next prompt after a completed turn.",
      },
      {
        key: "reviewGuidesEnabled",
        title: "Review guides",
        description: "Generate guides for reviewing pull requests.",
      },
      {
        key: "snoozeLimitedThreads",
        title: "Snooze limited threads",
        description: "Snooze threads when a provider's usage limit is reached.",
      },
      {
        key: "autoResumeLimitedThreads",
        title: "Resume limited threads",
        description: "Resume when the provider's usage limit resets.",
      },
      {
        key: "linkedEnvironmentsEnabled",
        title: "Linked environments",
        description: "Allow calls and tasks between your environments.",
      },
      {
        key: "guestSharingEnabled",
        title: "Guest sharing",
        description: "Allow creating guest links to threads on this environment.",
      },
    ];
    return [
      {
        title: "Default model",
        value: value.defaultModelSelection?.model ?? "Automatic",
        run: () => chooseDefault(),
      },
      {
        title: "Web and desktop keybindings",
        description: "Inspect, add, edit, or remove the environment's shortcuts.",
        run: () => keybindingActions(props),
      },
      {
        title: "Fallback model",
        value: value.fallbackModelSelection?.model ?? "Automatic",
        run: () => chooseDefault(true),
      },
      {
        title: "Default permissions",
        value: value.defaultRuntimeMode,
        run: () => {
          const guard = destinationGuard(props);
          props.ui.choose(
            "Default permissions",
            (["approval-required", "auto-accept-edits", "auto", "full-access"] as const).map(
              (mode) => ({
                title: mode,
                run: () => {
                  guard();
                  update({ defaultRuntimeMode: mode });
                },
              }),
            ),
          );
        },
      },
      ...toggles.map(({ key, title, description }) => ({
        title,
        description,
        value: value[key] ? "On" : "Off",
        run: () => update({ [key]: !value[key] }),
      })),
      ...environmentSettingsActions(props),
      {
        title: "Settle inactive threads after",
        value:
          value.sidebarAutoSettleAfterDays === null
            ? "Never"
            : `${value.sidebarAutoSettleAfterDays} days`,
        run: () => {
          const guard = destinationGuard(props);
          props.ui.form({
            title: "Settle inactive threads",
            fields: [
              {
                name: "days",
                label: "Days (blank disables)",
                type: "number",
                value:
                  value.sidebarAutoSettleAfterDays === null
                    ? ""
                    : String(value.sidebarAutoSettleAfterDays),
              },
            ],
            onSubmit: async (values) => {
              guard();
              const days = values.days?.trim() ? Number(values.days) : null;
              if (days !== null && (!Number.isFinite(days) || days < 1 || days > 90))
                throw new Error("Enter 1 to 90 days, or leave blank to disable.");
              await request(props.client, WS_METHODS.serverUpdateSettings, {
                patch: { sidebarAutoSettleAfterDays: days },
              });
            },
          });
        },
      },
    ];
  });

  function switchSection(value: SectionName) {
    setSection(value);
    setIndex(0);
    setPane("list");
  }
  useKeyboard((event) => {
    if (!props.focused || props.ui.modal() || event.ctrl || event.meta) return;
    if (event.name === "1") switchSection("environment");
    else if (event.name === "2") switchSection("providers");
    else if (event.name === "3") switchSection("connections");
    else if (event.name === "4") switchSection("usage");
    else if (event.name === "5") switchSection("maintenance");
    else if (event.name === "6") switchSection("access");
    else if (event.name === "7") switchSection("secrets");
    else if (event.name === "8") switchSection("terminal");
    else if (event.name === "n" && section() === "providers") addProvider();
    else if (event.name === "a" && provider()) authActions(provider()!);
    else if (event.name === "right") setPane("detail");
    else if (event.name === "left") setPane("list");
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  return (
    <box flexGrow={1} flexDirection="column" minHeight={0} onMouseDown={props.onFocus}>
      <box padding={1} flexDirection="row" gap={3}>
        <For
          each={
            [
              ["environment", "Environment [1]"],
              ["providers", "Providers [2]"],
              ["connections", "Connections [3]"],
            ] as const
          }
        >
          {([name, label]) => (
            <text
              fg={section() === name ? theme.primary : theme.textMuted}
              onMouseDown={() => switchSection(name)}
            >
              {label}
            </text>
          )}
        </For>
        <Show when={section() === "providers"}>
          <Action label="Add [n]" onPress={addProvider} />
        </Show>
      </box>
      <box paddingX={1} paddingBottom={1} flexDirection="row" gap={2}>
        <For
          each={
            [
              ["usage", "Usage [4]"],
              ["maintenance", "Maintenance [5]"],
              ["access", "Access [6]"],
              ["secrets", "Secrets [7]"],
              ["terminal", "Terminal [8]"],
            ] as const
          }
        >
          {([name, label]) => (
            <text
              fg={section() === name ? theme.primary : theme.textMuted}
              onMouseDown={() => switchSection(name)}
            >
              {label}
            </text>
          )}
        </For>
      </box>
      <box flexGrow={1} flexDirection="row" minHeight={0}>
        <select
          width="46%"
          flexGrow={1}
          flexShrink={0}
          options={entries().map((entry) => ({
            name: `${entry.title}${entry.value ? `  ${entry.value}` : ""}`,
            description: entry.description ?? "",
          }))}
          selectedIndex={index()}
          onChange={(value) => setIndex(value)}
          onSelect={(value) => entries()[value]?.run()}
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
          flexGrow={1}
          minWidth={0}
          paddingX={2}
          focused={props.focused && !props.ui.modal() && pane() === "detail"}
          onMouseDown={() => setPane("detail")}
        >
          <ExtraDetails />
          <Show when={section() === "terminal"}>
            <TerminalDetails />
          </Show>
          <Show when={section() === "environment"}>
            <Section title={props.state()?.label ?? "Environment"}>
              <text fg={theme.textMuted} wrapMode="word">
                {props.state()?.config?.cwd ?? "Connect to an environment to edit its settings."}
              </text>
              <text fg={theme.textMuted}>Connection: {props.state()?.connection}</text>
              <Show when={props.state()?.config?.managedPolicy}>
                <text fg={theme.warning} wrapMode="word">
                  Some settings are managed by the environment administrator.
                </text>
              </Show>
            </Section>
            <Section title={entries()[index()]?.title ?? "Settings"}>
              <text fg={theme.text} wrapMode="word">
                {entries()[index()]?.description ??
                  "These defaults belong to the selected environment and apply to its clients."}
              </text>
              <Action label="Change [enter]" onPress={() => entries()[index()]?.run()} />
            </Section>
          </Show>
          <Show when={provider()}>
            {(entry) => (
              <>
                <Section title={entry().displayName ?? entry().driver}>
                  <text fg={entry().status === "ready" ? theme.success : theme.textMuted}>
                    {entry().status} ·{" "}
                    {entry().installed ? (entry().version ?? "Installed") : "Not installed"}
                  </text>
                  <text fg={theme.textMuted}>
                    Account: {entry().auth.email ?? entry().auth.label ?? entry().auth.status}
                  </text>
                  <Show when={entry().message}>
                    <text fg={theme.warning} wrapMode="word">
                      {entry().message}
                    </text>
                  </Show>
                  <Show when={entry().unavailableReason}>
                    <text fg={theme.warning} wrapMode="word">
                      {entry().unavailableReason}
                    </text>
                  </Show>
                  <Action
                    label="Provider actions [enter]"
                    onPress={() => providerActions(entry())}
                  />
                </Section>
                <Show when={auth()}>
                  {(state) => (
                    <Section title={`Sign-in: ${state().phase}`}>
                      <text fg={theme.textMuted} wrapMode="word">
                        {state().message}
                      </text>
                      <Show when={state().authorizationUrl}>
                        <text fg={theme.primary} wrapMode="word">
                          {state().authorizationUrl}
                        </text>
                      </Show>
                      <Show when={state().interaction}>
                        {(interaction) => (
                          <>
                            <Show
                              when={
                                interaction().type === "deviceCode" ||
                                interaction().type === "browser"
                              }
                            >
                              <text fg={theme.primary} wrapMode="word">
                                {"url" in interaction()
                                  ? (interaction() as { url: string }).url
                                  : ""}
                              </text>
                            </Show>
                            <Show when={interaction().type === "deviceCode"}>
                              <text fg={theme.text}>
                                Code:{" "}
                                {"userCode" in interaction()
                                  ? (interaction() as { userCode: string }).userCode
                                  : ""}
                              </text>
                            </Show>
                            <Show when={interaction().type === "terminal"}>
                              <text fg={theme.text} wrapMode="word">
                                {"output" in interaction()
                                  ? (interaction() as { output: string }).output
                                  : ""}
                              </text>
                            </Show>
                          </>
                        )}
                      </Show>
                      <Action label="Sign-in options [a]" onPress={() => authActions(entry())} />
                    </Section>
                  )}
                </Show>
                <Show when={install() && install()?.phase !== "idle"}>
                  <Section title={`Installation: ${install()?.phase}`}>
                    <text fg={theme.textMuted} wrapMode="word">
                      {install()?.message}
                    </text>
                    <Show when={install()?.totalBytes}>
                      <text fg={theme.textMuted}>
                        {install()?.downloadedBytes} / {install()?.totalBytes} bytes
                      </text>
                    </Show>
                  </Section>
                </Show>
                <Section title={`${entry().models.length} models`}>
                  <For each={entry().models}>
                    {(model) => (
                      <text fg={theme.textMuted}>
                        {model.name}
                        {model.isDefault ? " (default)" : ""}
                      </text>
                    )}
                  </For>
                  <Action label="Manage models" onPress={() => modelActions(entry())} />
                </Section>
              </>
            )}
          </Show>
          <Show when={section() === "connections"}>
            <Section title="Connections">
              <text fg={theme.textMuted} wrapMode="word">
                Pair with a T3 environment or use SSH. Projects, providers and files belong to the
                selected machine.
              </text>
              <Show when={props.state()?.error}>
                <text fg={theme.error} wrapMode="word">
                  {props.state()?.error}
                </text>
              </Show>
            </Section>
            <Show when={accountPrompt()}>
              <Section title="Sign in to T3 Connect">
                <text fg={theme.primary} wrapMode="word">
                  {accountPrompt()}
                </text>
              </Section>
            </Show>
            <Section title={entries()[index()]?.title ?? "Connections"}>
              <text fg={theme.text} wrapMode="word">
                {entries()[index()]?.description}
              </text>
              <Action label="Open [enter]" onPress={() => entries()[index()]?.run()} />
            </Section>
          </Show>
        </scrollbox>
      </box>
      <text fg={theme.textMuted} paddingX={1}>
        ↑↓ select · enter change · → details · ← list · 1–8 sections
      </text>
    </box>
  );
}
