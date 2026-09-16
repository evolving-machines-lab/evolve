/**
 * The bundled skills — what `evolve skills` serves.
 *
 * The docs folders are the skills (owner's ruling 2026-09-16). The package
 * ships three folders from the repo root and serves them in place:
 *   docs-evals/    the documentation site, served as `evals`; every page is a
 *                  file of the site at the site's own path
 *   docs-agents/   the managed-agents chapters, served as `agents`
 *   skills/        the pointer (`evolve`, one short SKILL.md, the one skill an
 *                  agent installs) and the hand-written task-authoring skills,
 *                  each served by its folder name
 * A coding agent installs only the pointer and reads the real manual from
 * this CLI, so the instructions always match the installed version. The
 * verbs are agent-browser's (`skills list|get|path`, `--full`'s
 * `--- path ---` separators) plus `install`; Harbor has no such verb, so the
 * group is this platform's own extension — local files only, no API call.
 *
 * The pointer is served too (`skills get evolve`, and it is what `skills
 * install` writes) but never listed: an agent that has it installed should
 * not be shown it as a second skill.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

/** The pointer skill: hidden from `skills list`, written by `skills install`. */
export const POINTER_SKILL = "evolve";

/** Overrides the root the CLI serves (a checkout or a package root); a developer's knob, not a user option. */
export const SKILLS_DIR_ENV = "EVOLVE_SKILLS_DIR";

/** The docs folders served as skills, by served name. */
const DOCS_SKILLS: Record<string, string> = { evals: "docs-evals", agents: "docs-agents" };

/** The folder holding the pointer and the hand-written skills; each is served by its folder name. */
const SKILLS_FOLDER = "skills";

/** The generator's hand-written source beside a generated SKILL.md: the skill's own, never a page. */
const SKILL_SOURCE = "SKILL.source.md";

/** Under a hand-written skill, the folders `--full` prints (agent-browser's rule). */
const EXTRA_FOLDERS = ["references", "templates"] as const;

/** The page suffixes `get <skill> <page>` accepts without being told. */
const PAGE_SUFFIXES = [".mdx", ".md"] as const;

/** A local refusal from the skills verbs: exit 1, the message names what exists. */
export class SkillsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsError";
  }
}

export interface Skill {
  /** The served name: `evals`, `agents`, or a folder name under skills/. */
  name: string;
  /** The skill's directory, absolute. */
  dir: string;
  /** The front matter description, one line. */
  description: string;
  /** SKILL.md as it is on disk. */
  content: string;
  /** True for the two docs folders: every page of the folder is the skill's content. */
  docs: boolean;
}

export interface SkillFile {
  /** Relative to the skill's directory, forward slashes. */
  path: string;
  content: string;
}

