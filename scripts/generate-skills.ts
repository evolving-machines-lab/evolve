#!/usr/bin/env tsx
/**
 * Generates the skills under skills/ from the docs — one source, generated copies.
 *
 * skills/ holds everything (owner's ruling 2026-09-16, Addendum 3): the pointer
 * (`evolve`, the one skill an agent installs), the two generated skills, and
 * the four hand-written task-authoring skills. The docs folders stay pure docs.
 *
 * Inputs (the ONLY things this script reads):
 *   docs-evals/docs.json (description, navigation), every docs-evals/** /*.mdx
 *     -> skills/evolve-evals/     SKILL.md: front matter (name, the site's description,
 *                                 metadata.internal) + an index following docs.json's
 *                                 navigation (tab -> group -> page title -> one line);
 *                                 references/<site path>.md: readable Markdown from each page
 *   docs-agents/SKILL.source.md, docs-agents/typescript/0[1-5]-*.md, docs-agents/python/0[1-5]-*.md
 *     -> skills/evolve-agents/    SKILL.md: the hand-written skill behind the marker;
 *                                 references/<language>/<chapter>: the chapters, byte for byte
 *   skills/evolve/SKILL.md       the pointer, hand-written
 *     -> .claude/skills/evolve/   the mirror an agent inside this repo sees
 *   skills/<name>/ for the other folders (create-task, rewardkit, create-adapter,
 *   publish): hand-written, edited in place, only validated here.
 *
 * `metadata.internal: true` on every skill but the pointer: the `skills` CLI
 * (vercel-labs/skills, src/skills.ts) skips an internal skill unless it is
 * named with --skill (`npx skills add evolving-machines-lab/evolve --skill
 * evolve-agents` is how the SDK skill installs), so `npx skills add` finds
 * exactly one skill. The agents source is not named SKILL.md: that CLI's repo
 * scan would otherwise take docs-agents/ for a skill of its own.
 *
 * Usage:
 *   npm run generate:skills            # write the generated folders
 *   npm run generate:skills -- --check # exit 1 naming every stale, missing or extra file
 *
 * Deterministic: the same inputs produce the same bytes — file lists are
 * sorted, nothing is timestamped, no environment is read. The workflow
 * .github/workflows/sync-docs-to-skill.yml runs --check on pull requests and
 * regenerates + commits on pushes to main and project-sable.
 *
 * Dependencies: `tsx`, `typescript`, and `yaml`, all root devDependencies (`yaml` at the
 * same version packages/sdk-ts pins).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { renderDocsMarkdown } from "./docs-markdown.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "docs-evals");
const AGENTS_DOCS = join(ROOT, "docs-agents");
const SKILLS = join(ROOT, "skills");
const MIRROR = join(ROOT, ".claude", "skills");

const EVALS_SKILL = "evolve-evals";
const AGENTS_SKILL = "evolve-agents";
const GENERATED_SKILLS = [EVALS_SKILL, AGENTS_SKILL] as const;
/** The hand-written skill behind skills/evolve-agents/SKILL.md. */
const AGENTS_SOURCE = join(AGENTS_DOCS, "SKILL.source.md");
/** Chapters 01–05 are the SDK; the hosted evals are the evals skill's ground. */
const AGENT_CHAPTERS = /^0[1-5]-.*\.md$/;
const LANGUAGES = ["typescript", "python"] as const;

const POINTER = "evolve";
const POINTER_SOURCE = join(SKILLS, POINTER, "SKILL.md");
/** The pointer is installed as-is into an agent's skill list, so it stays a stub. */
const POINTER_MAX_WORDS = 500;
/** The agentskills.io front matter the pointer may carry; anything else is an editor's slip. */
const POINTER_FIELDS = ["name", "description", "allowed-tools"] as const;

/** The generated body of skills/evolve-evals/SKILL.md, above the index. */
const EVALS_PREAMBLE = `# Evolve managed evals

Run evaluations in cloud sandboxes. Read results, inspect files, check tasks, and analyze traces through the CLI or Python and TypeScript SDKs.

## Find the right instructions

1. Choose a page from the index below. Read it with \`evolve skills get evals <page>\`.
2. Follow links by site path: \`/core-concepts/tasks\` means \`evolve skills get evals core-concepts/tasks\` or \`references/core-concepts/tasks.md\` in this folder.
3. Confirm installed command options with \`evolve <command> --help\`. Use \`--json\` when parsing command output.

These pages are generated from the same source as the website. Tabs become labeled sections, field details remain visible, and snippets are included in place. Read individual pages first; \`--full\` prints the whole manual.

Hosted requests use \`EVOLVE_API_KEY\`. Start with Installation if authentication is missing. The managed-agent builder, Swarm, and Pipeline have a separate \`evolve-agents\` skill.

`;

// ---------------------------------------------------------------------------
// Files

