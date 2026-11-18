import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { terminalOutputPlainText } from "@t3tools/shared/terminalOutput";

const NotebookText = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const NotebookOutput = Schema.Struct({
  text: Schema.optionalKey(NotebookText),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  traceback: Schema.optionalKey(Schema.Array(Schema.String)),
});
const Notebook = Schema.Struct({
  nbformat: Schema.Literal(4),
  metadata: Schema.optionalKey(
    Schema.Struct({
      language_info: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
    }),
  ),
  cells: Schema.Array(
    Schema.Struct({
      cell_type: Schema.Literals(["markdown", "code", "raw"]),
      source: NotebookText,
      outputs: Schema.optionalKey(Schema.Array(NotebookOutput).check(Schema.isMaxLength(100))),
    }),
  ).check(Schema.isMaxLength(500)),
});
const decodeNotebook = Schema.decodeUnknownOption(Notebook);
const decodeText = Schema.decodeUnknownOption(NotebookText);
const MAX_NOTEBOOK_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const textValue = (value: unknown) => {
  const decoded = decodeText(value);
  return Option.isSome(decoded)
    ? typeof decoded.value === "string"
      ? decoded.value
      : decoded.value.join("")
    : "";
};

export function notebookPreview(contents: string) {
  if (new TextEncoder().encode(contents).length > MAX_NOTEBOOK_BYTES)
    throw new Error(
      "Notebook preview is limited to 8 MiB. Show source or open an external viewer.",
    );
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch {
    throw new Error("This notebook is incomplete or invalid JSON. Show source to inspect it.");
  }
  const decoded = decodeNotebook(json);
  if (Option.isNone(decoded))
    throw new Error(
      "Preview requires a version 4 notebook with at most 500 cells and 100 outputs per cell.",
    );
  const notebook = decoded.value;
  return {
    language:
      (notebook.metadata?.language_info?.name ?? "text")
        .replaceAll(/[^a-z\d+#-]/gi, "")
        .slice(0, 40) || "text",
    cells: notebook.cells.map((cell) => ({
      kind: cell.cell_type,
      source: textValue(cell.source),
      outputs: (cell.outputs ?? [])
        .map((output) => {
          const data = output.data ?? {};
          for (const mimeType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
            const base64 = textValue(data[mimeType]).replaceAll(/\s/g, "");
            if (
              base64 &&
              base64.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 &&
              /^[a-z\d+/]*={0,2}$/i.test(base64)
            )
              return { kind: "image" as const, mimeType, base64 };
          }
          const text = terminalOutputPlainText(
            textValue(output.text ?? data["text/plain"] ?? output.traceback?.join("\n")),
          );
          return {
            kind: "text" as const,
            text:
              text ||
              (Object.keys(data).some((mime) => mime !== "text/plain")
                ? "Rich output is available in notebook source or an external viewer."
                : ""),
          };
        })
        .filter((output) => output.kind === "image" || output.text.length > 0),
    })),
  };
}

export function notebookImageBytes(base64: string) {
  if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    throw new Error("This notebook image exceeds the preview limit.");
  try {
    const decoded = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    if (decoded.length > MAX_IMAGE_BYTES) throw new Error("oversize");
    return decoded;
  } catch {
    throw new Error("This notebook image is invalid or exceeds the preview limit.");
  }
}

export function hexPreview(bytes: Uint8Array) {
  const sample = bytes.subarray(0, 4096);
  const lines = [
    `Showing ${sample.length} of ${bytes.length} bytes${sample.length < bytes.length ? " (preview truncated)" : ""}.`,
    "",
  ];
  for (let offset = 0; offset < sample.length; offset += 16) {
    const row = sample.subarray(offset, offset + 16);
    const hex = [...row]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(47, " ");
    const printable = [...row]
      .map((value) => (value >= 32 && value <= 126 ? String.fromCharCode(value) : "."))
      .join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${printable}|`);
  }
  return lines.join("\n");
}
