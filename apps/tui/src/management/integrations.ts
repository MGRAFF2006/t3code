import {
  WS_METHODS,
  type AuthMcpClientAccess,
  type IssueTrackerConnection,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import {
  readHostCredentialSettings,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { destinationGuard } from "./common.tsx";

export function linkedEnvironmentActions(props: FeatureProps) {
  const guard = destinationGuard(props);
  void props.ui.run(async () => {
    guard();
    const result = await request(props.client, WS_METHODS.peerLinksList, {});
    guard();
    props.ui.choose("Linked environments", [
      {
        title: "Link another environment",
        description: "Allow this environment's agents to work on another server.",
        run: () =>
          props.ui.form({
            title: "Link environment",
            description:
              "Create a pairing code on the other server. Its chosen access remains authoritative.",
            fields: [
              { name: "url", label: "Server address", required: true },
              { name: "code", label: "Pairing code", required: true, type: "secret" },
              {
                name: "access",
                label: "Agent access",
                type: "select",
                value: "approval-required",
                options: (
                  [
                    "read-only",
                    "approval-required",
                    "auto-accept-edits",
                    "auto",
                    "full-access",
                  ] as const
                ).map((value) => ({ label: value, value })),
              },
            ],
            onSubmit: async (values) => {
              guard();
              const link = await request(props.client, WS_METHODS.peerLinksLink, {
                url: values.url?.trim() ?? "",
                pairingCode: values.code?.trim() ?? "",
                access: (values.access ?? "approval-required") as AuthMcpClientAccess,
              });
              guard();
              props.ui.notify(`Linked ${link.label}.`);
            },
          }),
      },
      { title: "Refresh links", run: () => linkedEnvironmentActions(props) },
      ...result.links.map((link) => ({
        title: link.label,
        description: `${link.status} · ${link.access}${link.lastError ? ` · ${link.lastError}` : ""}`,
        run: () =>
          props.ui.choose(link.label, [
            {
              title: "Connection details",
              run: () =>
                props.ui.text(
                  link.label,
                  `${link.urls.join("\n")}\n\nAccess: ${link.access}\nStatus: ${link.status}\nExpires: ${DateTime.formatIso(link.expiresAt)}${link.lastError ? `\n\n${link.lastError}` : ""}`,
                ),
            },
            {
              title: "Unlink environment",
              run: () =>
                props.ui.confirm(
                  "Unlink environment",
                  `Stop this environment's agents from reaching ${link.label}?`,
                  async () => {
                    guard();
                    await request(props.client, WS_METHODS.peerLinksUnlink, {
                      environmentId: link.environmentId,
                    });
                    guard();
                    props.ui.notify(`Unlinked ${link.label}.`);
                  },
                  "Unlink",
                ),
            },
          ]),
      })),
    ]);
  });
}

export function issueTrackerActions(props: FeatureProps) {
  const guard = destinationGuard(props);
  void props.ui.run(async () => {
    guard();
    const result = await request(props.client, WS_METHODS.issueTrackersList, {});
    guard();
    function trackerActions(tracker: IssueTrackerConnection) {
      const options: Choice[] = [
        {
          title: tracker.connected ? "Replace credential" : "Connect tracker",
          description: tracker.credential.label,
          run: () =>
            props.ui.form({
              title: `Connect ${tracker.displayName}`,
              description: tracker.credential.helpUrl ?? undefined,
              fields: [
                { name: "token", label: tracker.credential.label, type: "secret", required: true },
              ],
              onSubmit: async (values) => {
                guard();
                await request(props.client, WS_METHODS.issueTrackersConnect, {
                  tracker: tracker.tracker,
                  token: values.token?.trim() ?? "",
                });
                guard();
                props.ui.notify(
                  `${tracker.displayName} connected. Reopen trackers to select a project binding.`,
                );
              },
            }),
        },
      ];
      if (tracker.credential.helpUrl)
        options.push({
          title: "Open credential setup",
          run: () => props.ui.openBrowser?.(tracker.credential.helpUrl!),
        });
      if (tracker.connected) {
        options.push(
          {
            title: `Choose project ${tracker.scopeNoun}`,
            run: () =>
              props.ui.choose(
                "Choose project",
                (props.state()?.shell?.projects ?? []).map((project) => ({
                  title: project.title,
                  description:
                    result.bindings[project.id]?.scope ?? "No standalone tracker selected",
                  run: () =>
                    props.ui.choose(`${project.title} · ${tracker.scopeNoun}`, [
                      {
                        title: "Use only the repository's issue tracker",
                        run: () =>
                          void props.ui.run(async () => {
                            guard();
                            await request(props.client, WS_METHODS.issueTrackersBindProject, {
                              projectId: project.id,
                              binding: null,
                            });
                          }, "Project issue tracker updated."),
                      },
                      ...tracker.scopes.map((scope) => ({
                        title: scope.name,
                        description: scope.key,
                        run: () =>
                          void props.ui.run(async () => {
                            guard();
                            await request(props.client, WS_METHODS.issueTrackersBindProject, {
                              projectId: project.id,
                              binding: { tracker: tracker.tracker, scope: scope.key },
                            });
                          }, "Project issue tracker updated."),
                      })),
                    ]),
                })),
              ),
          },
          {
            title: "Disconnect tracker",
            run: () =>
              props.ui.confirm(
                "Disconnect tracker",
                `Remove ${tracker.displayName}'s credential and all its project bindings?`,
                async () => {
                  guard();
                  await request(props.client, WS_METHODS.issueTrackersConnect, {
                    tracker: tracker.tracker,
                    token: null,
                  });
                },
                "Disconnect",
              ),
          },
        );
      }
      props.ui.choose(tracker.displayName, options);
    }
    props.ui.choose("Issue tracker connections", [
      { title: "Refresh trackers", run: () => issueTrackerActions(props) },
      ...result.trackers.map((tracker) => ({
        title: tracker.displayName,
        description:
          tracker.account ??
          tracker.detail ??
          (tracker.connected ? "Credential needs attention" : "Not connected"),
        run: () => trackerActions(tracker),
      })),
    ]);
  });
}

export function sourceControlActions(props: FeatureProps) {
  const guard = destinationGuard(props);
  void props.ui.run(async () => {
    guard();
    const discovery = await request(props.client, WS_METHODS.serverDiscoverSourceControl, {});
    guard();
    function providerActions(provider: SourceControlProviderDiscoveryItem) {
      const definition = sourceControlClients.find(provider.kind);
      const settings = props.state()?.config?.settings;
      if (!definition || !settings) throw new Error("Source-control settings are unavailable.");
      const saved = readHostCredentialSettings(settings, provider.kind);
      const save = async (fields: Record<string, unknown>) => {
        guard();
        await request(props.client, WS_METHODS.serverUpdateSettings, {
          patch: { sourceControlHosts: { [provider.kind]: fields } },
        });
        guard();
        props.ui.notify(`${provider.label} settings saved.`);
      };
      const options: Choice[] = [
        {
          title: "Connection status",
          run: () =>
            props.ui.text(
              provider.label,
              [
                provider.status,
                provider.auth.status,
                Option.getOrNull(provider.auth.account),
                Option.getOrNull(provider.auth.host),
                Option.getOrNull(provider.auth.detail),
                Option.getOrNull(provider.detail),
                provider.installHint,
              ]
                .filter(Boolean)
                .join("\n\n"),
            ),
        },
      ];
      if (definition.credentials) {
        options.push({
          title: "Save a host token",
          run: () =>
            props.ui.form({
              title: `${provider.label} token`,
              description: `Grant ${definition.credentials!.tokenAccess}. Saved tokens take precedence over CLI sign-in.`,
              fields: [
                {
                  name: "host",
                  label: "Hostname",
                  value: definition.publicHost ?? "",
                  required: true,
                },
                { name: "token", label: "Token", type: "secret", required: true },
              ],
              onSubmit: async (values) =>
                save({
                  tokens: {
                    ...saved.tokens,
                    [values.host?.trim().toLowerCase() ?? ""]: values.token?.trim() ?? "",
                  },
                }),
            }),
        });
        for (const host of Object.keys(saved.tokens))
          options.push({
            title: `Remove token for ${host}`,
            run: () =>
              props.ui.confirm(
                "Remove token",
                `Use the server's other credentials for ${host} instead?`,
                () => save({ tokens: { ...saved.tokens, [host]: "" } }),
                "Remove token",
              ),
          });
        const hosts = [
          ...new Set([
            ...(provider.auth.accounts ?? []).map((entry) => entry.host),
            ...Object.keys(saved.hosts),
          ]),
        ];
        for (const host of hosts) {
          const current = saved.hosts[host];
          options.push({
            title: `Account for ${host}`,
            description:
              current?.enabled === false ? "Disabled" : (current?.account ?? "Automatic"),
            run: () =>
              props.ui.choose(host, [
                {
                  title: "Automatic account",
                  run: () =>
                    void props.ui.run(() =>
                      save({ hosts: { ...saved.hosts, [host]: { enabled: true } } }),
                    ),
                },
                {
                  title: "Disable this host",
                  run: () =>
                    void props.ui.run(() =>
                      save({ hosts: { ...saved.hosts, [host]: { ...current, enabled: false } } }),
                    ),
                },
                ...(provider.auth.accounts ?? [])
                  .filter(
                    (entry) =>
                      entry.host === host && entry.authenticated && !entry.environmentVariable,
                  )
                  .map((entry) => ({
                    title: entry.account,
                    run: () =>
                      void props.ui.run(() =>
                        save({
                          hosts: {
                            ...saved.hosts,
                            [host]: { enabled: true, account: entry.account },
                          },
                        }),
                      ),
                  })),
              ]),
          });
        }
      }
      if (provider.appSignIn && definition.credentials?.appSignIn) {
        for (const host of definition.credentials.appSignIn.hosts)
          options.push({
            title: `Sign in through ${provider.label} on ${host}`,
            run: () =>
              void props.ui.run(async () => {
                guard();
                const input = { provider: provider.kind, host };
                const prompt = await request(
                  props.client,
                  WS_METHODS.sourceControlSignInStart,
                  input,
                );
                guard();
                props.ui.choose(`Sign in to ${host}`, [
                  {
                    title: "Open sign-in page",
                    description: `Code: ${prompt.userCode}`,
                    run: () => props.ui.openBrowser?.(prompt.verificationUri),
                  },
                  {
                    title: "Show sign-in code",
                    run: () =>
                      props.ui.text(
                        "Source-control sign-in",
                        `${prompt.verificationUri}\n\nCode: ${prompt.userCode}`,
                      ),
                  },
                  {
                    title: "Wait for sign-in",
                    run: () =>
                      void props.ui.run(async () => {
                        guard();
                        const result = await request(
                          props.client,
                          WS_METHODS.sourceControlSignInWait,
                          input,
                        );
                        guard();
                        props.ui.notify(`Signed in as ${result.account}.`);
                      }),
                  },
                  {
                    title: "Cancel sign-in",
                    run: () =>
                      void props.ui.run(async () => {
                        guard();
                        await request(props.client, WS_METHODS.sourceControlSignInCancel, input);
                      }, "Sign-in cancelled."),
                  },
                ]);
              }),
          });
      }
      props.ui.choose(provider.label, options);
    }
    props.ui.choose("Source-control connections", [
      { title: "Refresh status", run: () => sourceControlActions(props) },
      ...discovery.sourceControlProviders.map((provider) => ({
        title: provider.label,
        description: `${provider.status} · ${provider.auth.status}`,
        run: () => providerActions(provider),
      })),
    ]);
  });
}
