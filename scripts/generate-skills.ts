#!/usr/bin/env tsx
/**
 * Generates the served skills from the docs — one source, generated copies.
 *
 * Two folders, two jobs:
 *   skills/evolve/SKILL.md   the pointer: hand-written, the one skill an agent
 *                            installs (`npx skills add evolving-machines-lab/evolve`,
 *                            or `evolve skills install`). It tells the agent to
 *                            load the content from the CLI.
 *   skill-data/<name>/       the content: what `evolve skills get <name>` prints
 *                            and what the npm package ships.
 *
 * Inputs (the ONLY things this script reads):
 *   docs/evolve-agents.SKILL.md, docs/typescript/0[1-5]-*.md, docs/python/0[1-5]-*.md
 *     -> skill-data/evolve-agents/   the SDK skill; chapter 06 (hosted evals)
 *                                    is the evolve-evals skill's ground, not this one's
 *   docs/evolve-evals.SKILL.md (front matter only), docs-mintlify/docs.json,
 *   every docs-mintlify/** /*.mdx
 *     -> skill-data/evolve-evals/    the hosted-evals skill: every page copied
 *                                    byte for byte under references/, and a
 *                                    SKILL.md whose index follows docs.json's
 *                                    navigation (tab -> group -> page title ->
 *                                    one-line description from the page's front matter)
 *   skills/evolve/SKILL.md
 *     -> skill-data/evolve/SKILL.md  the served copy: `evolve skills install`
 *                                    writes these bytes, so the checkout and the
 *                                    package serve the same file; the CLI hides
 *                                    it from `skills list` by its name
 *     -> .claude/skills/evolve/      the mirror an agent inside this repo sees
 *     -> skills-lock.json            the `skills` CLI's project lock (npx skills add),
 *                                    same hash recipe as the CLI's local-lock.ts
 *   skill-data/<name>/ for every other folder (create-task, rewardkit,
 *   create-adapter, publish): hand-written, edited in place, only validated here.
 *
 * The two hand-written sources under docs/ are deliberately NOT named SKILL.md:
 * the `skills` CLI treats every top-level folder holding a SKILL.md as a skill
 * and reads it before skills/, so docs/SKILL.md would be installed in place of
 * the pointer (measured 2026-09-15, skills CLI 1.5.26). skill-data/ is safe
 * from the same scan: its skills sit two levels down, and that CLI descends
 * only into skills/ and the agent folders (discoverSkills, skills CLI 1.5.26).
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
 * Dependencies: `tsx` and `yaml`, both root devDependencies (`yaml` at the
 * same version packages/sdk-ts pins).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const SITE = join(ROOT, "docs-mintlify");
const SKILL_DATA = join(ROOT, "skill-data");
const MIRROR = join(ROOT, ".claude", "skills");
const LOCK = join(ROOT, "skills-lock.json");

const POINTER = "evolve";
const POINTER_SOURCE = join(ROOT, "skills", POINTER, "SKILL.md");
/** The pointer is installed as-is into an agent's skill list, so it stays a stub. */
const POINTER_MAX_WORDS = 500;
/** The agentskills.io front matter the pointer may carry; anything else is an editor's slip. */
const POINTER_FIELDS = ["name", "description", "allowed-tools"] as const;

const AGENTS_SKILL = "evolve-agents";
const EVALS_SKILL = "evolve-evals";
const GENERATED_SKILLS = [AGENTS_SKILL, EVALS_SKILL] as const;
/** Chapters 01–05 are the SDK; 06 (hosted evals) belongs to evolve-evals. */
const AGENT_CHAPTERS = /^0[1-5]-.*\.md$/;
const LANGUAGES = ["typescript", "python"] as const;
/** The lock's `source`: what `npx skills add` is told. */
const LOCK_SOURCE = "evolving-machines-lab/evolve";