/** Repo-relative path with forward slashes. */
function relPath(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/** Every regular file under dir, absolute, sorted, recursive. `.git` and
 *  `node_modules` are never entered (the `skills` CLI skips them too) and
 *  `.DS_Store` is never listed. */
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

/** A generated SKILL.md says so on the first line of its front matter, as a YAML
 *  comment: readable by anyone who opens the file, invisible to every front
 *  matter parser (the skills CLI, the spec validator). */
function withGeneratedMarker(skill: Buffer, source: string): Buffer {
  const text = skill.toString("utf8");
  if (!text.startsWith("---\n")) throw new Error("generated SKILL.md must start with a front matter block");
  const marker = `# Generated by scripts/generate-skills.ts from ${source}. Do not edit; edit the source and run npm run generate:skills.\n`;
  return Buffer.from("---\n" + marker + text.slice("---\n".length), "utf8");
}

// ---------------------------------------------------------------------------
// evolve-agents: docs-agents/SKILL.source.md + chapters 01–05 of both languages

function agentsSkill(): Map<string, Buffer> {
  const where = `docs-agents/${relPath(AGENTS_DOCS, AGENTS_SOURCE)}`;
  if (!existsSync(AGENTS_SOURCE)) throw new Error(`${where}: missing — it is the hand-written source of skills/${AGENTS_SKILL}/SKILL.md`);
  requireInternal(requireSkill(readText(AGENTS_SOURCE), AGENTS_SKILL, where), where);
  const files = new Map<string, Buffer>();
  files.set("SKILL.md", withGeneratedMarker(readBytes(AGENTS_SOURCE), `${where} and docs-agents/*/01-05`));
  for (const lang of LANGUAGES) {
    const chapters = readdirSync(join(AGENTS_DOCS, lang)).filter((n) => AGENT_CHAPTERS.test(n)).sort();
    if (chapters.length === 0) throw new Error(`docs-agents/${lang}: no chapters matching ${AGENT_CHAPTERS}`);
    for (const name of chapters) files.set(`references/${lang}/${name}`, readBytes(join(AGENTS_DOCS, lang, name)));
  }
  return files;
}

// ---------------------------------------------------------------------------
// evolve-evals: docs-evals pages + an index generated from docs.json

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
    out.push(`| [${cell(title)}](references/${page}.md) | ${cell(description)} |`);
  }
  out.push("");
  for (const g of nested) renderGroup(g, depth + 1, out);
}

function evalsSkill(): Map<string, Buffer> {
  const docsJson = JSON.parse(readText(join(SITE, "docs.json"))) as { description?: unknown; navigation?: unknown };
  if (typeof docsJson.description !== "string" || docsJson.description.trim() === "") {
    throw new Error('docs-evals/docs.json: needs a non-empty "description" — it is the evals skill\'s description');
  }
  const index: string[] = [];
  for (const section of navigationSections(docsJson.navigation)) {
    if (section.heading !== null) index.push(`## ${section.heading}`, "");
    for (const group of section.groups) renderGroup(group, section.heading === null ? 2 : 3, index);
  }
  const front = ["---", `name: ${EVALS_SKILL}`, `description: ${JSON.stringify(docsJson.description)}`, "metadata:", "  internal: true", "---"].join("\n");
  const files = new Map<string, Buffer>();
  files.set("SKILL.md", withGeneratedMarker(Buffer.from(`${front}\n\n${EVALS_PREAMBLE}\n${index.join("\n")}`, "utf8"), "docs-evals/"));
  const pages = walkFiles(SITE).filter((p) => p.endsWith(".mdx"));
  if (pages.length === 0) throw new Error("docs-evals: no .mdx pages found");
  for (const p of pages) {
    const target = relPath(SITE, p).replace(/\.mdx$/, ".md");
    files.set(`references/${target}`, Buffer.from(renderDocsMarkdown(readText(p), { file: p, root: SITE }), "utf8"));
  }
  return files;
}

// ---------------------------------------------------------------------------
// The pointer: skills/evolve/SKILL.md, validated, then mirrored

function pointerSkill(): Buffer {
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
    throw new Error(`${where}: ${words} words — the pointer stays under ${POINTER_MAX_WORDS}; the content belongs in the docs`);
  }
  return bytes;
}

/** The hand-written skills beside the pointer: validated, never written. */
function validateHandWrittenSkills(): string[] {
  const names = readdirSync(SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== POINTER && !(GENERATED_SKILLS as readonly string[]).includes(d.name))
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
  for (const [p, bytes] of evalsSkill()) expected.set(`skills/${EVALS_SKILL}/${p}`, bytes);
  for (const [p, bytes] of agentsSkill()) expected.set(`skills/${AGENTS_SKILL}/${p}`, bytes);
  expected.set(`.claude/skills/${POINTER}/SKILL.md`, pointerSkill());
  const skillNames = [POINTER, ...GENERATED_SKILLS, ...validateHandWrittenSkills()];
  return { expected, skillNames };
}

/** What this script owns outright: the two generated folders and the mirror. */
function generatedRoots(): string[] {
  return [...GENERATED_SKILLS.map((n) => join(SKILLS, n)), MIRROR];
}

function check(expected: Expected): number {
  const problems: string[] = [];
  const actual = new Set<string>();
  for (const root of generatedRoots()) for (const p of walkFiles(root)) actual.add(relPath(ROOT, p));
  for (const [p, bytes] of expected) {
    if (!actual.has(p)) problems.push(`missing  ${p}`);
    else if (!readBytes(join(ROOT, p)).equals(bytes)) problems.push(`stale    ${p}`);
  }
  for (const p of actual) if (!expected.has(p)) problems.push(`extra    ${p}`);
  if (problems.length > 0) {
    console.error(
      "The generated skills are out of date with their sources (docs-evals/, docs-agents/, skills/evolve/):\n  " +
        problems.sort().join("\n  ") +
        "\nRun: npm run generate:skills  and commit the result.",
    );
    return 1;
  }
  console.log(`skills/${EVALS_SKILL}, skills/${AGENTS_SKILL} and .claude/skills/ match their sources (${expected.size} files)`);
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
