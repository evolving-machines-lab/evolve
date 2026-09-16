#!/usr/bin/env tsx
/**
 * Generates the skills folder from the docs — one source, generated copies.
 *
 * Inputs (the ONLY things this script reads):
 *   docs/SKILL.md, docs/typescript/0[1-5]-*.md, docs/python/0[1-5]-*.md
 *     -> skills/evolve-agents/        the SDK skill; chapter 06 (hosted evals)
 *                                     is the evolve-evals skill's ground, not this one's
 *   docs-mintlify/SKILL.md (front matter only), docs-mintlify/docs.json,
 *   every docs-mintlify/** /*.mdx
 *     -> skills/evolve-evals/         the hosted-evals skill: every page copied
 *                                     byte for byte under references/, and a
 *                                     SKILL.md whose index follows docs.json's
 *                                     navigation (tab -> group -> page title ->
 *                                     one-line description from the page's front matter)
 *   skills/<name>/ for EVERY folder under skills/ (generated or hand-written)
 *     -> .claude/skills/<name>/       the mirror: copies, never symlinks
 *     -> skills-lock.json             the `skills` CLI's project lock (npx skills add),
 *                                     same hash recipe as the CLI's local-lock.ts
 *
 * Usage:
 *   npm run generate:skills            # write the generated copies
 *   npm run generate:skills -- --check # exit 1 naming every stale, missing or extra file
 *
 * Deterministic: the same inputs produce the same bytes — file lists are
 * sorted, nothing is timestamped, no environment is read. The workflow
 * .github/workflows/sync-docs-to-skill.yml runs --check on pull requests and
 * regenerates + commits on pushes to main and project-sable.
 *
 * Dependencies: `tsx` (a root devDependency) and `yaml` (a dependency of
 * packages/sdk-ts, hoisted to the root node_modules by the workspace lock —
 * the same way the root `generate:image-version` script finds tsx).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const SITE = join(ROOT, "docs-mintlify");
const SKILLS = join(ROOT, "skills");
const MIRROR = join(ROOT, ".claude", "skills");
const LOCK = join(ROOT, "skills-lock.json");

const AGENTS_SKILL = "evolve-agents";
const EVALS_SKILL = "evolve-evals";
const GENERATED_SKILLS = [AGENTS_SKILL, EVALS_SKILL] as const;
/** Chapters 01–05 are the SDK; 06 (hosted evals) belongs to evolve-evals. */
const AGENT_CHAPTERS = /^0[1-5]-.*\.md$/;
const LANGUAGES = ["typescript", "python"] as const;
/** The lock's `source`: what `npx skills add` is told. */
const LOCK_SOURCE = "evolving-machines-lab/evolve";

/** The generated body of skills/evolve-evals/SKILL.md, above the index. */
const EVALS_PREAMBLE = `# Evolve hosted evals

Hosted evaluation for agents: datasets of Harbor-format tasks, jobs that run any model on any agent harness against them in cloud sandboxes, and the trials, checks and analyses they produce — from the \`evolve\` CLI and the TypeScript and Python SDKs.

The pages under \`references/\` are the documentation site's pages, byte for byte, at the site's paths: a site link to \`/core-concepts/tasks\` is \`references/core-concepts/tasks.mdx\`. An \`import\` of \`/snippets/<file>\` is \`references/snippets/<file>\`.

## How to use this skill

1. Find the topic in the index below and read that page before writing any command or code.
2. Every CLI verb is documented from its own \`--help\`; run \`evolve <verb> --help\` to confirm the flags of the installed version.
3. Every command and every SDK client reads \`EVOLVE_API_KEY\`; the Installation page says where the key comes from.

## Topic index
`;

// ---------------------------------------------------------------------------
// Files

/** Repo-relative path with forward slashes. */
function relPath(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/** Every regular file under dir, absolute, sorted, recursive. `.git` and
 *  `node_modules` are never entered (the `skills` CLI skips them too) and
 *  `.DS_Store` is never listed: git never tracks it, so a local one would only
 *  put a hash into the lock that a clean checkout cannot reproduce. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        visit(p);
      } else if (entry.isFile() && entry.name !== ".DS_Store") {
        out.push(p);
      }
    }
  };
  if (existsSync(dir)) visit(dir);
  return out.sort();
}

function readBytes(p: string): Buffer {
  return readFileSync(p);
}

function readText(p: string): string {
  return readFileSync(p, "utf8");
}

// ---------------------------------------------------------------------------
// Front matter

type FrontMatter = { data: Record<string, unknown>; body: string };

/** Splits a `---` YAML front matter block off a Markdown/MDX document. */
function frontMatter(text: string, where: string): FrontMatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${where}: no YAML front matter block at the top of the file`);
  const data = parseYaml(m[1]);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${where}: front matter must be a YAML mapping`);
  }
  return { data: data as Record<string, unknown>, body: m[2] };
}

