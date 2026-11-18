import { WS_METHODS, type UsageModelPriceOverride } from "@t3tools/contracts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { destinationGuard } from "./common.tsx";

export function usageSettingsActions(props: FeatureProps): Choice[] {
  const settings = props.state()?.config?.settings;
  const guard = destinationGuard(props);
  function prices(model?: string) {
    const current = model ? settings?.usagePriceOverrides[model] : undefined;
    props.ui.form({
      title: model ? `Price for ${model}` : "Add model price",
      description: "USD per million tokens. Blank cache rates use the input rate.",
      fields: [
        { name: "model", label: "Model ID", value: model ?? "", required: true },
        {
          name: "input",
          label: "Input price",
          type: "number",
          value: String(current?.inputCostPerMillionTokens ?? ""),
          required: true,
        },
        {
          name: "output",
          label: "Output price",
          type: "number",
          value: String(current?.outputCostPerMillionTokens ?? ""),
          required: true,
        },
        {
          name: "cacheRead",
          label: "Cache read price",
          type: "number",
          value: String(current?.cacheReadCostPerMillionTokens ?? ""),
        },
        {
          name: "cacheWrite",
          label: "Cache write price",
          type: "number",
          value: String(current?.cacheWriteCostPerMillionTokens ?? ""),
        },
      ],
      submitLabel: "Save price",
      onSubmit: async (values) => {
        guard();
        const price = (name: string) => {
          const value = Number(values[name]);
          if (!Number.isFinite(value) || value < 0)
            throw new Error("Prices must be finite non-negative numbers.");
          return value;
        };
        const next: UsageModelPriceOverride = {
          inputCostPerMillionTokens: price("input"),
          outputCostPerMillionTokens: price("output"),
          ...(values.cacheRead?.trim()
            ? { cacheReadCostPerMillionTokens: price("cacheRead") }
            : {}),
          ...(values.cacheWrite?.trim()
            ? { cacheWriteCostPerMillionTokens: price("cacheWrite") }
            : {}),
        };
        const target = values.model?.trim() ?? "";
        await request(props.client, WS_METHODS.serverUpdateSettings, {
          patch: {
            usagePriceOverrides: {
              ...(model && model !== target ? { [model]: null } : {}),
              [target]: next,
            },
          },
        });
        props.ui.notify("Model price saved. Refresh usage to apply it.");
      },
    });
  }
  function aliases(model?: string) {
    props.ui.form({
      title: model ? "Edit model alias" : "Add model alias",
      fields: [
        { name: "model", label: "Reported model ID", value: model ?? "", required: true },
        {
          name: "alias",
          label: "Price model ID",
          value: model ? (settings?.usageModelAliases[model] ?? "") : "",
          required: true,
        },
      ],
      submitLabel: "Save alias",
      onSubmit: async (values) => {
        guard();
        const target = values.model?.trim() ?? "";
        await request(props.client, WS_METHODS.serverUpdateSettings, {
          patch: {
            usageModelAliases: {
              ...(model && model !== target ? { [model]: null } : {}),
              [target]: values.alias?.trim() ?? "",
            },
          },
        });
        props.ui.notify("Model alias saved.");
      },
    });
  }
  return [
    {
      title: "Usage history retention",
      description:
        settings?.usageHistoryRetentionDays === "unlimited"
          ? "Unlimited"
          : `${settings?.usageHistoryRetentionDays ?? 92} days`,
      run: () =>
        props.ui.form({
          title: "Usage history retention",
          fields: [
            {
              name: "days",
              label: "Days (blank for unlimited)",
              type: "number",
              value:
                settings?.usageHistoryRetentionDays === "unlimited"
                  ? ""
                  : String(settings?.usageHistoryRetentionDays ?? 92),
            },
          ],
          submitLabel: "Save retention",
          onSubmit: async (values) => {
            guard();
            const days = values.days?.trim() ? Number(values.days) : "unlimited";
            if (days !== "unlimited" && (!Number.isSafeInteger(days) || days < 1))
              throw new Error("Enter a positive number of days, or leave blank for unlimited.");
            await request(props.client, WS_METHODS.serverUpdateSettings, {
              patch: { usageHistoryRetentionDays: days },
            });
            props.ui.notify("Usage retention saved.");
          },
        }),
    },
    {
      title: "Custom model prices",
      run: () =>
        props.ui.choose("Model prices", [
          { title: "Add model price", run: () => prices() },
          ...Object.entries(settings?.usagePriceOverrides ?? {}).map(([model, value]) => ({
            title: model,
            description: `$${value.inputCostPerMillionTokens} input / $${value.outputCostPerMillionTokens} output per million tokens`,
            run: () =>
              props.ui.choose(model, [
                { title: "Edit price", run: () => prices(model) },
                {
                  title: "Remove price",
                  run: () =>
                    void props.ui.run(async () => {
                      guard();
                      await request(props.client, WS_METHODS.serverUpdateSettings, {
                        patch: { usagePriceOverrides: { [model]: null } },
                      });
                    }, "Custom price removed."),
                },
              ]),
          })),
        ]),
    },
    {
      title: "Model pricing aliases",
      run: () =>
        props.ui.choose("Model aliases", [
          { title: "Add alias", run: () => aliases() },
          ...Object.entries(settings?.usageModelAliases ?? {}).map(([model, alias]) => ({
            title: model,
            description: alias,
            run: () =>
              props.ui.choose(model, [
                { title: "Edit alias", run: () => aliases(model) },
                {
                  title: "Remove alias",
                  run: () =>
                    void props.ui.run(async () => {
                      guard();
                      await request(props.client, WS_METHODS.serverUpdateSettings, {
                        patch: { usageModelAliases: { [model]: null } },
                      });
                    }, "Alias removed."),
                },
              ]),
          })),
        ]),
    },
  ];
}