export interface SkillPage extends SkillFile {
  /** The site path: the file's path in the skill without its suffix. */
  page: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Repo-style relative path with forward slashes, whatever the platform. */
function relPath(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/** Every regular file under a folder, sorted; symlinks and what lies behind them are never entered. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile()) out.push(p);
    }
  };
  if (isDirectory(dir)) visit(dir);
  return out.sort();
}

// -----------------------------------------------------------------------------
// The root

/** True when a directory holds the three folders the CLI serves. */
function isSkillsRoot(dir: string): boolean {
  return [...Object.values(DOCS_SKILLS), SKILLS_FOLDER].every((folder) => isDirectory(join(dir, folder)));
}

/**
 * The root holding docs-evals/, docs-agents/ and skills/, in order:
 * EVOLVE_SKILLS_DIR (a checkout or a package root); the package itself, whose
 * copies every build and pack stage; the checkout two levels above the
 * package (packages/sdk-ts -> the repo root), so the CLI run from source
 * serves the same files before any build.
 */
export function skillsRoot(packageRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SKILLS_DIR_ENV];
  if (override !== undefined && override !== "") {
    if (!isDirectory(override)) throw new SkillsError(`${SKILLS_DIR_ENV} points at nothing: ${override}`);
    if (!isSkillsRoot(override)) {
      throw new SkillsError(`${SKILLS_DIR_ENV} must hold docs-evals/, docs-agents/ and skills/: ${override}`);
    }
    return resolve(override);
  }
  for (const candidate of [packageRoot, join(packageRoot, "..", "..")]) {
    if (isSkillsRoot(candidate)) return resolve(candidate);
  }
  throw new SkillsError(`skills directory not found; set ${SKILLS_DIR_ENV} or reinstall @evolvingmachines/evolve`);
}

// -----------------------------------------------------------------------------
// The skills

function readSkill(name: string, dir: string, docs: boolean): Skill {
  const file = join(dir, "SKILL.md");
  const content = readFileSync(file, "utf8");
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  let data: unknown = null;
  if (block) {
    try {
      data = parseYaml(block[1]);
    } catch (error) {
      throw new SkillsError(`${file}: front matter does not parse (${(error as Error).message})`);
    }
  }
  const description =
    data !== null && typeof data === "object" && typeof (data as { description?: unknown }).description === "string"
      ? (data as { description: string }).description.replace(/\s+/g, " ").trim()
      : "";
  return { name, dir, description, content, docs };
}

function hasSkillMd(dir: string): boolean {
  return walkFiles(dir).length > 0 && existsSync(join(dir, "SKILL.md")) && !isDirectory(join(dir, "SKILL.md"));
}

/** Every skill the root holds, the pointer included, sorted by served name. */
function allSkills(root: string): Skill[] {
  const skills: Skill[] = [];
  for (const [name, folder] of Object.entries(DOCS_SKILLS)) {
    const dir = join(root, folder);
    if (hasSkillMd(dir)) skills.push(readSkill(name, dir, true));
  }
  const folder = join(root, SKILLS_FOLDER);
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const dir = join(folder, entry.name);
    if (entry.isDirectory() && hasSkillMd(dir)) skills.push(readSkill(entry.name, dir, false));
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** The skills `skills list` and `get --all` show: everything but the pointer. */
export function contentSkills(root: string): Skill[] {
  return allSkills(root).filter((skill) => skill.name !== POINTER_SKILL);
}

export function hasSkill(root: string, name: string): boolean {
  return allSkills(root).some((skill) => skill.name === name);
}

/** A skill by served name; the pointer answers too. Unknown names list what exists. */
export function findSkill(root: string, name: string): Skill {
  const skill = allSkills(root).find((s) => s.name === name);
  if (!skill) {
    const names = contentSkills(root).map((s) => s.name);
    throw new SkillsError(`unknown skill "${name}" (skills: ${names.join(", ")})`);
  }
  return skill;
}

function isPageFile(path: string): boolean {
  return PAGE_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/**
 * What `--full` adds after SKILL.md, sorted by path: for a docs folder every
 * page of the site (its .md and .mdx files, the skill's own SKILL.md and the
 * generator's source excluded); for a hand-written skill every file under
 * references/ and templates/. A symlink is never among them: the walk does
 * not enter one, so nothing outside the folder can be served.
 */
export function skillFiles(skill: Skill): SkillFile[] {
  const files = skill.docs
    ? walkFiles(skill.dir).filter((p) => isPageFile(p) && !["SKILL.md", SKILL_SOURCE].includes(relPath(skill.dir, p)))
    : EXTRA_FOLDERS.flatMap((sub) => walkFiles(join(skill.dir, sub)));
  return files.map((p) => ({ path: relPath(skill.dir, p), content: readFileSync(p, "utf8") }));
}

/** The site paths of a skill's pages: its .md and .mdx files, suffix dropped. */
export function pageNames(skill: Skill): string[] {
  return skillFiles(skill)
    .filter((f) => isPageFile(f.path))
    .map((f) => f.path.replace(/\.mdx?$/, ""));
}

/**
 * One page by its site path (`core-concepts/tasks`), the .mdx or .md suffix
 * optional. Only a file `--full` would print is a page, so a `..` path, a
 * symlink, or a file behind a symlinked directory is unknown, never read.
 */
export function findPage(skill: Skill, page: string): SkillPage {
  const wanted = page.replace(/^\.\//, "");
  const candidates = new Set([wanted, ...PAGE_SUFFIXES.map((suffix) => wanted + suffix)]);
  const file = skillFiles(skill).find((f) => isPageFile(f.path) && candidates.has(f.path));
  if (!file) throw new SkillsError(`no page "${page}" in skill ${skill.name} (pages: ${pageNames(skill).join(", ")})`);
  return { page: file.path.replace(/\.mdx?$/, ""), path: file.path, content: file.content };
}

// -----------------------------------------------------------------------------
// install: the pointer into the agents' skill folders

/** The agent homes `skills install` knows, in the order the paths are printed. */
export const INSTALL_TARGETS = ["claude", "codex", "cursor", "copilot", "gemini", "opencode", "agents"] as const;
export type InstallTarget = (typeof INSTALL_TARGETS)[number];

/** Where a target keeps its user-level skills: ~/.<name>/skills, except
 *  opencode, which follows the XDG config home. */
export function targetSkillsDir(target: InstallTarget, env: NodeJS.ProcessEnv = process.env): string {
  if (target === "opencode") {
    const configHome = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== "" ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
    return join(configHome, "opencode", "skills");
  }
  return join(homedir(), `.${target}`, "skills");
}

export interface InstallDestination {
  /** A target name, or "path" for a directory the caller named. */
  target: InstallTarget | "path";
  /** The skills directory the pointer folder goes into. */
  skillsDir: string;
}

export interface InstallResult {
  target: InstallTarget | "path";
  /** The SKILL.md written or found in place. */
  path: string;
  status: "written" | "unchanged";
}

/** The nearest existing ancestor of a path (the path itself when it exists). */
function nearestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Writes the pointer's SKILL.md into <skillsDir>/evolve/ for every
 * destination. Nothing is written until every destination is checked: a
 * SKILL.md already there with different bytes is a refusal unless `force`,
 * and a file standing where a directory must go is always one. A SKILL.md
 * already holding the same bytes is left alone and reported unchanged.
 */
export function installPointer(root: string, destinations: InstallDestination[], force: boolean): InstallResult[] {
  const pointer = findSkill(root, POINTER_SKILL).content;
  const planned: { destination: InstallDestination; path: string; write: boolean }[] = [];
  const refusals: string[] = [];
  for (const destination of destinations) {
    const path = join(destination.skillsDir, POINTER_SKILL, "SKILL.md");
    const existing = nearestExisting(path);
    if (existing === path) {
      if (!isRegularFile(path)) {
        refusals.push(`${path} is a directory, not a file`);
        continue;
      }
      const same = readFileSync(path, "utf8") === pointer;
      if (!same && !force) refusals.push(`${path} exists with different content; pass --force to overwrite it`);
      planned.push({ destination, path, write: !same });
    } else if (!isDirectory(existing)) {
      refusals.push(`${existing} is a file, so ${path} cannot be created`);
    } else {
      planned.push({ destination, path, write: true });
    }
  }
  if (refusals.length > 0) throw new SkillsError(refusals.join("\n"));
  return planned.map(({ destination, path, write }) => {
    if (write) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, pointer);
    }
    return { target: destination.target, path, status: write ? "written" : "unchanged" };
  });
}