function requireString(data: Record<string, unknown>, key: string, where: string): string {
  const v = data[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`${where}: front matter needs a non-empty string "${key}"`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// evolve-agents: docs/SKILL.md + chapters 01–05 of both languages

function agentsSkill(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  files.set("SKILL.md", readBytes(join(DOCS, "SKILL.md")));
  for (const lang of LANGUAGES) {
    const chapters = readdirSync(join(DOCS, lang)).filter((n) => AGENT_CHAPTERS.test(n)).sort();
    if (chapters.length === 0) throw new Error(`docs/${lang}: no chapters matching ${AGENT_CHAPTERS}`);
    for (const name of chapters) {
      files.set(`references/${lang}/${name}`, readBytes(join(DOCS, lang, name)));
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// evolve-evals: docs-mintlify pages + an index generated from docs.json

type NavGroup = { group: string; pages: NavPage[] };
type NavPage = string | NavGroup;
type NavSection = { heading: string | null; groups: NavGroup[] };

/** docs.json navigation as tabs of groups, or top-level groups. Any other
 *  Mintlify navigation shape (anchors, versions, languages, dropdowns) is a
 *  loud refusal, never a silent empty index. */
function navigationSections(nav: unknown): NavSection[] {
  const n = nav as { tabs?: unknown; groups?: unknown };
  if (Array.isArray(n.tabs)) {
    return n.tabs.map((t: { tab?: unknown; groups?: unknown; pages?: unknown }, i: number) => {
      if (typeof t.tab !== "string") throw new Error(`docs.json navigation.tabs[${i}]: missing "tab"`);
      if (Array.isArray(t.groups)) return { heading: t.tab, groups: t.groups as NavGroup[] };
      if (Array.isArray(t.pages)) return { heading: t.tab, groups: [{ group: t.tab, pages: t.pages as NavPage[] }] };
      throw new Error(`docs.json navigation.tabs[${i}] ("${t.tab}"): needs "groups" or "pages"`);
    });
  }
  if (Array.isArray(n.groups)) return [{ heading: null, groups: n.groups as NavGroup[] }];
  throw new Error(
    "docs.json: navigation must be tabs[] of groups[] or a top-level groups[]; scripts/generate-skills.ts supports nothing else",
  );
}

/** A table cell: one line, pipes escaped. */
function cell(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

function renderGroup(group: NavGroup, depth: number, out: string[]): void {
  if (typeof group.group !== "string" || !Array.isArray(group.pages)) {
    throw new Error(`docs.json: a navigation group needs "group" and "pages" (${JSON.stringify(group)})`);
  }
  out.push(`${"#".repeat(depth)} ${group.group}`, "", "| Page | What it covers |", "| --- | --- |");
  const nested: NavGroup[] = [];
  for (const page of group.pages) {
    if (typeof page !== "string") {
      nested.push(page);
      continue;
    }
    const file = join(SITE, `${page}.mdx`);
    if (!existsSync(file)) throw new Error(`docs.json names page "${page}" but docs-mintlify/${page}.mdx does not exist`);
    const { data } = frontMatter(readText(file), `docs-mintlify/${page}.mdx`);
    const title = requireString(data, "title", `docs-mintlify/${page}.mdx`);
    const description = requireString(data, "description", `docs-mintlify/${page}.mdx`);
    out.push(`| [${cell(title)}](references/${page}.mdx) | ${cell(description)} |`);
  }
  out.push("");
  for (const g of nested) renderGroup(g, depth + 1, out);
}

function renderEvalsIndex(): string {
  const docsJson = JSON.parse(readText(join(SITE, "docs.json"))) as { navigation?: unknown };
  const out: string[] = [];
  for (const section of navigationSections(docsJson.navigation)) {
    if (section.heading !== null) out.push(`## ${section.heading}`, "");
    for (const group of section.groups) renderGroup(group, section.heading === null ? 2 : 3, out);
  }
  return out.join("\n");
}

/** docs-mintlify/SKILL.md holds the front matter and nothing else; the body
 *  below it is generated, so any hand-written body there would be lost. */
function evalsFrontMatter(): string {
  const text = readText(join(SITE, "SKILL.md"));
  const m = /^(---\r?\n[\s\S]*?\r?\n---)\s*$/.exec(text);
  if (!m) {
    throw new Error(
      "docs-mintlify/SKILL.md must contain the front matter block only (---…---); its body is generated by scripts/generate-skills.ts",
    );
  }
  return m[1].replace(/\r\n/g, "\n") + "\n";
}

function evalsSkill(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const pages = walkFiles(SITE).filter((p) => p.endsWith(".mdx"));
  if (pages.length === 0) throw new Error("docs-mintlify: no .mdx pages found");
  for (const p of pages) files.set(`references/${relPath(SITE, p)}`, readBytes(p));
  files.set("SKILL.md", Buffer.from(evalsFrontMatter() + "\n" + EVALS_PREAMBLE + "\n" + renderEvalsIndex(), "utf8"));
  return files;
}

// ---------------------------------------------------------------------------
// Every skill: the mirror and the lock

/** The `skills` CLI's own recipe (vercel-labs/skills src/local-lock.ts
 *  computeSkillFolderHash): every file of the folder, sorted by relative path
 *  with localeCompare, sha256 over path then content, so a rename is a change. */
function skillFolderHash(files: Map<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const p of [...files.keys()].sort((a, b) => a.localeCompare(b))) {
    hash.update(p);
    hash.update(files.get(p)!);
  }
  return hash.digest("hex");
}

function handWrittenSkill(name: string): Map<string, Buffer> {
  const dir = join(SKILLS, name);
  const files = new Map<string, Buffer>();
  for (const p of walkFiles(dir)) files.set(relPath(dir, p), readBytes(p));
  if (!files.has("SKILL.md")) throw new Error(`skills/${name}: no SKILL.md`);
  return files;
}

type Expected = Map<string, Buffer>; // repo-relative path -> bytes

/** Everything the generator owns, as it must be on disk. */
function expectedOutput(): { expected: Expected; skillNames: string[] } {
  const skills = new Map<string, Map<string, Buffer>>();
  skills.set(AGENTS_SKILL, agentsSkill());
  skills.set(EVALS_SKILL, evalsSkill());
  const onDisk = existsSync(SKILLS)
    ? readdirSync(SKILLS, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !(GENERATED_SKILLS as readonly string[]).includes(d.name))
        .map((d) => d.name)
    : [];
  for (const name of onDisk) skills.set(name, handWrittenSkill(name));

  const skillNames = [...skills.keys()].sort();
  const expected: Expected = new Map();
  const lock: Record<string, { source: string; sourceType: string; skillPath: string; computedHash: string }> = {};
  for (const name of skillNames) {
    const files = skills.get(name)!;
    // Invariant: a skill's front matter name is its folder name — the name
    // agents and the `skills` CLI address it by.
    const { data } = frontMatter(files.get("SKILL.md")!.toString("utf8"), `skills/${name}/SKILL.md`);
    const declared = requireString(data, "name", `skills/${name}/SKILL.md`);
    requireString(data, "description", `skills/${name}/SKILL.md`);
    if (declared !== name) throw new Error(`skills/${name}/SKILL.md: front matter name "${declared}" must equal the folder name`);

    const generated = (GENERATED_SKILLS as readonly string[]).includes(name);
    for (const [p, bytes] of files) {
      if (generated) expected.set(`skills/${name}/${p}`, bytes);
      expected.set(`.claude/skills/${name}/${p}`, bytes);
    }
    lock[name] = {
      source: LOCK_SOURCE,
      sourceType: "github",
      skillPath: `skills/${name}/SKILL.md`,
      computedHash: skillFolderHash(files),
    };
  }
  expected.set("skills-lock.json", Buffer.from(JSON.stringify({ version: 1, skills: lock }, null, 2) + "\n", "utf8"));
  return { expected, skillNames };
}

/** The roots this script owns outright: everything under them is generated. */
function generatedRoots(): string[] {
  return [...GENERATED_SKILLS.map((n) => join(SKILLS, n)), MIRROR, LOCK];
}

function check(expected: Expected): number {
  const problems: string[] = [];
  const actual = new Set<string>();
  for (const root of generatedRoots()) {
    if (!existsSync(root)) continue;
    const files = root === LOCK ? [root] : walkFiles(root);
    for (const p of files) actual.add(relPath(ROOT, p));
  }
  for (const [p, bytes] of expected) {
    if (!actual.has(p)) problems.push(`missing  ${p}`);
    else if (!readBytes(join(ROOT, p)).equals(bytes)) problems.push(`stale    ${p}`);
  }
  for (const p of actual) if (!expected.has(p)) problems.push(`extra    ${p}`);
  if (problems.length > 0) {
    console.error(
      "The generated skills are out of date with their sources (docs/, docs-mintlify/, skills/):\n  " +
        problems.sort().join("\n  ") +
        "\nRun: npm run generate:skills  and commit the result.",
    );
    return 1;
  }
  console.log(`skills/, .claude/skills/ and skills-lock.json match their sources (${expected.size} files)`);
  return 0;
}

function write(expected: Expected, skillNames: string[]): void {
  for (const root of generatedRoots()) rmSync(root, { recursive: true, force: true });
  for (const [p, bytes] of expected) {
    const abs = join(ROOT, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  console.log(`wrote ${expected.size} files for ${skillNames.length} skills: ${skillNames.join(", ")}`);
}

function main(): void {
  const { expected, skillNames } = expectedOutput();
  if (process.argv.includes("--check")) process.exit(check(expected));
  write(expected, skillNames);
}

main();
