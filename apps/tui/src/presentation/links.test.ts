import { describe, expect, it } from "vite-plus/test";
import { messageLinks } from "./links.ts";

describe("terminal message links", () => {
  it("resolves source files with positions, preserves web links, and skips executable schemes and code examples", () => {
    const links = messageLinks(
      "[file](src/main.ts:12) and [again](src/main.ts:12), [web](https://example.test/docs), [unsafe](javascript:alert)\n`src/other.ts`\n```md\n[example](src/ignored.ts)\n```",
      "/workspace/project",
    );
    expect(links).toEqual([
      {
        title: "/workspace/project/src/main.ts:12",
        path: "/workspace/project/src/main.ts",
        line: 12,
      },
      { title: "https://example.test/docs", url: "https://example.test/docs" },
      { title: "/workspace/project/src/other.ts", path: "/workspace/project/src/other.ts" },
    ]);
  });
});
