import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { dedupe: ["vite-plus", "@effect/vitest"] },
  test: {
    name: "tui",
    environment: "node",
    include: ["src/**/*.test.ts"],
    server: { deps: { inline: ["@effect/vitest"] } },
    setupFiles: [
      "../../packages/shared/src/testing/longTempDir.ts",
      "../../packages/shared/src/testing/providerEnv.ts",
    ],
  },
});
