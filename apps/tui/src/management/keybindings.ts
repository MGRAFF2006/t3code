import { KeybindingCommand, WS_METHODS, type ResolvedKeybindingRule } from "@t3tools/contracts";
import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";
import * as Schema from "effect/Schema";
import type { FeatureProps } from "../ui/controller.ts";
import { request } from "../rpc/request.ts";
import { destinationGuard } from "./common.tsx";
import { editableKeybinding } from "./keybindings.logic.ts";
const decodeCommand = Schema.decodeUnknownSync(KeybindingCommand);

export function keybindingActions(props: FeatureProps) {
  const guard = destinationGuard(props);
  function edit(binding?: ResolvedKeybindingRule) {
    const previous = binding ? editableKeybinding(binding) : undefined;
    props.ui.form({
      title: binding ? "Edit server keybinding" : "Add server keybinding",
      description:
        "Applies to web and desktop clients. Terminal navigation shortcuts are listed in F1.",
      fields: [
        { name: "command", label: "Command", value: previous?.command ?? "", required: true },
        {
          name: "key",
          label: "Shortcut (for example ctrl+shift+k)",
          value: previous?.key ?? "",
          required: true,
        },
        { name: "when", label: "When expression (optional)", value: previous?.when ?? "" },
      ],
      onSubmit: async (values) => {
        guard();
        const command = decodeCommand(values.command?.trim());
        const when = values.when?.trim();
        const next = { key: values.key?.trim() ?? "", command, ...(when ? { when } : {}) };
        if (!compileResolvedKeybindingRule(next))
          throw new Error("Enter a valid shortcut and condition.");
        await request(props.client, WS_METHODS.serverUpsertKeybinding, {
          ...next,
          ...(previous ? { replace: previous } : {}),
        });
        props.ui.notify("Server keybinding saved.");
      },
    });
  }
  props.ui.choose("Web and desktop keybindings", [
    { title: "Add keybinding", run: () => edit() },
    ...(props.state()?.config?.keybindings ?? []).map((binding) => {
      const value = editableKeybinding(binding);
      return {
        title: binding.command,
        description: `${value.key}${value.when ? ` · ${value.when}` : ""}`,
        run: () =>
          props.ui.choose(binding.command, [
            { title: "Edit shortcut and condition", run: () => edit(binding) },
            {
              title: "Remove customization",
              description: "Restore the built-in shortcut where one exists.",
              run: () =>
                props.ui.confirm(
                  "Remove keybinding customization",
                  binding.command,
                  async () => {
                    guard();
                    await request(props.client, WS_METHODS.serverRemoveKeybinding, value);
                    props.ui.notify("Keybinding customization removed.");
                  },
                  "Remove customization",
                ),
            },
          ]),
      };
    }),
  ]);
}