/** The generated body of skill-data/evolve-evals/SKILL.md, above the index. */
const EVALS_PREAMBLE = `# Evolve hosted evals

Hosted evaluation for agents: datasets of Harbor-format tasks, jobs that run any model on any agent harness against them in cloud sandboxes, and the trials, checks and analyses they produce — from the \`evolve\` CLI and the TypeScript and Python SDKs.

The pages under \`references/\` are the documentation site's pages, byte for byte, at the site's paths: a site link to \`/core-concepts/tasks\` is \`references/core-concepts/tasks.mdx\`, and \`evolve skills get evals core-concepts/tasks\` prints it. An \`import\` of \`/snippets/<file>\` is \`references/snippets/<file>\`.

## How to use this skill

1. Find the topic in the index below and read that page before writing any command or code: \`evolve skills get evals <page>\` prints it, the page named by its site path; \`evolve skills get evals --full\` prints every page.
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

/** Invariant of every skill folder: the front matter name is the folder name —
 *  the name agents and the `skills` CLI address it by. */
function requireSkillName(files: Map<string, Buffer>, folder: string, where: string): void {
  const skill = files.get("SKILL.md");
  if (!skill) throw new Error(`${where}: no SKILL.md`);
  const { data } = frontMatter(skill.toString("utf8"), `${where}/SKILL.md`);
  const declared = requireString(data, "name", `${where}/SKILL.md`);
  requireString(data, "description", `${where}/SKILL.md`);
  if (declared !== folder) throw new Error(`${where}/SKILL.md: front matter name "${declared}" must equal the folder name`);
}

// ---------------------------------------------------------------------------
/** A generated SKILL.md says so right after its front matter, for anyone who opens
 *  the file instead of reading CLAUDE.md. The reference pages carry no marker:
 *  they must stay byte-identical to their sources. */
function withGeneratedMarker(skill: Buffer, source: string): Buffer {
  const text = skill.toString("utf8");
  const end = text.indexOf("\n---", 3);
  if (!text.startsWith("---") || end < 0) throw new Error("generated SKILL.md must start with a front matter block");
  const cut = end + "\n---".length;
  const marker = `\n<!-- Generated by scripts/generate-skills.ts from ${source}. Do not edit; edit the source and run npm run generate:skills. -->`;
  return Buffer.from(text.slice(0, cut) + marker + text.slice(cut), "utf8");
}

// evolve-agents: docs/evolve-agents.SKILL.md + chapters 01–05 of both languages

function agentsSkill(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  files.set("SKILL.md", withGeneratedMarker(readBytes(join(DOCS, `${AGENTS_SKILL}.SKILL.md`)), `docs/${AGENTS_SKILL}.SKILL.md and docs/*/01-05`));
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

/** docs/evolve-evals.SKILL.md holds the front matter and nothing else; the
 *  body below it is generated, so any hand-written body there would be lost. */
function evalsFrontMatter(): string {
  const text = readText(join(DOCS, `${EVALS_SKILL}.SKILL.md`));
  const m = /^(---\r?\n[\s\S]*?\r?\n---)\s*$/.exec(text);
  if (!m) {
    throw new Error(
      `docs/${EVALS_SKILL}.SKILL.md must contain the front matter block only (---…---); its body is generated by scripts/generate-skills.ts`,
    );
  }
  return m[1].replace(/\r\n/g, "\n") + "\n";
}

function evalsSkill(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const pages = walkFiles(SITE).filter((p) => p.endsWith(".mdx"));
  if (pages.length === 0) throw new Error("docs-mintlify: no .mdx pages found");
  for (const p of pages) files.set(`references/${relPath(SITE, p)}`, readBytes(p));
  files.set("SKILL.md", withGeneratedMarker(Buffer.from(evalsFrontMatter() + "\n" + EVALS_PREAMBLE + "\n" + renderEvalsIndex(), "utf8"), "docs-mintlify/"));
  return files;
}

// ---------------------------------------------------------------------------
// The pointer: skills/evolve/SKILL.md, validated, then copied as it is

