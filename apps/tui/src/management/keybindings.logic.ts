import type {
  KeybindingShortcut,
  KeybindingWhenNode,
  ResolvedKeybindingRule,
} from "@t3tools/contracts";

const expression = (node: KeybindingWhenNode | undefined): string => {
  if (!node) return "";
  if (node.type === "identifier") return node.name;
  if (node.type === "not") return `!(${expression(node.node)})`;
  return `(${expression(node.left)}) ${node.type === "and" ? "&&" : "||"} (${expression(node.right)})`;
};
const shortcut = (value: KeybindingShortcut) =>
  [
    value.modKey ? "mod" : null,
    value.metaKey ? "meta" : null,
    value.ctrlKey ? "ctrl" : null,
    value.altKey ? "alt" : null,
    value.shiftKey ? "shift" : null,
    value.key === " " ? "space" : value.key,
  ]
    .filter(Boolean)
    .join("+");

export function editableKeybinding(binding: ResolvedKeybindingRule) {
  const when = expression(binding.whenAst);
  return { key: shortcut(binding.shortcut), command: binding.command, ...(when ? { when } : {}) };
}
