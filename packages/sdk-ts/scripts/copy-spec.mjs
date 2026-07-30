// Stage the API contract into the package so npm ships it. The repo-root
// spec/openapi.yaml is the single source of truth; this copy exists only
// because npm's files[] cannot reach above the package directory. Downstream
// drift gates read the published copy, so a package without it cannot be
// checked. The staged copy is gitignored — regenerated on every build.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "..", "..", "spec", "openapi.yaml");
const target = join(packageRoot, "spec", "openapi.yaml");

mkdirSync(dirname(target), { recursive: true });
cpSync(source, target);
