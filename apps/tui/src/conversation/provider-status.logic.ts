import type { ServerProvider } from "@t3tools/contracts";
import { getProviderClient } from "@t3tools/client-runtime/provider-clients";

function providerSetupAvailable(provider: ServerProvider) {
  return (
    provider.driver === "antigravity" ||
    provider.setup?.canAuthenticate === true ||
    provider.setup?.canInstall === true
  );
}

export function providerStatusBanner(
  environmentId: string | null | undefined,
  provider: ServerProvider | null | undefined,
) {
  if (!environmentId || !provider || provider.status === "disabled") return null;
  const advisory = provider.compatibilityAdvisory;
  const incompatible =
    provider.status === "error" && provider.auth.status === "unauthenticated"
      ? null
      : advisory?.status === "broken" ||
          (provider.status === "ready" && advisory?.status === "unsupported")
        ? advisory
        : null;
  if (!incompatible && provider.status === "ready") return null;
  if (
    !incompatible &&
    provider.driver === "antigravity" &&
    provider.installed &&
    provider.status === "warning" &&
    provider.auth.status === "unknown"
  )
    return null;
  const name =
    provider.displayName?.trim() || getProviderClient(provider.driver)?.label || provider.driver;
  const unauthenticated = provider.status === "error" && provider.auth.status === "unauthenticated";
  const setup = providerSetupAvailable(provider);
  const fallback =
    !provider.installed && setup
      ? `Open provider setup to install ${getProviderClient(provider.driver)?.label || provider.driver} on this environment.`
      : provider.auth.status === "unauthenticated"
        ? setup
          ? provider.driver === "antigravity"
            ? "Open provider setup to sign in with Google."
            : "Open provider setup to sign in."
          : "Sign in via the CLI to authenticate again."
        : provider.status === "ready"
          ? "No models are available for this provider."
          : provider.status === "error"
            ? `${name} provider is unavailable.`
            : `${name} provider has limited availability.`;
  const message = incompatible?.message || provider.message || fallback;
  const key = incompatible
    ? [
        provider.instanceId,
        incompatible.status,
        provider.version ?? "",
        incompatible.message ?? "",
      ].join("\0")
    : [provider.instanceId, provider.status, provider.auth.status, provider.message ?? ""].join(
        "\0",
      );
  return {
    key: `${environmentId}\0${key}`,
    title: unauthenticated
      ? `${name} is unauthenticated`
      : incompatible
        ? `${name} ${provider.version ?? ""} is ${incompatible.status === "broken" ? "known to be broken" : "unsupported"}`
        : `${name} provider status`,
    message,
    tone:
      incompatible?.status !== "broken" && (provider.status === "warning" || incompatible !== null)
        ? ("warning" as const)
        : ("error" as const),
    setup,
  };
}
