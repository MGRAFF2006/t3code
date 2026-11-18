import { RGBA, SyntaxStyle, type NativeResourceOwner } from "@opentui/core";
import { createEffect, on } from "solid-js";
import { theme, themeMode } from "./index.ts";

export function createSyntax(owner: NativeResourceOwner) {
  const definitions = () => ({
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
  });
  const syntax = SyntaxStyle.fromStyles(definitions(), owner);
  // Native syntax resources keep their identity while their palette changes.
  createEffect(
    on(
      themeMode,
      () => {
        for (const [name, definition] of Object.entries(definitions()))
          syntax.registerStyle(name, definition);
      },
      { defer: true },
    ),
  );
  return syntax;
}
