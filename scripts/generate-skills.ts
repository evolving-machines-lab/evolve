#!/usr/bin/env tsx
/**
 * Generates the skill files the docs folders and the pointer need — one source,
 * nothing copied.
 *
 * The docs folders are the skills (owner's ruling 2026-09-16): the CLI serves
 * docs-evals/ as `evals` and docs-agents/ as `agents`, reading every page in
 * place, and skills/ holds the pointer (`evolve`, the one skill an agent
 * installs) beside the four hand-written task-authoring skills.
 *
 * Inputs (the ONLY things this script reads):
 *   docs-evals/docs.json (name, description, navigation), every docs-evals/** /*.mdx (title, description)
 *     -> docs-evals/SKILL.md      front matter (name docs-evals, the site's description,
 *                                 metadata.internal) + an index following docs.json's
 *                                 navigation: tab -> group -> page title -> one line
 *   docs-agents/SKILL.source.md  the hand-written skill, front matter and body
 *     -> docs-agents/SKILL.md     the same bytes behind the generated marker
 *   skills/evolve/SKILL.md       the pointer, hand-written
 *     -> .claude/skills/evolve/   the mirror an agent inside this repo sees
 *     -> skills-lock.json         the `skills` CLI's project lock (npx skills add),
 *                                 same hash recipe as the CLI's local-lock.ts
 *   skills/<name>/ for the other folders (create-task, rewardkit, create-adapter,
 *   publish): hand-written, edited in place, only validated here.
 *
 * `metadata.internal: true` on every skill but the pointer: the `skills` CLI
 * (vercel-labs/skills, src/skills.ts) skips an internal skill unless it is
 * named with --skill, and its repo scan reads the repo root one level deep
 * and skills/ three levels deep — so docs-evals/SKILL.md, docs-agents/SKILL.md
 * and the four under skills/ would otherwise install beside the pointer.
 * The agents source is not named SKILL.md for the same scan.
 *
 * Usage:
 *   npm run generate:skills            # write the generated files
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
const SITE = join(ROOT, "docs-evals");
const AGENTS = join(ROOT, "docs-agents");
const SKILLS = join(ROOT, "skills");
const MIRROR = join(ROOT, ".claude", "skills");
const LOCK = join(ROOT, "skills-lock.json");

const EVALS_SKILL = "docs-evals";
const AGENTS_SKILL = "docs-agents";
/** The hand-written source behind docs-agents/SKILL.md. */
const AGENTS_SOURCE = join(AGENTS, "SKILL.source.md");

const POINTER = "evolve";
const POINTER_SOURCE = join(SKILLS, POINTER, "SKILL.md");
/** The pointer is installed as-is into an agent's skill list, so it stays a stub. */
const POINTER_MAX_WORDS = 500;
/** The agentskills.io front matter the pointer may carry; anything else is an editor's slip. */
const POINTER_FIELDS = ["name", "description", "allowed-tools"] as const;
/** The lock's `source`: what `npx skills add` is told. */
const LOCK_SOURCE = "evolving-machines-lab/evolve";

/** The generated body of docs-evals/SKILL.md, above the index. */
const EVALS_PREAMBLE = `# Evolve hosted evals

Hosted evaluation for agents: datasets of Harbor-format tasks, jobs that run any model on any agent harness against them in cloud sandboxes, and the trials, checks and analyses they produce — from the \`evolve\` CLI and the TypeScript and Python SDKs.

This folder is the documentation site itself, page for page: every row below names a page by its site path, the file \`<path>.mdx\` beside this one, and \`evolve skills get evals <path>\` prints it. An \`import\` of \`/snippets/<file>\` is \`snippets/<file>\`.

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

/** Every skill but the pointer is internal: the `skills` CLI must skip it unless named. */
function requireInternal(data: Record<string, unknown>, where: string): void {
  const metadata = data.metadata;
  if (metadata === null || typeof metadata !== "object" || (metadata as { internal?: unknown }).internal !== true) {
    throw new Error(`${where}: front matter needs metadata.internal: true (the skills CLI installs it otherwise)`);
  }
}

/** Invariant of every skill folder: the front matter name is the folder name —
 *  the name the spec validator, agents and the `skills` CLI address it by. */
function requireSkill(text: string, folder: string, where: string): Record<string, unknown> {
  const { data } = frontMatter(text, where);
  const declared = requireString(data, "name", where);
  requireString(data, "description", where);
  if (declared !== folder) throw new Error(`${where}: front matter name "${declared}" must equal the folder name`);
  return data;
}

// ---------------------------------------------------------------------------
/** A generated SKILL.md says so on the first line of its front matter, as a YAML
 *  comment: readable by anyone who opens the file, invisible to the front matter
 *  parsers (the skills CLI, the spec validator, Mintlify, which renders the file
 *  as a page of the site and refuses an HTML comment in MDX). */
function withGeneratedMarker(skill: Buffer, source: string): Buffer {
  const text = skill.toString("utf8");
  if (!text.startsWith("---\n")) throw new Error("generated SKILL.md must start with a front matter block");
  const marker = `# Generated by scripts/generate-skills.ts from ${source}. Do not edit; edit the source and run npm run generate:skills.\n`;
  return Buffer.from("---\n" + marker + text.slice("---\n".length), "utf8");
}

// ---------------------------------------------------------------------------
// docs-agents/SKILL.md: the hand-written source, validated, behind the marker

