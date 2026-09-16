// Stage the three skill folders from the repo root into the package so npm
// ships them: docs-evals/ (served as `evals`), docs-agents/ (`agents`) and
// skills/ (the pointer and the task-authoring skills), the same files the
// checkout serves (src/cli/skills.ts). Runs on every build and every pack and
// rebuilds each staged copy from scratch, so the CLI serves what the last build
// saw and a stale copy can never ship. The staged copies are gitignored; a
// checkout that has never built has none, and the CLI then serves the repo
// root directly.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");

for (const folder of ["docs-evals", "docs-agents", "skills"]) {
  const source = join(repoRoot, folder);
  if (!existsSync(source)) throw new Error(`${folder}/ has no source at ${source}`);
  const staged = join(packageRoot, folder);
  rmSync(staged, { recursive: true, force: true });
  cpSync(source, staged, { recursive: true });
}
