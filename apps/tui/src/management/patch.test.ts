import { describe, expect, it } from "vite-plus/test";
import { patchFiles } from "./patch.ts";

describe("pull request file slices", () => {
  it("keeps file hunks separate and uses the surviving path for additions and deletions", () => {
    const added =
      "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n";
    const deleted =
      "diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
    expect(patchFiles(added + deleted)).toEqual([
      { path: "new.ts", patch: added },
      { path: "old.ts", patch: deleted },
    ]);
  });

  it("decodes Git-quoted names and preserves rename-only and binary changes", () => {
    const quoted =
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1 @@\n-a\n+b\n';
    expect(patchFiles(quoted)[0]?.path).toBe("café.ts");
    const rename =
      "diff --git a/first.txt b/second name.txt\nsimilarity index 100%\nrename from first.txt\nrename to second name.txt\n";
    expect(patchFiles(rename)[0]?.path).toBe("second name.txt");
    const binary =
      "diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n";
    expect(patchFiles(binary)[0]).toEqual({ path: "image.png", patch: binary });
    const spacedBinary =
      "diff --git a/logo b/large image.png b/logo b/large image.png\nBinary files a/logo b/large image.png and b/logo b/large image.png differ\n";
    expect(patchFiles(spacedBinary)[0]?.path).toBe("logo b/large image.png");
    const quotedBinary =
      'diff --git "a/caf\\303\\251.png" "b/caf\\303\\251.png"\nBinary files "a/caf\\303\\251.png" and "b/caf\\303\\251.png" differ\n';
    expect(patchFiles(quotedBinary)[0]?.path).toBe("café.png");
  });
});
