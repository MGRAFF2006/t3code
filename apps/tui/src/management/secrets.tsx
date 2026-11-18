import {
  configuredSecretSources,
  secretRequestAnswerInput,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
  secretRequestLink,
  secretRequestSources,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  SecretProviderId,
  SecretProviderKind,
  WS_METHODS,
  type SecretRequestAnswerInput,
} from "@t3tools/contracts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { destinationGuard } from "./common.tsx";

export function answerSecretRequest(props: FeatureProps, item: SecretRequestItem) {
  if (item.secretStatus !== "pending") return;
  if (props.state()?.thread?.thread.id !== item.threadId) {
    props.ui.notify("Open the original thread to answer this secret request.", true);
    return;
  }
  const guard = destinationGuard(props);
  const config = props.state()?.config;
  const sources = secretRequestSources(config, config?.settings.secretProviders ?? {});
  async function answer(input: SecretRequestAnswerInput | null) {
    guard();
    if (!input) throw new Error("Enter a valid secret or secret reference.");
    try {
      await request(props.client, WS_METHODS.secretsAnswerRequest, input);
    } catch (error) {
      // oxlint-disable-next-line preserve-caught-error -- Secret errors must not retain credential-bearing transport causes.
      throw new Error(secretRequestFailureMessage(error));
    }
    props.ui.notify(
      input.answer.type === "decline" ? "Secret request declined." : "Secret saved securely.",
    );
  }
  const link = secretRequestLink(item);
  props.ui.choose(item.label, [
    ...(link && props.ui.openBrowser
      ? [{ title: `Open ${link.host}`, run: () => props.ui.openBrowser?.(link.href) }]
      : []),
    {
      title: "Enter secret",
      description: secretRequestPrivacyNote(item),
      run: () =>
        props.ui.form({
          title: item.label,
          description: `${item.reason}\n\n${secretRequestPrivacyNote(item)}`,
          fields: [
            { name: "secret", label: item.placeholder ?? "Secret", type: "secret", required: true },
          ],
          submitLabel: "Save secret",
          onSubmit: async (values) => {
            await answer(
              secretRequestAnswerInput(item, { type: "save", secret: values.secret ?? "" }),
            );
          },
        }),
    },
    ...sources.map((source) => ({
      title: `Use ${source.label}`,
      description: source.referencePlaceholder,
      run: () =>
        props.ui.form({
          title: `Use ${source.label}`,
          description: item.reason,
          fields: [
            {
              name: "reference",
              label: "Secret reference",
              required: true,
              description: source.referencePlaceholder,
            },
          ],
          submitLabel: "Use secret",
          onSubmit: async (values) => {
            const input = secretRequestAnswerInput(item, {
              type: "reference",
              source,
              reference: values.reference ?? "",
            });
            if (!input) throw new Error(source.invalidReferenceMessage);
            await answer(input);
          },
        }),
    })),
    {
      title: "Decline request",
      run: () =>
        props.ui.confirm(
          "Decline secret request",
          item.label,
          async () => {
            await answer(secretRequestAnswerInput(item, { type: "decline" }));
          },
          "Decline",
        ),
    },
  ]);
}

export function secretSettingsActions(props: FeatureProps): Choice[] {
  const config = props.state()?.config;
  const providers = config?.settings.secretProviders ?? {};
  function edit(id?: SecretProviderId) {
    const guard = destinationGuard(props);
    const current = id ? providers[id] : undefined;
    const data = current?.config;
    const account =
      typeof data === "object" &&
      data !== null &&
      "account" in data &&
      typeof data.account === "string"
        ? data.account
        : "";
    props.ui.form({
      title: id ? `Edit ${current?.label ?? id}` : "Add 1Password source",
      fields: [
        ...(!id ? [{ name: "id", label: "Source ID", value: "one-password", required: true }] : []),
        { name: "label", label: "Name", value: current?.label ?? "1Password", required: true },
        {
          name: "account",
          label: "1Password account",
          value: account,
          required: true,
          description:
            "Sign-in address, account shorthand or ID. Uses the op CLI and its authentication on this environment.",
        },
      ],
      submitLabel: "Save source",
      onSubmit: async (values) => {
        guard();
        const sourceId = id ?? SecretProviderId.make(values.id?.trim() ?? "");
        if (!id && providers[sourceId])
          throw new Error("A secret source with this ID already exists.");
        await request(props.client, WS_METHODS.serverUpdateSettings, {
          patch: {
            secretProviders: {
              [sourceId]: {
                kind: current?.kind ?? SecretProviderKind.make("one_password"),
                label: values.label?.trim() ?? "",
                config: { account: values.account?.trim() ?? "" },
              },
            },
          },
        });
        props.ui.notify("Secret source saved.");
      },
    });
  }
  const pending =
    props
      .state()
      ?.thread?.visibleTurnItems.filter(
        (entry) =>
          entry.visibility === "local" &&
          entry.item.type === "secret_request" &&
          entry.item.secretStatus === "pending",
      ) ?? [];
  const sources = configuredSecretSources(providers);
  const rows: Choice[] = [
    ...(config?.secretProviderSettings
      ? [
          {
            title: "Add secret source",
            description: "Read secrets from a configured 1Password account on this environment.",
            run: () => edit(),
          },
        ]
      : []),
    ...Object.entries(providers).map(([id, value]) => ({
      title: value.label,
      description: value.kind,
      run: () => {
        const guard = destinationGuard(props);
        const sourceId = SecretProviderId.make(id);
        const source = sources.find((entry) => entry.id === id);
        props.ui.choose(value.label, [
          ...(value.kind === "one_password"
            ? [{ title: "Edit source", run: () => edit(sourceId) }]
            : []),
          ...(source
            ? [
                {
                  title: "Test a reference",
                  run: () =>
                    props.ui.form({
                      title: `Test ${value.label}`,
                      fields: [
                        {
                          name: "reference",
                          label: "Secret reference",
                          required: true,
                          description: source.referencePlaceholder,
                        },
                      ],
                      submitLabel: "Test reference",
                      onSubmit: async (values) => {
                        guard();
                        const reference = values.reference?.trim() ?? "";
                        if (!source.isReference(reference))
                          throw new Error(source.invalidReferenceMessage);
                        const result = await request(
                          props.client,
                          WS_METHODS.serverCheckSecretSource,
                          { source: { provider: sourceId, reference } },
                        );
                        if (result._tag === "Failed") throw new Error(result.detail);
                        props.ui.notify(
                          "The secret source resolved this reference. Its value remains private.",
                        );
                      },
                    }),
                },
              ]
            : []),
          {
            title: "Remove source",
            run: () =>
              props.ui.confirm(
                "Remove secret source",
                `Remove ${value.label}? Settings that use it will need another source.`,
                async () => {
                  guard();
                  await request(props.client, WS_METHODS.serverUpdateSettings, {
                    patch: { secretProviders: { [sourceId]: null } },
                  });
                },
                "Remove source",
              ),
          },
        ]);
      },
    })),
    ...pending.flatMap((entry) =>
      entry.item.type === "secret_request"
        ? [
            {
              title: `Answer: ${entry.item.label}`,
              description: entry.item.reason,
              run: () => {
                if (entry.item.type === "secret_request") answerSecretRequest(props, entry.item);
              },
            },
          ]
        : [],
    ),
  ];
  return rows;
}
