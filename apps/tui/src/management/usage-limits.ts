import {
  UsageLimitSourceId,
  WS_METHODS,
  type ProviderConsumeResetCreditInput,
  type ServerProviderUsageLimits,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { destinationGuard } from "./common.tsx";

const outcomes = {
  reset: "Usage allowance reset.",
  nothingToReset: "No usage allowance needs resetting.",
  noCredit: "No reset credit is available.",
  alreadyRedeemed: "That reset credit was already used.",
} as const;

export function usageLimitActions(props: FeatureProps) {
  const guard = destinationGuard(props);
  const settings = props.state()?.config?.settings;
  if (!settings) return;
  const save = async (id: UsageLimitSourceId, source: UsageLimitSourceConfig | null) => {
    guard();
    await request(props.client, WS_METHODS.serverUpdateSettings, {
      patch: { usageLimitSources: { [id]: source } },
    });
    props.ui.notify(source ? "Usage-limit source saved." : "Usage-limit source removed.");
  };
  function edit(id?: UsageLimitSourceId) {
    const source = id ? settings!.usageLimitSources[id] : undefined;
    props.ui.form({
      title: source ? "Edit CLIProxyAPI hub" : "Add CLIProxyAPI hub",
      description:
        "Quota is read on the selected environment. The management key stays in its secret store.",
      fields: [
        ...(!id ? [{ name: "id", label: "Source ID", value: "cliproxy-hub", required: true }] : []),
        { name: "label", label: "Display name", value: source?.label ?? "" },
        { name: "url", label: "Hub URL", value: source?.url ?? "", required: true },
        {
          name: "key",
          label: "Management key",
          type: "secret",
          description: "Leave blank to preserve the saved key.",
          required: !source,
        },
        {
          name: "enabled",
          label: "Enabled",
          type: "toggle",
          value: String(source?.enabled ?? true),
        },
      ],
      onSubmit: async (fields) => {
        guard();
        const nextId = id ?? UsageLimitSourceId.make(fields.id?.trim() ?? "");
        if (!nextId) throw new Error("Enter a source ID.");
        if (!id && settings!.usageLimitSources[nextId])
          throw new Error("That source ID already exists.");
        const url = new URL(fields.url?.trim() ?? "");
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
          throw new Error("Use an HTTP(S) hub URL without credentials in the address.");
        await save(nextId, {
          kind: "cliproxy",
          ...(fields.label?.trim() ? { label: fields.label.trim() } : {}),
          url: url.href.replace(/\/$/, ""),
          managementKey: fields.key?.trim() || source?.managementKey || "",
          enabled: fields.enabled === "true",
        });
      },
    });
  }
  function account(
    label: string,
    limits: ServerProviderUsageLimits,
    input: (creditId?: string) => ProviderConsumeResetCreditInput | null,
  ) {
    const credits = limits.resetCredits;
    const choices: Choice[] = [
      {
        title: "Read usage windows",
        run: () =>
          props.ui.text(
            label,
            [
              limits.unavailable
                ? `Unavailable: ${limits.unavailable.message ?? limits.unavailable.reason}`
                : "",
              limits.zeroSpendCap ? "Monthly spend cap is zero." : "",
              ...limits.windows.map(
                (window) =>
                  `${window.label}: ${window.usedPercent.toFixed(1)}% used${window.resetsAt ? ` · Resets ${window.resetsAt}` : ""}`,
              ),
              credits
                ? `${credits.availableCount} reset credits${credits.nextExpiresAt ? ` · Next expires ${credits.nextExpiresAt}` : ""}`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          ),
      },
    ];
    if (limits.externalUsage && props.ui.openBrowser)
      choices.push({
        title: limits.externalUsage.label,
        run: () => props.ui.openBrowser?.(limits.externalUsage!.url),
      });
    const options = credits?.options?.filter((credit) => credit.availableCount > 0) ?? [];
    if (credits && credits.availableCount > 0) {
      const list = options.length
        ? options.map((credit) => ({
            id: credit.creditId,
            label: credit.label,
            description: credit.description,
          }))
        : [
            {
              id: credits.nextCreditId,
              label: "Use a reset credit",
              description: "Refill this account's available usage allowance.",
            },
          ];
      for (const credit of list) {
        const payload = input(credit.id);
        if (!payload) continue;
        choices.push({
          title: credit.label,
          description: credit.description,
          run: () =>
            props.ui.confirm(
              "Use reset credit",
              `${credit.description}\n\nSpend one of ${label}'s reset credits?`,
              async () => {
                guard();
                const result = await request(
                  props.client,
                  WS_METHODS.providerConsumeResetCredit,
                  payload,
                );
                guard();
                props.ui.notify(
                  [outcomes[result.outcome], result.warning].filter(Boolean).join(" "),
                  result.outcome === "noCredit",
                );
              },
              "Use credit",
            ),
        });
      }
    }
    props.ui.choose(label, choices);
  }
  const choices: Choice[] = [{ title: "Add quota hub", run: () => edit() }];
  for (const [key, source] of Object.entries(settings.usageLimitSources)) {
    const id = UsageLimitSourceId.make(key);
    const snapshot = props.state()?.config?.usageLimitSources?.find((value) => value.id === id);
    choices.push({
      title: source.label ?? source.url,
      description:
        snapshot?.error ??
        `${source.enabled ? "Enabled" : "Disabled"}${snapshot ? ` · ${snapshot.accounts.length} pooled accounts` : " · Waiting for quota data"}`,
      run: () =>
        props.ui.choose(source.label ?? source.url, [
          { title: "Edit hub", run: () => edit(id) },
          {
            title: source.enabled ? "Disable hub" : "Enable hub",
            run: () => void props.ui.run(() => save(id, { ...source, enabled: !source.enabled })),
          },
          ...(snapshot?.accounts.map((value) => ({
            title: value.email ?? value.id,
            description: `${value.driver}${value.plan ? ` · ${value.plan}` : ""}`,
            run: () =>
              account(value.email ?? value.id, value.usageLimits, (creditId) =>
                creditId ? { sourceId: id, accountId: value.id, creditId } : null,
              ),
          })) ?? []),
          {
            title: "Remove hub",
            run: () =>
              props.ui.confirm(
                "Remove quota hub",
                "Remove the management key and pooled account quota from this environment? The hub itself is unchanged.",
                () => save(id, null),
                "Remove hub",
              ),
          },
        ]),
    });
  }
  for (const provider of props.state()?.config?.providers ?? []) {
    const limits = provider.usageLimits;
    if (!limits) continue;
    choices.push({
      title: provider.displayName ?? provider.driver,
      description: provider.auth.email ?? provider.auth.status,
      run: () =>
        account(provider.displayName ?? provider.driver, limits, (creditId) => ({
          instanceId: provider.instanceId,
          ...(creditId ? { creditId } : {}),
        })),
    });
  }
  props.ui.choose("Usage limits and pooled accounts", choices);
}
