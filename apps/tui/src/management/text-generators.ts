import { ProviderInstanceId, TextGeneratorConfig, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { request } from "../rpc/request.ts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { destinationGuard } from "./common.tsx";

const decodeTextGenerator = Schema.decodeSync(TextGeneratorConfig);

export function textGeneratorActions(props: FeatureProps) {
  const guard = destinationGuard(props);
  const settings = props.state()?.config?.settings;
  if (!settings) return;
  const save = async (id: ProviderInstanceId, config: TextGeneratorConfig | null) => {
    guard();
    await request(props.client, WS_METHODS.serverUpdateSettings, {
      patch: { textGenerators: { [id]: config } },
    });
    props.ui.notify(config ? "Text-generation API saved." : "Text-generation API removed.");
  };
  function edit(id?: ProviderInstanceId) {
    const current = id ? settings!.textGenerators[id] : undefined;
    props.ui.form({
      title: id ? "Edit text-generation API" : "Add text-generation API",
      description:
        "Used for titles, branch names, writing and review guides; not an agent runtime.",
      fields: [
        ...(!id ? [{ name: "id", label: "ID", required: true }] : []),
        { name: "name", label: "Display name", value: current?.label ?? "" },
        {
          name: "kind",
          label: "API type",
          type: "select",
          value: current?.kind ?? "openaiCompatible",
          options: [
            { label: "OpenAI compatible", value: "openaiCompatible" },
            { label: "Anthropic", value: "anthropic" },
          ],
        },
        { name: "url", label: "Base URL", value: current?.baseUrl ?? "", required: true },
        {
          name: "key",
          label: "API key",
          type: "secret",
          description: "Leave blank to preserve the saved key.",
        },
        {
          name: "enabled",
          label: "Enabled",
          type: "toggle",
          value: String(current?.enabled ?? true),
        },
      ],
      onSubmit: async (fields) => {
        guard();
        const nextId = id ?? ProviderInstanceId.make(fields.id?.trim() ?? "");
        if (!id && (settings!.textGenerators[nextId] || settings!.providerInstances[nextId]))
          throw new Error("This ID is already used by a provider or text-generation API.");
        const next = decodeTextGenerator({
          kind: fields.kind === "anthropic" ? "anthropic" : "openaiCompatible",
          ...(fields.name?.trim() ? { label: fields.name.trim() } : {}),
          baseUrl: fields.url?.trim() ?? "",
          apiKey: fields.key?.trim() || current?.apiKey || "",
          enabled: fields.enabled === "true",
        });
        await save(nextId, next);
      },
    });
  }
  async function models(id: ProviderInstanceId, refresh = false) {
    guard();
    const result = await request(props.client, WS_METHODS.serverListTextGeneratorModels, {
      id,
      refresh,
    });
    guard();
    props.ui.choose("Text-generation models", [
      { title: "Refresh model list", run: () => void props.ui.run(() => models(id, true)) },
      ...result.models.map((model) => ({
        title: model.name,
        description: model.id,
        run: () =>
          props.ui.choose(model.name, [
            ...(
              [
                ["Use for titles and branch names", "textGenerationModelSelection"],
                ["Use for source-control writing", "sourceControlWriterModelSelection"],
                ["Use for review guides", "reviewGuideModelSelection"],
                ["Use for dictation cleanup", "speechPostProcessingModelSelection"],
              ] as const
            ).map(([title, key]) => ({
              title,
              run: () =>
                void props.ui.run(async () => {
                  guard();
                  await request(props.client, WS_METHODS.serverUpdateSettings, {
                    patch: { [key]: { instanceId: id, model: model.id } },
                  });
                }, "Generation model saved."),
            })),
            {
              title: "Test this model",
              description: "Sends a short prompt through the configured API.",
              run: () =>
                props.ui.confirm(
                  "Test generation model",
                  `Send a short prompt to ${model.name} using this API?`,
                  async () => {
                    guard();
                    const tested = await request(
                      props.client,
                      WS_METHODS.serverListTextGeneratorModels,
                      { id, test: true, model: model.id },
                    );
                    guard();
                    props.ui.notify(`${tested.testedModel ?? model.id} answered the test prompt.`);
                  },
                  "Test model",
                ),
            },
          ]),
      })),
    ]);
  }
  const choices: Choice[] = [{ title: "Add text-generation API", run: () => edit() }];
  for (const [key, generator] of Object.entries(settings.textGenerators)) {
    const id = ProviderInstanceId.make(key);
    choices.push({
      title: generator.label ?? id,
      description: `${generator.enabled ? "Enabled" : "Disabled"} · ${generator.baseUrl}`,
      run: () =>
        props.ui.choose(generator.label ?? id, [
          { title: "Edit API connection", run: () => edit(id) },
          { title: "Choose models", run: () => void props.ui.run(() => models(id)) },
          {
            title: generator.enabled ? "Disable API" : "Enable API",
            run: () =>
              void props.ui.run(() => save(id, { ...generator, enabled: !generator.enabled })),
          },
          {
            title: "Remove API",
            run: () =>
              props.ui.confirm(
                "Remove text-generation API",
                "Remove this connection and its saved key? Update model selections that use it before generating more text.",
                () => save(id, null),
                "Remove API",
              ),
          },
        ]),
    });
  }
  props.ui.choose("Text-generation APIs", choices);
}
