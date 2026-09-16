// Stage the three skill folders from the repo root into the package so npm
// ships them: docs-evals/ (served as `evals`), docs-agents/ (`agents`) and
// skills/ (the pointer and the task-authoring skills), the same files the
// checkout serves (src/cli/skills.ts). Only what an agent reads is staged
// from a docs folder — docs.json and every .md/.mdx page — never the site's
// assets (images, logo, favicon, stylesheet, script), its Nextra config or
// the generator's source; skills/ is staged whole. Runs on every build and
// every pack and rebuilds
// each staged copy from scratch, so the CLI serves what the last build saw
// and a stale copy can never ship. The staged copies are gitignored; a
// checkout that has never built has none, and the CLI then serves the repo
// root directly.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");

/** The files of a docs folder an agent reads: the site config and the pages; the
 *  generator's hand-written source is neither (the CLI never serves it). */
const isDocsFile = (name) => name === "docs.json" || (name !== "SKILL.source.md" && (name.endsWith(".md") || name.endsWith(".mdx")));

const FOLDERS = [
  { name: "docs-evals", keep: isDocsFile },
  { name: "docs-agents", keep: isDocsFile },
  { name: "skills", keep: () => true },
];

function stage(source, target, keep) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) stage(from, to, keep);
    else if (entry.isFile() && keep(entry.name)) {
      mkdirSync(target, { recursive: true });
      copyFileSync(from, to);
    }
  }
}

for (const { name, keep } of FOLDERS) {
  const source = join(repoRoot, name);
  if (!existsSync(source)) throw new Error(`${name}/ has no source at ${source}`);
  const staged = join(packageRoot, name);
  rmSync(staged, { recursive: true, force: true });
  stage(source, staged, keep);
}
