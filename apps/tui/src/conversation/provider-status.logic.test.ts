import { expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { providerStatusBanner } from "./provider-status.logic.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-22T00:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
};

it("follows desktop compatibility and authentication precedence without misreporting empty cached models", () => {
  expect(providerStatusBanner("local", provider)).toBeNull();
  const broken: ServerProvider = {
    ...provider,
    status: "error",
    message: "Provider inventory timed out.",
    compatibilityAdvisory: {
      status: "broken",
      message: "Use 2.0.0.",
      recommendedVersion: "2.0.0",
      recommendedRange: null,
    },
  };
  expect(providerStatusBanner("local", broken)).toMatchObject({
    tone: "error",
    message: "Use 2.0.0.",
  });
  expect(
    providerStatusBanner("local", { ...broken, auth: { status: "unauthenticated" } }),
  ).toMatchObject({
    tone: "error",
    message: broken.message,
    title: "Codex is unauthenticated",
  });
  const unsupported: ServerProvider = {
    ...provider,
    compatibilityAdvisory: { ...broken.compatibilityAdvisory!, status: "unsupported" },
  };
  expect(providerStatusBanner("local", unsupported)).toMatchObject({
    tone: "warning",
    message: "Use 2.0.0.",
  });
  expect(providerStatusBanner("local", { ...unsupported, status: "disabled" })).toBeNull();
  expect(
    providerStatusBanner("local", {
      ...unsupported,
      compatibilityAdvisory: { ...unsupported.compatibilityAdvisory!, status: "graceful" },
    }),
  ).toBeNull();
  expect(
    providerStatusBanner("local", {
      ...provider,
      driver: ProviderDriverKind.make("antigravity"),
      status: "warning",
      auth: { status: "unknown" },
    }),
  ).toBeNull();
});

it("offers environment-local setup guidance and renews session notices when status changes", () => {
  const missing: ServerProvider = {
    ...provider,
    installed: false,
    status: "error",
    auth: { status: "unknown" },
    setup: { canInstall: true, canAuthenticate: false },
  };
  expect(providerStatusBanner("local", missing)).toMatchObject({
    setup: true,
    message: "Open provider setup to install Codex on this environment.",
  });
  const unauthenticated: ServerProvider = {
    ...provider,
    status: "error",
    auth: { status: "unauthenticated" },
  };
  expect(providerStatusBanner("local", unauthenticated)).toMatchObject({
    setup: false,
    message: "Sign in via the CLI to authenticate again.",
  });
  const warning: ServerProvider = { ...provider, status: "warning" };
  expect(providerStatusBanner("local", warning)?.tone).toBe("warning");
  expect(providerStatusBanner("local", warning)?.key).not.toBe(
    providerStatusBanner("remote", warning)?.key,
  );
  expect(providerStatusBanner("local", warning)?.key).not.toBe(
    providerStatusBanner("local", { ...warning, message: "New provider problem" })?.key,
  );
  expect(providerStatusBanner("local", warning)?.key).not.toBe(
    providerStatusBanner("local", { ...warning, auth: { status: "unauthenticated" } })?.key,
  );
  expect(providerStatusBanner(null, warning)).toBeNull();
});