function agentsSkill(): Buffer {
  const where = `docs-agents/${relPath(AGENTS, AGENTS_SOURCE)}`;
  if (!existsSync(AGENTS_SOURCE)) throw new Error(`${where}: missing — it is the hand-written source of docs-agents/SKILL.md`);
  const text = readText(AGENTS_SOURCE);
  requireInternal(requireSkill(text, AGENTS_SKILL, where), where);
  return withGeneratedMarker(readBytes(AGENTS_SOURCE), where);
}

// ---------------------------------------------------------------------------
// docs-evals/SKILL.md: the site's description + an index generated from docs.json

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
    if (!existsSync(file)) throw new Error(`docs.json names page "${page}" but docs-evals/${page}.mdx does not exist`);
    const { data } = frontMatter(readText(file), `docs-evals/${page}.mdx`);
    const title = requireString(data, "title", `docs-evals/${page}.mdx`);
    const description = requireString(data, "description", `docs-evals/${page}.mdx`);
    out.push(`| [${cell(title)}](/${page}) | ${cell(description)} |`);
  }
  out.push("");
  for (const g of nested) renderGroup(g, depth + 1, out);
}

function evalsSkill(): Buffer {
  const docsJson = JSON.parse(readText(join(SITE, "docs.json"))) as { description?: unknown; navigation?: unknown };
  if (typeof docsJson.description !== "string" || docsJson.description.trim() === "") {
    throw new Error('docs-evals/docs.json: needs a non-empty "description" — it is the evals skill\'s description');
  }
  const out: string[] = [];
  for (const section of navigationSections(docsJson.navigation)) {
    if (section.heading !== null) out.push(`## ${section.heading}`, "");
    for (const group of section.groups) renderGroup(group, section.heading === null ? 2 : 3, out);
  }
  const front = ["---", `name: ${EVALS_SKILL}`, `description: ${JSON.stringify(docsJson.description)}`, "metadata:", "  internal: true", "---"].join("\n");
  return withGeneratedMarker(Buffer.from(`${front}\n\n${EVALS_PREAMBLE}\n${out.join("\n")}`, "utf8"), "docs-evals/docs.json");
}

// ---------------------------------------------------------------------------
// The pointer: skills/evolve/SKILL.md, validated, then mirrored and locked

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
    throw new Error(`${where}: ${words} words — the pointer stays under ${POINTER_MAX_WORDS}; the content belongs in the docs folders`);
  }
  return new Map([["SKILL.md", bytes]]);
}

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

/** The hand-written skills beside the pointer: validated, never written. */
function validateHandWrittenSkills(): string[] {
  const names = readdirSync(SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== POINTER)
    .map((d) => d.name)
    .sort();
  for (const name of names) {
    const where = `skills/${name}/SKILL.md`;
    const file = join(SKILLS, name, "SKILL.md");
    if (!existsSync(file)) throw new Error(`${where}: missing`);
    requireInternal(requireSkill(readText(file), name, where), where);
  }
  return names;
}

// ---------------------------------------------------------------------------

type Expected = Map<string, Buffer>; // repo-relative path -> bytes

/** Everything the generator owns, as it must be on disk. */
function expectedOutput(): { expected: Expected; skillNames: string[] } {
  const expected: Expected = new Map();
  expected.set(`${EVALS_SKILL}/SKILL.md`, evalsSkill());
  expected.set(`${AGENTS_SKILL}/SKILL.md`, agentsSkill());
  const pointer = pointerSkill();
  for (const [p, bytes] of pointer) expected.set(`.claude/skills/${POINTER}/${p}`, bytes);
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
  const skillNames = [EVALS_SKILL, AGENTS_SKILL, POINTER, ...validateHandWrittenSkills()];
  return { expected, skillNames };
}

/** What this script owns outright: the two generated SKILL.md files, the mirror folder, the lock. */
function generatedRoots(): string[] {
  return [join(SITE, "SKILL.md"), join(AGENTS, "SKILL.md"), MIRROR, LOCK];
}

function check(expected: Expected): number {
  const problems: string[] = [];
  const actual = new Set<string>();
  for (const root of generatedRoots()) {
    if (!existsSync(root)) continue;
    const files = root === MIRROR ? walkFiles(root) : [root];
    for (const p of files) actual.add(relPath(ROOT, p));
  }
  for (const [p, bytes] of expected) {
    if (!actual.has(p)) problems.push(`missing  ${p}`);
    else if (!readBytes(join(ROOT, p)).equals(bytes)) problems.push(`stale    ${p}`);
  }
  for (const p of actual) if (!expected.has(p)) problems.push(`extra    ${p}`);
  if (problems.length > 0) {
    console.error(
      "The generated skill files are out of date with their sources (docs-evals/docs.json, docs-agents/SKILL.source.md, skills/evolve/):\n  " +
        problems.sort().join("\n  ") +
        "\nRun: npm run generate:skills  and commit the result.",
    );
    return 1;
  }
  console.log(`docs-evals/SKILL.md, docs-agents/SKILL.md, .claude/skills/ and skills-lock.json match their sources (${expected.size} files)`);
  return 0;
}

function write(expected: Expected, skillNames: string[]): void {
  for (const root of generatedRoots()) rmSync(root, { recursive: true, force: true });
  for (const [p, bytes] of expected) {
    const abs = join(ROOT, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  console.log(`wrote ${expected.size} files; the skills: ${skillNames.join(", ")}`);
}

function main(): void {
  const { expected, skillNames } = expectedOutput();
  if (process.argv.includes("--check")) process.exit(check(expected));
  write(expected, skillNames);
}

main();
