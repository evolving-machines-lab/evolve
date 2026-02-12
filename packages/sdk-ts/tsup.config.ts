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
  // Keep external: e2b has protobuf that breaks when bundled, AWS SDK is optional peer dep
  external: [
    "@evolvingmachines/e2b",
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
  ],
});
