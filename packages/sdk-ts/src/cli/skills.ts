/**
 * The bundled skills — what `evolve skills` serves.
 *
 * The package ships skills/: one folder per skill, each with a SKILL.md and,
 * for some, references/ and templates/. A coding agent installs only the
 * pointer skill (`evolve`, one short SKILL.md) and reads the real manual from
 * this CLI, so the instructions always match the installed version. This is
 * the structure of vercel-labs/agent-browser (`skills list|get|path`,
 * `--full`'s `--- path ---` separators), plus `install`; Harbor has no such
 * verb, so the group is this platform's own extension — local files only, no
 * API call.
 *
 * Names: a skill is addressed by its folder name without the `evolve-`
 * prefix — `evolve skills get evals` prints skills/evolve-evals/SKILL.md.
 * The pointer is served too (`skills get evolve`, and it is what `skills
 * install` writes) but never listed: an agent that has it installed should
 * not be shown it as a second skill. The SDK skill, skills/evolve-agents, is
 * not served at all (owner's ruling: the command is for evals); it installs
 * from the repository, and the package does not ship it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

/** The pointer skill: hidden from `skills list`, written by `skills install`. */
export const POINTER_SKILL = "evolve";

/** The folder the CLI never serves: the SDK skill, installed from the repository instead. */
export const UNSERVED_SKILL = "evolve-agents";

/** Overrides the skills directory the CLI serves; a developer's knob, not a user option. */
export const SKILLS_DIR_ENV = "EVOLVE_SKILLS_DIR";

/** The folder prefix that the served name drops: `evolve-evals` is `evals`. */
const FOLDER_PREFIX = "evolve-";

/** The subfolders `--full` prints after SKILL.md, in this order; pages live under the first. */
const FULL_SUBFOLDERS = ["references", "templates"] as const;

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
  /** The served name: the folder name without the `evolve-` prefix. */
  name: string;
  /** The skill's directory, absolute. */
  dir: string;
  /** The front matter description, one line. */
  description: string;
  /** SKILL.md as it is on disk. */
  content: string;
}

export interface SkillFile {
  /** Relative to the skill's directory, forward slashes. */
  path: string;
  content: string;
}

export interface SkillPage extends SkillFile {
  /** The site path: the file's path under references/ without its suffix. */
  page: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
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
// The directory

/**
 * Where the skills are, in order: EVOLVE_SKILLS_DIR (a skills/ folder); the
 * package's own skills/ (staged into packages/sdk-ts by every build and pack,
 * so it is there in every published copy); the checkout's skills/ two levels
 * above the package (packages/sdk-ts -> the repo root), so the CLI run from
 * source serves the same files before any build.
 */
export function skillsDir(packageRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SKILLS_DIR_ENV];
  if (override !== undefined && override !== "") {
    if (!isDirectory(override)) throw new SkillsError(`${SKILLS_DIR_ENV} points at nothing: ${override}`);
    return resolve(override);
  }
  for (const candidate of [join(packageRoot, "skills"), join(packageRoot, "..", "..", "skills")]) {
    if (isDirectory(candidate)) return resolve(candidate);
  }
  throw new SkillsError(`skills directory not found; set ${SKILLS_DIR_ENV} or reinstall @evolvingmachines/evolve`);
}

// -----------------------------------------------------------------------------
// The skills

function readSkill(dir: string): Skill {
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
  const folder = dir.slice(dir.lastIndexOf(sep) + 1);
  const name = folder.startsWith(FOLDER_PREFIX) ? folder.slice(FOLDER_PREFIX.length) : folder;
  return { name, dir, description, content };
}

/** Every served folder holding a SKILL.md, the pointer included, sorted by served name. */
function allSkills(dir: string): Skill[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== UNSERVED_SKILL && isRegularFile(join(dir, entry.name, "SKILL.md")))
    .map((entry) => readSkill(join(dir, entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The skills `skills list` and `get --all` show: everything but the pointer. */
export function contentSkills(dir: string): Skill[] {
  return allSkills(dir).filter((skill) => skill.name !== POINTER_SKILL);
}

export function hasSkill(dir: string, name: string): boolean {
  return allSkills(dir).some((skill) => skill.name === name);
}

/** A skill by served name; the pointer answers too. Unknown names list what exists. */
export function findSkill(dir: string, name: string): Skill {
  const skill = allSkills(dir).find((s) => s.name === name);
  if (!skill) {
    const names = contentSkills(dir).map((s) => s.name);
    throw new SkillsError(`unknown skill "${name}" (skills: ${names.join(", ")})`);
  }
  return skill;
}

/**
 * What `--full` adds after SKILL.md: every file under references/ and
 * templates/, sorted by path. A symlink is never among them: the walk does not
 * enter one, so nothing outside the folder can be served.
 */
export function skillFiles(skill: Skill): SkillFile[] {
  return FULL_SUBFOLDERS.flatMap((sub) =>
    walkFiles(join(skill.dir, sub)).map((p) => ({ path: relPath(skill.dir, p), content: readFileSync(p, "utf8") })),
  );
}

function isPageFile(path: string): boolean {
  return path.startsWith("references/") && PAGE_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/** The site paths of a skill's pages: its files under references/, suffix dropped. */
export function pageNames(skill: Skill): string[] {
  return skillFiles(skill)
    .filter((f) => isPageFile(f.path))
    .map((f) => f.path.slice("references/".length).replace(/\.mdx?$/, ""));
}

/**
 * One page by its site path (`core-concepts/tasks`), the .mdx or .md suffix
 * optional. Only a file `--full` would print is a page, so a `..` path, a
 * symlink, or a file behind a symlinked directory is unknown, never read.
 */
export function findPage(skill: Skill, page: string): SkillPage {
  const wanted = `references/${page.replace(/^\.\//, "")}`;
  const candidates = new Set([wanted, ...PAGE_SUFFIXES.map((suffix) => wanted + suffix)]);
  const file = skillFiles(skill).find((f) => isPageFile(f.path) && candidates.has(f.path));
  if (!file) throw new SkillsError(`no page "${page}" in skill ${skill.name} (pages: ${pageNames(skill).join(", ")})`);
  return { page: file.path.slice("references/".length).replace(/\.mdx?$/, ""), path: file.path, content: file.content };
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

/**
 * Writes the pointer's SKILL.md into <skillsDir>/evolve/ for every
 * destination. Nothing is written until every destination is checked: a
 * SKILL.md already there with different bytes is a refusal unless `force`,
 * and a file standing where a directory must go is always one. A SKILL.md
 * already holding the same bytes is left alone and reported unchanged.
 */
export function installPointer(dir: string, destinations: InstallDestination[], force: boolean): InstallResult[] {
  const pointer = findSkill(dir, POINTER_SKILL).content;
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
