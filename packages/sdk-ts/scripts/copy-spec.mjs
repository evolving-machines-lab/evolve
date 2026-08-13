// Stage the API contract into the package so npm ships it. The contract's
// home is the PRIVATE server repo (swarm_dashboard, spec/openapi.yaml) — the
// YAML is not a free download, so this public tree carries no copy. The
// openapi source resolves from EVOLVE_OPENAPI_SPEC_PATH (private CI points it
// at a sparse checkout of the server repo), falling back to a legacy
// repo-root spec/openapi.yaml for checkouts that still carry one. Downstream
// drift gates read the published copies, so a package without them cannot be
// checked. The staged copies are gitignored — regenerated on every build.
//
// Two artifacts ride along: spec/openapi.yaml (the HTTP contract) and
// spec/atif/ (the generated ATIF trajectory JSON Schema + its provenance
// README, which DOES live in this repo), which the server repo's ATIF drift
// gate compares byte-for-byte against the installed package.
//
// When no openapi source exists, an ordinary build skips the staging with a
// notice (the public tree without the env var — the spec-gate tests skip
// themselves the same way), but a PACK refuses: a published package without
// the contract would break the CLI's -c validation and every downstream gate.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const specRoot = join(packageRoot, "..", "..", "spec");

const envPath = process.env.EVOLVE_OPENAPI_SPEC_PATH;
if (envPath && !existsSync(envPath)) {
  throw new Error(`EVOLVE_OPENAPI_SPEC_PATH points at nothing: ${envPath}`);
}
const openapiSource = envPath ?? join(specRoot, "openapi.yaml");

mkdirSync(join(packageRoot, "spec"), { recursive: true });
if (existsSync(openapiSource)) {
  cpSync(openapiSource, join(packageRoot, "spec", "openapi.yaml"));
} else if (process.env.npm_lifecycle_event === "prepack") {
  throw new Error(
    "spec/openapi.yaml has no source — a published package must carry the contract; set EVOLVE_OPENAPI_SPEC_PATH"
  );
} else {
  console.log(
    "copy-spec: openapi.yaml not staged — spec not present (the contract lives in the private server repo; set EVOLVE_OPENAPI_SPEC_PATH)"
  );
}
cpSync(join(specRoot, "atif"), join(packageRoot, "spec", "atif"), { recursive: true });
