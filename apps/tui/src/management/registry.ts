import {
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  type AcpRegistrySearchAgent,
  type OrchestrationProjectShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { request } from "../rpc/request.ts";
import type { Choice, FeatureProps } from "../ui/controller.ts";
import { destinationGuard } from "./common.tsx";
import { parseRegistryHeaders } from "./registry.logic.ts";

export function searchRegistry(props: FeatureProps) {
  const guard = destinationGuard(props);
  function add(agent: AcpRegistrySearchAgent) {
    props.ui.form({
      title: `Add ${agent.name}`,
      description: `${agent.description}\n\n${agent.distribution} · ${agent.version}${agent.license ? ` · ${agent.license}` : ""}. Preparing may download and run this agent's distribution on the selected environment.`,
      fields: [
        {
          name: "id",
          label: "Instance ID",
          value: `acpRegistry_${agent.id.replaceAll("-", "_")}`,
          required: true,
        },
        { name: "name", label: "Display name", value: agent.name, required: true },
      ],
      submitLabel: "Prepare and add",
      onSubmit: async ({ id = "", name = "" }) => {
        guard();
        const instanceId = ProviderInstanceId.make(id.trim());
        if (props.state()?.config?.settings.providerInstances[instanceId])
          throw new Error("That provider instance ID already exists. Choose another ID.");
        await request(props.client, WS_METHODS.serverPrepareAcpRegistryAgent, {
          agentId: agent.id,
        });
        guard();
        await request(props.client, WS_METHODS.serverUpdateSettings, {
          patch: {},
          providerInstanceMutation: {
            operation: "create",
            instanceId,
            instance: {
              driver: ProviderDriverKind.make("acpRegistry"),
              displayName: name.trim(),
              enabled: false,
              config: { source: "registry", agentId: agent.id },
            },
          },
        });
        props.ui.notify(
          "Registry provider added disabled. Select it to configure, sign in and enable it.",
        );
      },
    });
  }
  props.ui.form({
    title: "Find an ACP Registry agent",
    fields: [{ name: "query", label: "Name or description" }],
    submitLabel: "Search registry",
    onSubmit: async ({ query = "" }) => {
      guard();
      const result = await request(props.client, WS_METHODS.serverSearchAcpRegistry, {
        query: query.trim(),
        limit: 100,
      });
      guard();
      if (!result.agents.length) {
        props.ui.notify("No compatible agents found. Try a broader search.");
        return;
      }
      props.ui.choose(
        "ACP Registry agents",
        result.agents.map((agent) => ({
          title: agent.name,
          description: `${agent.description} · ${agent.distribution} · ${agent.version}`,
          run: () =>
            props.ui.choose(agent.name, [
              { title: "Prepare and add provider", run: () => add(agent) },
              ...(agent.website
                ? [
                    {
                      title: "Open agent website",
                      run: () => props.ui.openBrowser?.(agent.website!),
                    },
                  ]
                : []),
              ...(agent.repository
                ? [
                    {
                      title: "Open agent repository",
                      run: () => props.ui.openBrowser?.(agent.repository!),
                    },
                  ]
                : []),
            ]),
        })),
      );
    },
  });
}

export function registryProviderActions(props: FeatureProps, provider: ServerProvider) {
  const guard = destinationGuard(props);
  const instanceId = provider.instanceId;
  function chooseProject(
    action: (project: OrchestrationProjectShell, check: () => void) => Promise<void>,
  ) {
    props.ui.choose(
      "Choose project",
      (props.state()?.shell?.projects ?? []).map((project) => ({
        title: project.title,
        description: project.workspaceRoot,
        run: () =>
          void props.ui.run(async () => {
            const check = () => {
              guard();
              if (
                props.state()?.shell?.projects.find((entry) => entry.id === project.id)
                  ?.workspaceRoot !== project.workspaceRoot
              )
                throw new Error("The project changed. Choose the project again.");
            };
            check();
            await action(project, check);
          }),
      })),
    );
  }
  async function sessions(project: OrchestrationProjectShell, check: () => void, cursor?: string) {
    check();
    const input = { instanceId, projectId: project.id };
    const result = await request(props.client, WS_METHODS.serverListAcpRegistrySessions, {
      ...input,
      ...(cursor ? { cursor } : {}),
    });
    check();
    props.ui.choose(`${project.title} · Agent sessions`, [
      { title: "Refresh sessions", run: () => void props.ui.run(() => sessions(project, check)) },
      ...result.sessions.map((session) => ({
        title: session.title ?? session.sessionId,
        description: `${session.cwd}${session.updatedAt ? ` · ${session.updatedAt}` : ""}${session.importedThreadId ? " · Imported" : ""}`,
        run: () => {
          const options: Choice[] = [];
          if (session.importedThreadId)
            options.push({
              title: "Open imported conversation",
              run: () => props.ui.openThread(session.importedThreadId!),
            });
          if (
            (result.canLoad || result.canResume) &&
            (!session.importedThreadId || session.nativeHistoryPending)
          )
            options.push({
              title: session.importedThreadId ? "Load remaining history" : "Import conversation",
              run: () =>
                void props.ui.run(async () => {
                  check();
                  const imported = await request(
                    props.client,
                    WS_METHODS.serverImportAcpRegistrySession,
                    {
                      ...input,
                      sessionId: session.sessionId,
                      title: session.title,
                      updatedAt: session.updatedAt,
                    },
                  );
                  check();
                  props.ui.openThread(imported.threadId);
                }),
            });
          if (result.canDelete)
            options.push({
              title: "Delete provider session",
              description: "Removes this session from the agent's own session store.",
              run: () =>
                props.ui.confirm(
                  "Delete provider session",
                  session.title ?? session.sessionId,
                  async () => {
                    check();
                    await request(props.client, WS_METHODS.serverDeleteAcpRegistrySession, {
                      ...input,
                      sessionId: session.sessionId,
                    });
                    check();
                    await sessions(project, check);
                  },
                  "Delete provider session",
                ),
            });
          props.ui.choose(
            session.title ?? "Agent session",
            options.length ? options : [{ title: "No supported actions", run: () => {} }],
          );
        },
      })),
      ...(result.nextCursor
        ? [
            {
              title: "Next page",
              run: () => void props.ui.run(() => sessions(project, check, result.nextCursor!)),
            },
          ]
        : []),
    ]);
  }
  async function endpoints(project: OrchestrationProjectShell, check: () => void) {
    check();
    const input = { instanceId, projectId: project.id };
    const result = await request(props.client, WS_METHODS.serverListAcpRegistryProviders, input);
    check();
    props.ui.choose(
      `${project.title} · Agent endpoints`,
      result.providers.map((endpoint) => ({
        title: endpoint.providerId,
        description: endpoint.current
          ? `${endpoint.current.apiType} · ${endpoint.current.baseUrl}`
          : endpoint.required
            ? "Configuration required"
            : "Not configured",
        run: () =>
          props.ui.choose(endpoint.providerId, [
            {
              title: "Configure endpoint",
              run: () =>
                props.ui.form({
                  title: endpoint.providerId,
                  fields: [
                    {
                      name: "apiType",
                      label: "API protocol",
                      type: "select",
                      value: endpoint.current?.apiType ?? endpoint.supported[0] ?? "",
                      options: endpoint.supported.map((value) => ({ label: value, value })),
                      required: true,
                    },
                    {
                      name: "baseUrl",
                      label: "Endpoint URL",
                      value: endpoint.current?.baseUrl ?? "",
                      required: true,
                    },
                    {
                      name: "headers",
                      label: "Headers (JSON object)",
                      type: "secret",
                      description: "Leave blank to preserve saved headers.",
                    },
                  ],
                  onSubmit: async ({ apiType = "", baseUrl = "", headers = "" }) => {
                    check();
                    const values = parseRegistryHeaders(headers);
                    await request(props.client, WS_METHODS.serverSetAcpRegistryProvider, {
                      ...input,
                      providerId: endpoint.providerId,
                      apiType,
                      baseUrl: baseUrl.trim(),
                      ...(values ? { headers: values } : {}),
                    });
                    props.ui.notify("Agent endpoint saved.");
                  },
                }),
            },
            ...(!endpoint.required && endpoint.current
              ? [
                  {
                    title: "Disable endpoint",
                    run: () =>
                      props.ui.confirm(
                        "Disable endpoint",
                        endpoint.providerId,
                        async () => {
                          check();
                          await request(props.client, WS_METHODS.serverDisableAcpRegistryProvider, {
                            ...input,
                            providerId: endpoint.providerId,
                          });
                          props.ui.notify("Agent endpoint disabled.");
                        },
                        "Disable endpoint",
                      ),
                  },
                ]
              : []),
          ]),
      })),
    );
  }
  const choices: Choice[] = [];
  if (provider.nativeSessions?.canList)
    choices.push({ title: "Browse provider sessions", run: () => chooseProject(sessions) });
  if (provider.configurableProviders)
    choices.push({ title: "Configure agent endpoints", run: () => chooseProject(endpoints) });
  if (provider.auth.action) {
    const action = provider.auth.action;
    choices.push(
      {
        title: "Open pending sign-in page",
        description: action.message,
        run: () => props.ui.openBrowser?.(action.url),
      },
      {
        title: "Continue pending sign-in",
        description: action.message,
        run: () =>
          void props.ui.run(async () => {
            guard();
            await request(props.client, WS_METHODS.serverAcceptAcpRegistryUrlAuth, {
              instanceId,
              elicitationId: action.elicitationId,
            });
            props.ui.notify("Sign-in continuation accepted.");
          }),
      },
    );
  }
  if (provider.auth.canLogout)
    choices.push({
      title: "Sign out of agent",
      run: () =>
        props.ui.confirm(
          "Sign out of agent",
          provider.displayName ?? provider.driver,
          async () => {
            guard();
            await request(props.client, WS_METHODS.serverLogoutAcpRegistry, { instanceId });
            props.ui.notify("Agent signed out.");
          },
          "Sign out",
        ),
    });
  const config = props.state()?.config?.settings.providerInstances[instanceId]?.config;
  const agentId =
    typeof config === "object" &&
    config !== null &&
    "agentId" in config &&
    typeof config.agentId === "string"
      ? config.agentId
      : null;
  if (provider.driver === "acpRegistry" && agentId)
    choices.push({
      title: "Remove managed agent binary",
      run: () =>
        props.ui.confirm(
          "Remove managed agent binary",
          `Remove the downloaded ${agentId} binary? This does not remove provider settings or sessions.`,
          async () => {
            guard();
            const result = await request(
              props.client,
              WS_METHODS.serverUninstallAcpRegistryManagedBinary,
              { agentId },
            );
            props.ui.notify(
              result.removed ? "Managed agent binary removed." : "No managed binary was present.",
            );
          },
          "Remove binary",
        ),
    });
  props.ui.choose(`${provider.displayName ?? provider.driver} sessions and endpoints`, choices);
}
