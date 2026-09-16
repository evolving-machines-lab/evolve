// Stage the repo's skill-data/ into the package so npm ships it: the bundled
// skills `evolve skills` serves (their home is the repo root, generated and
// hand-written there; scripts/generate-skills.ts). Runs on every build and
// every pack, and rebuilds the staged copy from scratch each time, so the CLI
// serves what the last build saw and a stale copy can never ship. The staged
// copy is gitignored; a checkout that has never built has none, and the CLI
// then serves the repo root's skill-data/ directly (skills.ts).
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "..", "..", "skill-data");
const staged = join(packageRoot, "skill-data");

if (!existsSync(source)) {
  throw new Error(`skill-data has no source at ${source} — run npm run generate:skills at the repo root first`);
}
rmSync(staged, { recursive: true, force: true });
cpSync(source, staged, { recursive: true });
