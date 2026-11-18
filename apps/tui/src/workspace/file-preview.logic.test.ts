import { describe, expect, it } from "vite-plus/test";
import { hexPreview, notebookImageBytes, notebookPreview } from "./file-preview.logic.ts";

describe("native notebook preview", () => {
  it("preserves source and cached output order without executing rich content or remote image URLs", () => {
    const preview = notebookPreview(
      JSON.stringify({
        nbformat: 4,
        metadata: { language_info: { name: "python" } },
        cells: [
          { cell_type: "markdown", source: ["# Analysis\n", "Saved notes"] },
          {
            cell_type: "code",
            source: ["print(1)\n"],
            outputs: [
              { text: ["1", "\n"] },
              { traceback: ["\u001b[31mValueError\u001b[0m", "line 2"] },
              { data: { "image/png": "iVBORw0KGgo=" } },
              {
                data: {
                  "text/html": "<script>throw Error('not executed')</script>",
                  "application/javascript": "throw Error('not executed')",
                },
              },
              { data: { "image/png": "https://example.test/image.png" } },
            ],
          },
          { cell_type: "raw", source: "raw cell" },
        ],
      }),
    );
    expect(preview.language).toBe("python");
    expect(preview.cells.map((cell) => [cell.kind, cell.source])).toEqual([
      ["markdown", "# Analysis\nSaved notes"],
      ["code", "print(1)\n"],
      ["raw", "raw cell"],
    ]);
    expect(preview.cells[1]?.outputs).toEqual([
      { kind: "text", text: "1\n" },
      { kind: "text", text: "ValueError\nline 2" },
      { kind: "image", mimeType: "image/png", base64: "iVBORw0KGgo=" },
      { kind: "text", text: "Rich output is available in notebook source or an external viewer." },
      { kind: "text", text: "Rich output is available in notebook source or an external viewer." },
    ]);
    expect([...notebookImageBytes("iVBORw0KGgo=")]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(() => notebookImageBytes("https://example.test/image.png")).toThrow("invalid");
  });

  it("rejects unsupported/incomplete notebooks and bounds cell, output and image memory", () => {
    expect(() => notebookPreview('{"nbformat":4,"cells":[')).toThrow("incomplete");
    expect(() => notebookPreview('{"nbformat":3,"cells":[]}')).toThrow("version 4");
    expect(() =>
      notebookPreview(
        JSON.stringify({
          nbformat: 4,
          cells: Array.from({ length: 501 }, () => ({ cell_type: "raw", source: "" })),
        }),
      ),
    ).toThrow("500 cells");
    expect(() =>
      notebookPreview(
        JSON.stringify({
          nbformat: 4,
          cells: [
            {
              cell_type: "code",
              source: "",
              outputs: Array.from({ length: 101 }, () => ({ text: "" })),
            },
          ],
        }),
      ),
    ).toThrow("100 outputs");
    expect(() => notebookPreview(" ".repeat(8 * 1024 * 1024 + 1))).toThrow("8 MiB");
    expect(() => notebookImageBytes("a".repeat(6 * 1024 * 1024))).toThrow("limit");
  });
});

it("shows exact bytes, printable ASCII and offsets in a bounded hex sample", () => {
  const bytes = Uint8Array.from([
    0,
    65,
    66,
    10,
    127,
    255,
    ...Array.from({ length: 20 }, (_, index) => index + 32),
  ]);
  const text = hexPreview(bytes);
  expect(text).toContain("Showing 26 of 26 bytes.");
  expect(text).toContain("00000000  00 41 42 0a 7f ff");
  expect(text).toContain("|.AB... !\"#$%&'()|");
  expect(text).toContain("00000010");
  const limited = hexPreview(new Uint8Array(4097));
  expect(limited).toContain("Showing 4096 of 4097 bytes (preview truncated)");
  expect(limited).not.toContain("00001000");
});
