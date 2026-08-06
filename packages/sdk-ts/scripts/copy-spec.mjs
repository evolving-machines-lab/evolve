// Stage the API contract into the package so npm ships it. The repo-root
// spec/ is the single source of truth; this copy exists only because npm's
// files[] cannot reach above the package directory. Downstream drift gates
// read the published copies, so a package without them cannot be checked.
// The staged copies are gitignored — regenerated on every build.
//
// Two artifacts ride along: spec/openapi.yaml (the HTTP contract) and
// spec/atif/ (the generated ATIF trajectory JSON Schema + its provenance
// README), which the server repo's ATIF drift gate compares byte-for-byte
// against the installed package.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const specRoot = join(packageRoot, "..", "..", "spec");

mkdirSync(join(packageRoot, "spec"), { recursive: true });
cpSync(join(specRoot, "openapi.yaml"), join(packageRoot, "spec", "openapi.yaml"));
cpSync(join(specRoot, "atif"), join(packageRoot, "spec", "atif"), { recursive: true });
