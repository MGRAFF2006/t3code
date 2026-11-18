import {
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkTarget,
} from "@t3tools/shared/markdownLinks";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import type { FeatureProps } from "../ui/controller.ts";

export function messageLinks(text: string, cwd?: string) {
  let fence: string | undefined;
  const prose = text
    .split(/\r?\n/)
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          marker &&
          marker[1] &&
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          !marker[2]?.trim()
        )
          fence = undefined;
        return "";
      }
      if (marker?.[1]) {
        fence = marker[1];
        return "";
      }
      return line;
    })
    .join("\n");
  const candidates = [
    ...extractMarkdownLinkHrefs(prose),
    ...extractInlineCodeSpans(prose).flatMap((value) => {
      const path = inlineCodeFilePathCandidate(value);
      return path ? [path] : [];
    }),
  ];
  const links = new Map<string, { title: string; url?: string; path?: string; line?: number }>();
  for (const candidate of candidates) {
    const href = normalizeMarkdownLinkDestination(candidate);
    const path = resolveMarkdownFileLinkTarget(href, cwd);
    if (path) {
      const location = splitFilePathPosition(path);
      links.set(path, {
        title: path,
        path: location.path,
        ...(location.line ? { line: location.line } : {}),
      });
    } else {
      try {
        const url = new URL(href);
        if (url.protocol === "http:" || url.protocol === "https:")
          links.set(url.href, { title: url.href, url: url.href });
      } catch {
        continue;
      }
    }
  }
  return [...links.values()];
}

export function messageLinkActions(props: FeatureProps, entry: OrchestrationV2ProjectedTurnItem) {
  if (entry.item.type !== "user_message" && entry.item.type !== "assistant_message") return;
  const environment = props.state()?.environmentId;
  const thread = props.state()?.thread?.thread;
  const project = props.state()?.shell?.projects.find((value) => value.id === thread?.projectId);
  const cwd = thread?.worktreePath ?? project?.workspaceRoot ?? props.state()?.config?.cwd;
  const links = messageLinks(entry.item.text, cwd);
  if (!links.length) {
    props.ui.notify("This message has no supported file or web links.");
    return;
  }
  props.ui.choose(
    "Message links",
    links.map((link) => ({
      title: link.title,
      description: link.path
        ? `Open on the source environment${link.line ? ` · line ${link.line}` : ""}`
        : "Open in this device's browser",
      run: () => {
        if (
          props.state()?.environmentId !== environment ||
          props.state()?.thread?.thread.id !== thread?.id
        ) {
          props.ui.notify("The conversation changed. Open its links again.", true);
          return;
        }
        if (link.path) props.ui.openFile(link.path, link.line);
        else if (link.url) props.ui.openBrowser?.(link.url);
      },
    })),
  );
}
