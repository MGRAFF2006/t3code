export interface HtmlArtifact {
  readonly title: string;
  readonly html: string;
}

export function htmlArtifacts(markdown: string): ReadonlyArray<HtmlArtifact> {
  const result: HtmlArtifact[] = [];
  const lines = markdown.split(/\r?\n/);
  let fence: { marker: string; length: number; html: boolean; lines: string[] } | null = null;
  for (const line of lines) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]?.[0] === fence.marker && close[1].length >= fence.length) {
        if (fence.html && fence.lines.join("\n").trim())
          result.push({
            title: `HTML preview${result.length ? ` ${result.length + 1}` : ""}`,
            html: fence.lines.join("\n"),
          });
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^\n]*$/.exec(line);
    if (open?.[1])
      fence = {
        marker: open[1][0]!,
        length: open[1].length,
        html: /^(html|htm)$/i.test(open[2] ?? ""),
        lines: [],
      };
  }
  if (result.length === 0 && /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(markdown))
    result.push({ title: "HTML preview", html: markdown });
  return result;
}
