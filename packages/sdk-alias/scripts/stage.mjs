// Stage the two JSON artifacts the real package publishes at its root, so the
// alias serves them at the same paths: harness-capabilities.json is an
// exports subpath a consumer imports, hosted-error-codes.json is read by path
// under node_modules/@evolvingmachines/sdk. Both are copied byte for byte from
// packages/sdk-ts at pack time; the alias publishes in lockstep with the real
// package from one commit, so the copies cannot drift from it. The staged
// copies are gitignored and rebuilt on every pack.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const realPackage = join(packageRoot, "..", "sdk-ts");

for (const file of ["harness-capabilities.json", "hosted-error-codes.json"]) {
  copyFileSync(join(realPackage, file), join(packageRoot, file));
}
