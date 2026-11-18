import { RGBA, SyntaxStyle, type NativeResourceOwner } from "@opentui/core";
import { theme } from "./index.ts";

export function createSyntax(owner: NativeResourceOwner) {
  return SyntaxStyle.fromStyles(
    {
      default: { fg: RGBA.fromHex(theme.text) },
      "markup.heading": { fg: RGBA.fromHex(theme.markdownHeading), bold: true },
      "markup.strong": { fg: RGBA.fromHex(theme.markdownStrong), bold: true },
      "markup.bold": { fg: RGBA.fromHex(theme.markdownStrong), bold: true },
      "markup.italic": { fg: RGBA.fromHex(theme.markdownEmph), italic: true },
      "markup.raw": { fg: RGBA.fromHex(theme.markdownCode) },
      "markup.link": { fg: RGBA.fromHex(theme.markdownLink), underline: true },
      "markup.quote": { fg: RGBA.fromHex(theme.markdownBlockQuote) },
      comment: { fg: RGBA.fromHex(theme.syntaxComment) },
      keyword: { fg: RGBA.fromHex(theme.syntaxKeyword) },
      string: { fg: RGBA.fromHex(theme.syntaxString) },
      number: { fg: RGBA.fromHex(theme.syntaxNumber) },
      "diff.plus": { fg: RGBA.fromHex(theme.diffAdded) },
      "diff.minus": { fg: RGBA.fromHex(theme.diffRemoved) },
    },
    owner,
  );
}
