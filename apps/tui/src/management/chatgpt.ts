import {
  EnvironmentId,
  WS_METHODS,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import { batch, createEffect, createSignal, onCleanup } from "solid-js";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { request, subscribe } from "../rpc/request.ts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { destinationGuard } from "./common.tsx";
import { startChatGptTransfer } from "./chatgpt.logic.ts";

export function createChatGptProfileActions(props: FeatureProps) {
  const [transfer, setTransfer] = createSignal<{
    environment: string;
    modal: object | null;
    close: () => void;
  } | null>(null);
  const close = () => {
    transfer()?.close();
    setTransfer(null);
  };
  createEffect(() => {
    const active = transfer();
    if (
      active &&
      (props.state()?.environmentId !== active.environment ||
        !props.ui.modal() ||
        (props.ui.modalIdentity && props.ui.modalIdentity() !== active.modal))
    )
      close();
  });
  onCleanup(close);

  function open(provider: ServerProvider, auth: ProviderAuthState | null) {
    const guard = destinationGuard(props);
    const selectedEnvironment = props.state()?.environmentId;
    if (!selectedEnvironment || provider.driver !== "codex") return;
    const environment = selectedEnvironment;
    async function chooseSource(methodId: string) {
      guard();
      const destinations = await props.client.environments();
      guard();
      props.ui.choose(
        "Connect ChatGPT through",
        destinations
          .filter((entry) => entry.enabled)
          .map((entry) => ({
            title: entry.label,
            description:
              "Choose the paired machine on which your browser can reach the sign-in callback.",
            run: () =>
              void props.ui.run(async () => {
                close();
                guard();
                const target = await props.client.captureTransportFor(environment);
                const source = await props.client.captureTransportFor(entry.environmentId);
                const profile = await request(target, WS_METHODS.chatGptReconnectProfile, {
                  instanceId: provider.instanceId,
                  methodId,
                });
                guard();
                let state: ProviderAuthState | null = null;
                let importing = false;
                const session = { environment, modal: null as object | null, close: () => {} };
                const show = () => {
                  const choices: Choice[] = [];
                  const interaction = state?.interaction;
                  const url =
                    interaction?.type === "browser" || interaction?.type === "deviceCode"
                      ? interaction.url
                      : state?.authorizationUrl;
                  if (url)
                    choices.push({
                      title: "Open ChatGPT sign-in page",
                      description:
                        interaction?.type === "deviceCode"
                          ? `Code: ${interaction.userCode}`
                          : undefined,
                      run: () => {
                        props.ui.openBrowser?.(url);
                        show();
                      },
                    });
                  choices.push(
                    {
                      title: importing
                        ? "Importing connected profile…"
                        : (state?.message ?? "Preparing sign-in…"),
                      description: state?.phase ?? undefined,
                      run: show,
                    },
                    { title: "Cancel sign-in", run: close },
                  );
                  batch(() => {
                    props.ui.choose(`${provider.displayName ?? "Codex"} · ${entry.label}`, choices);
                    session.modal = props.ui.modalIdentity?.() ?? null;
                  });
                };
                show();
                setTransfer(session);
                session.close = startChatGptTransfer({
                  current: () =>
                    transfer() === session &&
                    props.state()?.environmentId === environment &&
                    (!props.ui.modalIdentity || props.ui.modalIdentity() === session.modal),
                  subscribe: (receive, fail) =>
                    subscribe(
                      source,
                      WS_METHODS.chatGptHandoffSubscribe,
                      {
                        instanceId: provider.instanceId,
                        environmentId: EnvironmentId.make(environment),
                        attemptId: SecureRandom.uuidV4Unsafe(),
                        returnUrl: "",
                        profile,
                      },
                      receive,
                      fail,
                    ),
                  importProfile: async (finished) => {
                    guard();
                    importing = true;
                    show();
                    await request(target, WS_METHODS.chatGptImportProfile, {
                      instanceId: provider.instanceId,
                      profile: finished,
                    });
                  },
                  onAuth: (next) => {
                    state = next;
                    if (next.phase === "failed" || next.phase === "cancelled") {
                      close();
                      props.ui.notify(next.message ?? "ChatGPT sign-in did not finish.", true);
                      return;
                    }
                    show();
                  },
                  onFinished: () => {
                    setTransfer(null);
                    props.ui.choose("ChatGPT connected", [
                      {
                        title: "Done",
                        description: "This provider now uses the connected ChatGPT profile.",
                        run: () => {},
                      },
                    ]);
                    props.ui.notify("ChatGPT profile connected.");
                  },
                  onError: () => {
                    close();
                    props.ui.notify(
                      "ChatGPT sign-in could not finish. Open profile connections to try again.",
                      true,
                    );
                  },
                });
                if (transfer() !== session) session.close();
              }),
          })),
      );
    }
    props.ui.choose("ChatGPT profile connections", [
      {
        title: "Connect a ChatGPT account",
        run: () => void props.ui.run(() => chooseSource("chatgpt-change-account")),
      },
      ...(auth?.methods
        ?.filter((method) => method.id === "chatgpt" || method.id.startsWith("chatgpt-profile:"))
        .map((method) => ({
          title: `Reconnect: ${method.name}`,
          description: method.description ?? undefined,
          run: () => void props.ui.run(() => chooseSource(method.id)),
        })) ?? []),
    ]);
  }
  return { open };
}