function pointerSkill(): Map<string, Buffer> {
  const where = `skills/${POINTER}/SKILL.md`;
  if (!existsSync(POINTER_SOURCE)) throw new Error(`${where}: missing — it is the hand-written pointer skill`);
  const bytes = readBytes(POINTER_SOURCE);
  const text = bytes.toString("utf8");
  const { data } = frontMatter(text, where);
  for (const key of Object.keys(data)) {
    if (!(POINTER_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`${where}: front matter field "${key}" is not one of ${POINTER_FIELDS.join(", ")}`);
    }
  }
  for (const key of POINTER_FIELDS) requireString(data, key, where);
  if (data.name !== POINTER) throw new Error(`${where}: front matter name must be "${POINTER}"`);
  const words = text.split(/\s+/).filter((w) => w !== "").length;
  if (words >= POINTER_MAX_WORDS) {
    throw new Error(`${where}: ${words} words — the pointer stays under ${POINTER_MAX_WORDS}; the content belongs in skill-data/`);
  }
  return new Map([["SKILL.md", bytes]]);
}

// ---------------------------------------------------------------------------
// Every skill: the served tree, the mirror and the lock

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
  const dir = join(SKILL_DATA, name);
  const files = new Map<string, Buffer>();
  for (const p of walkFiles(dir)) files.set(relPath(dir, p), readBytes(p));
  requireSkillName(files, name, `skill-data/${name}`);
  return files;
}

type Expected = Map<string, Buffer>; // repo-relative path -> bytes

/** Everything the generator owns, as it must be on disk. */
function expectedOutput(): { expected: Expected; skillNames: string[] } {
  const content = new Map<string, Map<string, Buffer>>();
  content.set(AGENTS_SKILL, agentsSkill());
  content.set(EVALS_SKILL, evalsSkill());
  for (const [name, files] of content) requireSkillName(files, name, `skill-data/${name}`);
  const owned = new Set<string>([...GENERATED_SKILLS, POINTER]);
  const handWritten = existsSync(SKILL_DATA)
    ? readdirSync(SKILL_DATA, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !owned.has(d.name))
        .map((d) => d.name)
    : [];
  for (const name of handWritten) content.set(name, handWrittenSkill(name));
  const pointer = pointerSkill();

  const expected: Expected = new Map();
  for (const name of GENERATED_SKILLS) {
    for (const [p, bytes] of content.get(name)!) expected.set(`skill-data/${name}/${p}`, bytes);
  }
  for (const [p, bytes] of pointer) {
    expected.set(`skill-data/${POINTER}/${p}`, bytes);
    expected.set(`.claude/skills/${POINTER}/${p}`, bytes);
  }
  const lock = {
    version: 1,
    skills: {
      [POINTER]: {
        source: LOCK_SOURCE,
        sourceType: "github",
        skillPath: `skills/${POINTER}/SKILL.md`,
        computedHash: skillFolderHash(pointer),
      },
    },
  };
  expected.set("skills-lock.json", Buffer.from(JSON.stringify(lock, null, 2) + "\n", "utf8"));
  return { expected, skillNames: [...content.keys()].sort() };
}

/** The roots this script owns outright: everything under them is generated. */
function generatedRoots(): string[] {
  return [...GENERATED_SKILLS.map((n) => join(SKILL_DATA, n)), join(SKILL_DATA, POINTER), MIRROR, LOCK];
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
      "The generated skills are out of date with their sources (docs/, docs-mintlify/, skills/evolve/):\n  " +
        problems.sort().join("\n  ") +
        "\nRun: npm run generate:skills  and commit the result.",
    );
    return 1;
  }
  console.log(`skill-data/, .claude/skills/ and skills-lock.json match their sources (${expected.size} files)`);
  return 0;
}

function write(expected: Expected, skillNames: string[]): void {
  for (const root of generatedRoots()) rmSync(root, { recursive: true, force: true });
  for (const [p, bytes] of expected) {
    const abs = join(ROOT, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  console.log(`wrote ${expected.size} files; skill-data/ serves ${skillNames.length} skills: ${skillNames.join(", ")}`);
}

function main(): void {
  const { expected, skillNames } = expectedOutput();
  if (process.argv.includes("--check")) process.exit(check(expected));
  write(expected, skillNames);
}

main();
