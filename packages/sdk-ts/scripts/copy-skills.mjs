// Stage the repo's skills/ into the package so npm ships it: the skills
// `evolve skills` serves (src/cli/skills.ts) — the pointer, the generated
// evals skill with its page copies, the task-authoring skills — the same files
// the checkout serves. skills/evolve-agents is not staged: the CLI does not
// serve the SDK skill (the command is for evals); it installs from the
// repository. Runs on every build and every pack and rebuilds the staged copy
// from scratch, so the CLI serves what the last build saw and a stale copy can
// never ship. The staged copy is gitignored; a checkout that has never built
// has none, and the CLI then serves the repo root's skills/ directly.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "..", "..", "skills");
const staged = join(packageRoot, "skills");

/** The one folder under skills/ the package leaves out. */
const NOT_SHIPPED = "evolve-agents";

if (!existsSync(source)) throw new Error(`skills/ has no source at ${source}`);
rmSync(staged, { recursive: true, force: true });
cpSync(source, staged, {
  recursive: true,
  filter: (path) => dirname(path) !== source || !path.endsWith(`/${NOT_SHIPPED}`),
});
