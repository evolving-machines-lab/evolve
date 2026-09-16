/**
 * The bundled skills — what `evolve skills` serves.
 *
 * The package ships skill-data/: one folder per skill, each with a SKILL.md
 * and, for some, references/ and templates/. A coding agent installs only the
 * pointer skill (`evolve`, one short SKILL.md) and reads the real manual from
 * this CLI, so the instructions always match the installed version. This is
 * the structure of vercel-labs/agent-browser (skills/ = the pointer,
 * skill-data/ = the content, `skills list|get|path`), adopted whole; Harbor
 * has no such verb, so the group is this platform's own extension — local
 * files only, no API call.
 *
 * Names: a skill is addressed by its folder name without the `evolve-`
 * prefix — `evolve skills get evals` prints skill-data/evolve-evals/SKILL.md.
 * The pointer is served too (`skills get evolve`, and it is what `skills
 * install` writes) but never listed: an agent that has it installed should
 * not be shown it as a second skill.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

/** The pointer skill: hidden from `skills list`, written by `skills install`. */
export const POINTER_SKILL = "evolve";

/** Overrides the directory the CLI serves; a developer's knob, not a user option. */
export const SKILLS_DIR_ENV = "EVOLVE_SKILLS_DIR";

/** The folder prefix that the served name drops: `evolve-evals` is `evals`. */
const FOLDER_PREFIX = "evolve-";

/** The subfolders `--full` prints after SKILL.md, in this order. */
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

/** A regular file: a symlink is not served, whatever it points at, as walkFiles skips it too. */
function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Repo-style relative path with forward slashes, whatever the platform. */
function relPath(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

// -----------------------------------------------------------------------------
// The directory

/**
 * Where the skills are, in order: EVOLVE_SKILLS_DIR; the package's own
 * skill-data/ (staged into packages/sdk-ts by every build and pack, so it is
 * there in every published copy); the checkout's skill-data/ two levels above
 * the package (packages/sdk-ts -> the repo root), so the CLI run from source
 * serves the same files before any build.
 */
export function skillsDir(packageRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SKILLS_DIR_ENV];
  if (override !== undefined && override !== "") {
    if (!isDirectory(override)) throw new SkillsError(`${SKILLS_DIR_ENV} points at nothing: ${override}`);
    return resolve(override);
  }
  for (const candidate of [join(packageRoot, "skill-data"), join(packageRoot, "..", "..", "skill-data")]) {
    if (isDirectory(candidate)) return resolve(candidate);
  }
  throw new SkillsError(`skills directory not found; set ${SKILLS_DIR_ENV} or reinstall @evolvingmachines/sdk`);
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

/** Every folder holding a SKILL.md, the pointer included, sorted by served name. */
function allSkills(dir: string): Skill[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isFile(join(dir, entry.name, "SKILL.md")))
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

/** Every regular file under a folder, absolute, sorted, recursive. */
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

/** What `--full` adds: every file under references/ and templates/, sorted by path. */
export function skillFiles(skill: Skill): SkillFile[] {
  return FULL_SUBFOLDERS.flatMap((sub) =>
    walkFiles(join(skill.dir, sub)).map((p) => ({ path: relPath(skill.dir, p), content: readFileSync(p, "utf8") })),
  );
}

/** The site paths of a skill's reference pages: under references/, suffix dropped. */
export function pageNames(skill: Skill): string[] {
  const refs = join(skill.dir, "references");
  return walkFiles(refs).map((p) => relPath(refs, p).replace(/\.mdx?$/, ""));
}

/**
 * One reference page by its site path (`core-concepts/tasks`), the .mdx or
 * .md suffix optional. Only a regular file whose real path lies under the real
 * references/ is a page: a `..` path, a symlinked file, and a file reached
 * through a symlinked directory are all unknown, never read — the same files
 * `--full` and the page list never show.
 */
export function findPage(skill: Skill, page: string): SkillPage {
  const refs = join(skill.dir, "references");
  const unknown = () =>
    new SkillsError(`no page "${page}" in skill ${skill.name} (pages: ${pageNames(skill).join(", ")})`);
  const target = resolve(refs, page);
  if (!target.startsWith(refs + sep) || !isDirectory(refs)) throw unknown();
  const realRefs = realpathSync(refs);
  for (const candidate of [target, ...PAGE_SUFFIXES.map((suffix) => target + suffix)]) {
    if (!isFile(candidate) || !realpathSync(candidate).startsWith(realRefs + sep)) continue;
    const path = relPath(skill.dir, candidate);
    return { page: relPath(refs, candidate).replace(/\.mdx?$/, ""), path, content: readFileSync(candidate, "utf8") };
  }
  throw unknown();
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
      if (!isFile(path)) {
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
