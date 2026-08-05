import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Two directories deep on purpose: the CLI reads package.json and the
    // staged spec/openapi.yaml at "../../", which resolves to the package root
    // from dist/cli/ and from src/cli/ alike. A flat dist/cli.js would break
    // both lookups.
    "cli/index": "src/cli/index.ts",
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
  // Keep external: e2b has protobuf that breaks when bundled, AWS SDK is optional peer dep
  external: [
    "@evolvingmachines/e2b",
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
  ],
});
