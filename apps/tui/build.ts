import solid from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "bun",
  plugins: [solid],
  packages: "external",
  sourcemap: "external",
});
if (!result.success) throw new AggregateError(result.logs, "Could not build the terminal client.");
