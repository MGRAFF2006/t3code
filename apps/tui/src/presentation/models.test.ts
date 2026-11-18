import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { selectableModels } from "./models.ts";

describe("terminal model preferences", () => {
  it("applies hidden models and global favorites while preserving a hidden active model and explicit ordering", () => {
    const provider = ProviderInstanceId.make("codex");
    const other = ProviderInstanceId.make("second");
    const models = ["default", "hidden", "ordered", "favorite"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    }));
    const providers = [
      {
        instanceId: provider,
        displayName: "Codex",
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        models,
      },
      {
        instanceId: other,
        displayName: "Other",
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: false,
        models,
      },
    ];
    const settings = {
      favorites: [{ provider, model: "favorite" }],
      providerModelPreferences: {
        [provider]: { hiddenModels: ["hidden"], modelOrder: ["ordered", "default"] },
      },
    };
    expect(selectableModels(providers, settings).map((value) => value.model.slug)).toEqual([
      "favorite",
      "ordered",
      "default",
    ]);
    expect(
      selectableModels(providers, settings, { instanceId: provider, model: "hidden" }).map(
        (value) => value.model.slug,
      ),
    ).toEqual(["favorite", "ordered", "default", "hidden"]);
  });
});
