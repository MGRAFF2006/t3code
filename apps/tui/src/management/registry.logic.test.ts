import { describe, expect, it } from "vite-plus/test";
import { parseRegistryHeaders } from "./registry.logic.ts";

describe("agent endpoint headers", () => {
  it("preserves omitted headers and accepts only string-valued JSON objects without exposing malformed secrets", () => {
    expect(parseRegistryHeaders(" \n ")).toBeUndefined();
    expect(parseRegistryHeaders('{"Authorization":"Bearer token","X-Project":"demo"}')).toEqual({
      Authorization: "Bearer token",
      "X-Project": "demo",
    });
    for (const value of [
      '["private"]',
      "null",
      '{"Authorization":false}',
      '{"Authorization":"Bearer private-secret"',
    ]) {
      expect(() => parseRegistryHeaders(value)).toThrow(
        "Headers must be a JSON object with string values.",
      );
      try {
        parseRegistryHeaders(value);
      } catch (error) {
        expect(String(error)).not.toContain("private-secret");
      }
    }
  });
});
