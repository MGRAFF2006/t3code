import type { ModelSelection, ServerConfig, ServerProvider } from "@t3tools/contracts";

type Provider = Pick<
  ServerProvider,
  "instanceId" | "displayName" | "driver" | "enabled" | "installed" | "models"
>;
type Preferences = Pick<ServerConfig["settings"], "favorites" | "providerModelPreferences">;

export function selectableModels(
  providers: ReadonlyArray<Provider>,
  preferences?: Preferences,
  active?: ModelSelection | null,
) {
  const favorites = new Map(
    (preferences?.favorites ?? []).map((value, index) => [
      `${value.provider}/${value.model}`,
      index,
    ]),
  );
  return providers
    .flatMap((provider, providerIndex) => {
      if (!provider.enabled || !provider.installed) return [];
      const settings = preferences?.providerModelPreferences?.[provider.instanceId];
      const order = new Map((settings?.modelOrder ?? []).map((value, index) => [value, index]));
      return provider.models.flatMap((model, modelIndex) => {
        if (
          settings?.hiddenModels.includes(model.slug) &&
          !(active?.instanceId === provider.instanceId && active.model === model.slug)
        )
          return [];
        const rank = favorites.get(`${provider.instanceId}/${model.slug}`);
        return [
          {
            provider,
            model,
            favorite: rank !== undefined,
            favoriteRank: rank ?? Number.POSITIVE_INFINITY,
            providerIndex,
            modelRank: order.get(model.slug) ?? Number.POSITIVE_INFINITY,
            modelIndex,
          },
        ];
      });
    })
    .sort(
      (a, b) =>
        a.favoriteRank - b.favoriteRank ||
        a.providerIndex - b.providerIndex ||
        a.modelRank - b.modelRank ||
        a.modelIndex - b.modelIndex,
    );
}
