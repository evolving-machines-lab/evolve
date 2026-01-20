import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  outDir: "dist",
  treeshake: true,
  // Inline .md files as strings at build time
  loader: {
    ".md": "text",
  },
  // Keep @evolvingmachines/e2b as external - it has protobuf code that breaks when bundled
  external: ["@evolvingmachines/e2b"],
});
