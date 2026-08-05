/**
 * The one skills resolver.
 *
 * A skill is a directory with a SKILL.md manifest that gets mounted into the
 * agent's sandbox so the harness can discover it natively. This module is the
 * single implementation of everything between a skill REFERENCE (a string) and
 * skill CONTENT sitting in the box: parsing, pinning, fetching, content
 * caching, digesting, and mounting. The managed-agents runtime (agent.ts
 * setupSkills) and the hosted eval worker both go through it — there is no
 * second resolver anywhere.
 *
 * Reference grammar (Harbor's, plus the skills.sh veneer and platform uploads):
 *
 *   org/repo                    github.com/org/repo, default branch
 *   org/repo@ref                same, pinned to a branch / tag / commit sha
 *   https://host/org/repo       any git host over https
 *   https://host/org/repo/tree/<ref>/<subdir>
 *                               explicit subdir — Harbor's strict discovery
 *   skills.sh/owner/repo        the skills.sh registry page for a repo
 *   skills.sh/owner/repo/name   ONE named skill from that repo
 *   skills.sh/...@ref           either skills.sh form, pinned
 *   ./path | /path | ~/path     a local skill folder (SDK-side only)
 *   upload:<id>                 a platform-stored uploaded skill (hosted only;
 *                               this module refuses it — the platform resolves
 *                               uploads to local folders before calling here)
 *
 * The git grammar and discovery law mirror Harbor's resolver
 * (REFERENCES/Harbor/src/harbor/skills.py): shorthand and URL parsing at
 * skills.py:60-108, sha pinning via `git ls-remote` at skills.py:252-279,
 * content cache keyed {host}/{org}/{repo}/{sha} at skills.py:126-172, the
 * SKILL.md discovery law at skills.py:382-416, and the content digest recipe
 * at skills.py:200-209 — the digest here is byte-for-byte the same recipe, so
 * a skill folder digests to the same value under both tools.
 *
 * skills.sh is a leaderboard over public git repos, not a separate transport:
 * skills.sh/<owner>/<repo>[/<skill>] maps to github.com/<owner>/<repo> with
 * skills discovered in the ecosystem's standard container directories
 * (`skills/`, `skills/.curated/`, `skills/.experimental/`, `.claude/skills/`,
 * or a SKILL.md at the repo root) — the same places `npx skills add` looks.
 * Discovery through the standard containers tolerates non-skill siblings
 * (ecosystem repos carry READMEs and tooling); an EXPLICIT subdir keeps
 * Harbor's loud law — every immediate child must be a skill, and a child
 * without SKILL.md is named in the refusal (skills.py:400-407).
 *
 * Duplicate skill names across the resolved list are last-wins, and the
 * result is sorted by name — Harbor's resolve_skills law (skills.py:111-123).
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

export const SKILL_FILE_NAME = "SKILL.md";

/** Where fetched skill content lives between runs, keyed by commit sha. */
const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "evolve", "skills");

/**
 * The standard skill container directories searched when a reference names a
 * whole repo (org/repo or a skills.sh page) rather than an explicit subdir.
 * The list is the skills.sh CLI's core search set (their README: root
 * SKILL.md, skills/, skills/.curated/, skills/.experimental/, skills/.system/,
 * plus agent config dirs — we take .claude/skills as the one in real use);
 * `skills/` first keeps Harbor's default-subdir behaviour as the primary hit.
 */
const STANDARD_CONTAINERS = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".claude/skills",
];

/** Matches org/name or org/name@ref — Harbor's shorthand (skills.py:30-32). */
const SHORTHAND_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:@(.+))?$/;

const SHA_RE = /^[0-9a-f]{40}$/;

/** Sanity ceilings — a skill is instructions, not a dataset. */
export const MAX_SKILL_FILES = 2000;
export const MAX_SKILL_BYTES = 64 * 1024 * 1024; // 64 MiB per skill

/** A skill reference the platform or SDK accepts: always a plain string. */
export type SkillRef = string;

export type ParsedSkillRef =
  | {
      kind: "git";
      host: string;
      org: string;
      repo: string;
      /** Branch, tag or commit sha; undefined = the remote's default branch. */
      gitRef?: string;
      /**
       * Explicit subdir from a /tree/<ref>/<subdir> URL. When absent, the
       * standard containers are searched instead.
       */
      subdir?: string;
      /** skills.sh/<owner>/<repo>/<name> selects exactly this skill. */
      skillName?: string;
      /** True when the ref came in through the skills.sh form. */
      viaSkillsSh: boolean;
      raw: string;
    }
  | { kind: "local"; path: string; raw: string }
  | { kind: "upload"; id: string; raw: string };

/** One resolved skill: content on local disk plus its full provenance. */
export interface ResolvedSkill {
  /** Directory basename — the name the harness will see. */
  name: string;
  /** Local directory holding the skill's files. */
  dir: string;
  /** The reference as given. */
  source: string;
  /** https URL of the repo, for git-backed skills. */
  gitUrl?: string;
  /** The exact commit the content came from, for git-backed skills. */
  gitCommit?: string;
  /** Harbor-recipe content digest: "sha256:<hex>". */
  digest: string;
}

/** A git reference pinned to its exact commit, without fetching content. */
export interface PinnedSkillRef {
  /** The reference rewritten with the commit sha, safe to store and re-run. */
  ref: string;
  gitUrl?: string;
  gitCommit?: string;
}

export interface SkillResolveOptions {
  /** Cache root; default ~/.cache/evolve/skills (or EVOLVE_SKILLS_CACHE). */
  cacheDir?: string;
  /** Environment for spawned git processes (server callers strip creds). */
  gitEnv?: NodeJS.ProcessEnv;
  /** ls-remote timeout; Harbor uses 30s (skills.py:261). */
  lsRemoteTimeoutMs?: number;
  /** Fetch/checkout timeout; Harbor uses 120s per command (skills.py:352). */
  checkoutTimeoutMs?: number;
}

export class SkillRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRefError";
  }
}

export class SkillResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillResolveError";
  }
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function splitTrailingRef(segment: string): { base: string; gitRef?: string } {
  const at = segment.indexOf("@");
  if (at === -1) return { base: segment };
  const gitRef = segment.slice(at + 1);
  if (!gitRef) {
    throw new SkillRefError(`Empty @ref in skill reference segment: ${JSON.stringify(segment)}`);
  }
  return { base: segment.slice(0, at), gitRef };
}

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function requireSegment(value: string, what: string, raw: string): string {
  if (!SEGMENT_RE.test(value)) {
    throw new SkillRefError(
      `Cannot parse skill reference ${JSON.stringify(raw)}: ${what} ${JSON.stringify(value)} may only contain letters, digits, ".", "_" and "-".`,
    );
  }
  return value;
}

/**
 * Parse one skill reference string. Throws SkillRefError with the accepted
 * forms when the string fits none of them.
 */
export function parseSkillRef(ref: string): ParsedSkillRef {
  const raw = String(ref ?? "").trim();
  if (!raw) {
    throw new SkillRefError("Skill reference cannot be empty.");
  }

  // Platform upload handle.
  if (raw.startsWith("upload:")) {
    const id = raw.slice("upload:".length);
    if (!id) throw new SkillRefError(`Skill upload reference ${JSON.stringify(raw)} names no upload id.`);
    return { kind: "upload", id, raw };
  }

  // Local folders — Harbor's prefix law (skills.py:136).
  if (raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("/") || raw.startsWith("~")) {
    return { kind: "local", path: expandTilde(raw), raw };
  }

  // skills.sh veneer: skills.sh/owner/repo[/skill][@ref], optional scheme.
  const skillsShMatch = raw.match(/^(?:https?:\/\/)?(?:www\.)?skills\.sh\/(.+)$/);
  if (skillsShMatch) {
    const rest = skillsShMatch[1].replace(/\/+$/, "");
    const parts = rest.split("/").filter(Boolean);
    if (parts.length < 2 || parts.length > 3) {
      throw new SkillRefError(
        `Cannot parse skill reference ${JSON.stringify(raw)}: expected skills.sh/<owner>/<repo> or skills.sh/<owner>/<repo>/<skill>, optionally @ref.`,
      );
    }
    const { base: last, gitRef } = splitTrailingRef(parts[parts.length - 1]);
    parts[parts.length - 1] = last;
    const [org, repo, skillName] = parts;
    requireSegment(org, "owner", raw);
    requireSegment(repo, "repo", raw);
    if (skillName !== undefined) requireSegment(skillName, "skill name", raw);
    return {
      kind: "git",
      host: "github.com",
      org,
      repo,
      ...(gitRef ? { gitRef } : {}),
      ...(skillName ? { skillName } : {}),
      viaSkillsSh: true,
      raw,
    };
  }

  // Full URL — Harbor's URL rule (skills.py:69-92).
  const urlMatch = raw.match(/^https?:\/\/([^/]+)\/(.+)$/);
  if (urlMatch) {
    const host = urlMatch[1];
    const parts = urlMatch[2].replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new SkillRefError(
        `Git URL must have at least org/name in the path: ${JSON.stringify(raw)}`,
      );
    }
    const org = parts[0];
    const repo = parts[1].replace(/\.git$/, "");
    let gitRef: string | undefined;
    let subdir: string | undefined;
    if (parts.length >= 4 && parts[2] === "tree") {
      gitRef = parts[3];
      if (parts.length > 4) subdir = parts.slice(4).join("/");
    }
    return {
      kind: "git",
      host,
      org,
      repo,
      ...(gitRef ? { gitRef } : {}),
      ...(subdir ? { subdir } : {}),
      viaSkillsSh: false,
      raw,
    };
  }

  // Shorthand org/repo[@ref] — Harbor's regex (skills.py:30-32).
  const m = raw.match(SHORTHAND_RE);
  if (m) {
    return {
      kind: "git",
      host: "github.com",
      org: m[1],
      repo: m[2],
      ...(m[3] ? { gitRef: m[3] } : {}),
      viaSkillsSh: false,
      raw,
    };
  }

  throw new SkillRefError(
    `Cannot parse skill reference ${JSON.stringify(raw)}. ` +
      "Expected skills.sh/<owner>/<repo>[/<skill>], org/repo[@ref], an https git URL, " +
      "or a local folder path (prefix relative paths with './').",
  );
}

export function skillCloneUrl(parsed: Extract<ParsedSkillRef, { kind: "git" }>): string {
  return `https://${parsed.host}/${parsed.org}/${parsed.repo}.git`;
}

export function skillDisplayUrl(parsed: Extract<ParsedSkillRef, { kind: "git" }>): string {
  return `https://${parsed.host}/${parsed.org}/${parsed.repo}`;
}

async function runGit(
  args: string[],
  opts: { cwd?: string; timeoutMs: number; gitEnv?: NodeJS.ProcessEnv },
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      env: opts.gitEnv ?? process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; killed?: boolean; message?: string };
    const detail = (err.stderr || err.message || "").trim();
    throw new SkillResolveError(
      `git ${args[0]} failed${err.killed ? " (timed out)" : ""}: ${detail}`,
    );
  }
}

/**
 * Resolve a git-backed reference to its exact commit sha via `git ls-remote`
 * — Harbor's pinning move (skills.py:252-279). A 40-hex ref is already a pin
 * and is returned as-is without touching the network.
 */
export async function resolveSkillSha(
  parsed: Extract<ParsedSkillRef, { kind: "git" }>,
  opts: SkillResolveOptions = {},
): Promise<string> {
  if (parsed.gitRef && SHA_RE.test(parsed.gitRef)) return parsed.gitRef;
  const ref = parsed.gitRef ?? "HEAD";
  const out = await runGit(["ls-remote", skillCloneUrl(parsed), ref], {
    timeoutMs: opts.lsRemoteTimeoutMs ?? 30_000,
    gitEnv: opts.gitEnv,
  });
  const first = out.trim().split("\n")[0];
  if (!first) {
    throw new SkillResolveError(
      `No matching ref ${JSON.stringify(ref)} found in ${skillDisplayUrl(parsed)}`,
    );
  }
  return first.split("\t")[0];
}

/**
 * Pin a reference: rewrite it so the same content resolves forever. Git refs
 * gain @<sha> (skills.sh forms keep their spelling; explicit /tree/ URLs get
 * the ref segment replaced). Local and upload refs pass through — a local
 * folder pins by digest, an upload is immutable by construction.
 */
export async function pinSkillRef(
  ref: SkillRef,
  opts: SkillResolveOptions = {},
): Promise<PinnedSkillRef> {
  const parsed = parseSkillRef(ref);
  if (parsed.kind !== "git") return { ref: parsed.raw };
  const sha = await resolveSkillSha(parsed, opts);
  let pinned: string;
  if (parsed.viaSkillsSh) {
    pinned = `skills.sh/${parsed.org}/${parsed.repo}${parsed.skillName ? `/${parsed.skillName}` : ""}@${sha}`;
  } else if (parsed.subdir !== undefined || parsed.raw.includes("://")) {
    pinned = `https://${parsed.host}/${parsed.org}/${parsed.repo}/tree/${sha}${parsed.subdir ? `/${parsed.subdir}` : ""}`;
  } else {
    pinned = `${parsed.org}/${parsed.repo}@${sha}`;
  }
  return { ref: pinned, gitUrl: skillDisplayUrl(parsed), gitCommit: sha };
}

/**
 * Harbor's content digest recipe, byte-for-byte (skills.py:200-209): sha256
 * over sorted relative paths, each contributing "<relpath>\0<sha256hex>\0".
 */
export async function computeSkillDigest(skillDir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const abs = rel === "" ? skillDir : join(skillDir, rel);
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(childRel);
      else if (entry.isFile()) files.push(childRel);
    }
  };
  await walk("");
  files.sort();
  const hasher = createHash("sha256");
  for (const rel of files) {
    const contentDigest = createHash("sha256")
      .update(await readFile(join(skillDir, rel)))
      .digest("hex");
    hasher.update(rel);
    hasher.update("\0");
    hasher.update(contentDigest);
    hasher.update("\0");
  }
  return `sha256:${hasher.digest("hex")}`;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Harbor's strict discovery law for an EXPLICIT directory (skills.py:382-416):
 * the directory is one skill (has SKILL.md), or a root whose immediate child
 * directories are each a skill — a child without SKILL.md is a loud refusal.
 */
async function findSkillDirsStrict(path: string, described: string): Promise<string[]> {
  if (!(await isDir(path))) {
    throw new SkillResolveError(`Skill path does not exist or is not a directory: ${described}`);
  }
  if (await isFile(join(path, SKILL_FILE_NAME))) return [path];

  const entries = await readdir(path, { withFileTypes: true });
  const childDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  const invalid: string[] = [];
  const skills: string[] = [];
  for (const name of childDirs) {
    if (await isFile(join(path, name, SKILL_FILE_NAME))) skills.push(join(path, name));
    else invalid.push(name);
  }
  if (invalid.length > 0) {
    throw new SkillResolveError(
      `Skill root ${described} contains child directories without ${SKILL_FILE_NAME}: ${invalid.join(", ")}`,
    );
  }
  if (skills.length === 0) {
    throw new SkillResolveError(
      `Skill path ${described} must be a skill directory containing ${SKILL_FILE_NAME}, ` +
        `or a root whose immediate child directories each contain ${SKILL_FILE_NAME}.`,
    );
  }
  return skills;
}

/**
 * Ecosystem discovery for whole-repo references: search the standard
 * containers, tolerate non-skill siblings, and accept a SKILL.md at the repo
 * root as one skill named after the repo.
 */
async function findSkillDirsStandard(root: string): Promise<Array<{ dir: string; name: string }>> {
  const found = new Map<string, string>(); // name -> dir, last wins
  if (await isFile(join(root, SKILL_FILE_NAME))) {
    found.set(basename(root), root);
  }
  for (const container of STANDARD_CONTAINERS) {
    const containerAbs = join(root, container);
    if (!(await isDir(containerAbs))) continue;
    const entries = await readdir(containerAbs, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = join(containerAbs, entry.name);
      if (await isFile(join(dir, SKILL_FILE_NAME))) found.set(entry.name, dir);
    }
  }
  return Array.from(found, ([name, dir]) => ({ dir, name }));
}

function cacheRoot(opts: SkillResolveOptions): string {
  return opts.cacheDir ?? process.env.EVOLVE_SKILLS_CACHE ?? DEFAULT_CACHE_DIR;
}

/**
 * Fetch a repo at an exact sha into the content cache and return the checkout
 * TREE. Cache entries are keyed {host}/{org}/{repo}/{sha} (Harbor's layout,
 * skills.py:234-249). Inside an entry the checkout lives in a directory named
 * after the repo — so a repo whose skill is a root SKILL.md resolves to a
 * skill named after the repo, never the sha — and the `.evolve-complete`
 * completeness marker sits BESIDE that tree, never inside it, so digests and
 * mounted content stay marker-free (one folder digests identically under
 * Harbor and here). A racing second resolver at worst repeats the checkout
 * into a temp dir and discards it — never corrupts the winner (Harbor accepts
 * the same worst case on Windows, skills.py:179-183).
 */
async function ensureCheckout(
  parsed: Extract<ParsedSkillRef, { kind: "git" }>,
  sha: string,
  opts: SkillResolveOptions,
): Promise<string> {
  const entry = join(cacheRoot(opts), parsed.host, parsed.org, parsed.repo, sha);
  const tree = join(entry, parsed.repo);
  const marker = join(entry, ".evolve-complete");
  if ((await isFile(marker)) && (await isDir(tree))) return tree;

  await mkdir(dirname(entry), { recursive: true });
  const tmp = await mkdtemp(`${entry}.tmp-`);
  const tmpTree = join(tmp, parsed.repo);
  const timeoutMs = opts.checkoutTimeoutMs ?? 120_000;
  const gitOpts = { cwd: tmpTree, timeoutMs, gitEnv: opts.gitEnv };
  try {
    await mkdir(tmpTree);
    await runGit(["init", "--quiet"], gitOpts);
    await runGit(["remote", "add", "origin", skillCloneUrl(parsed)], gitOpts);
    if (parsed.subdir) {
      // Explicit subdir: sparse to exactly it (Harbor skills.py:310-330).
      await runGit(["sparse-checkout", "init", "--cone"], gitOpts);
      await runGit(["sparse-checkout", "set", parsed.subdir], gitOpts);
    } else {
      // Whole-repo reference: sparse to the standard containers; cone mode
      // keeps repo-root files, so a root SKILL.md still arrives.
      await runGit(["sparse-checkout", "init", "--cone"], gitOpts);
      await runGit(["sparse-checkout", "set", ...STANDARD_CONTAINERS], gitOpts);
    }
    await runGit(["fetch", "--quiet", "--depth=1", "origin", sha], gitOpts);
    await runGit(["checkout", "--quiet", "FETCH_HEAD"], gitOpts);
    await rm(join(tmpTree, ".git"), { recursive: true, force: true });
    await writeFile(join(tmp, ".evolve-complete"), "");
    // An entry present without a valid marker-plus-tree pair is stale (a
    // half-written or older-layout entry): clear it before claiming the slot.
    await rm(entry, { recursive: true, force: true });
    try {
      await rename(tmp, entry);
    } catch {
      // Lost the race — the winner's checkout is byte-identical (same sha).
      await rm(tmp, { recursive: true, force: true });
    }
    return tree;
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

async function checkSkillSize(dir: string, described: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const walk = async (p: string): Promise<void> => {
    const entries = await readdir(p, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(p, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(abs)).size;
        if (files > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
          throw new SkillResolveError(
            `Skill ${described} exceeds the size ceiling (${MAX_SKILL_FILES} files / ${MAX_SKILL_BYTES} bytes) — a skill is instructions, not a dataset.`,
          );
        }
      }
    }
  };
  await walk(dir);
}

/**
 * Resolve a list of skill references to local content with provenance.
 * Fetches ONLY what the list names, pins every git ref to its exact commit,
 * reuses the content cache, de-duplicates names last-wins and returns the
 * set sorted by name (Harbor resolve_skills, skills.py:111-123).
 */
export async function resolveSkills(
  refs: SkillRef[],
  opts: SkillResolveOptions = {},
): Promise<ResolvedSkill[]> {
  const resolved = new Map<string, ResolvedSkill>(); // name -> skill, last wins

  for (const ref of refs) {
    const parsed = parseSkillRef(ref);

    if (parsed.kind === "upload") {
      throw new SkillResolveError(
        `Skill reference ${JSON.stringify(parsed.raw)} is a platform upload handle; ` +
          "only the hosted platform can resolve it. Use a skills.sh/git reference or a local folder here.",
      );
    }

    if (parsed.kind === "local") {
      const dirs = await findSkillDirsStrict(parsed.path, parsed.raw);
      for (const dir of dirs) {
        await checkSkillSize(dir, parsed.raw);
        resolved.set(basename(dir), {
          name: basename(dir),
          dir,
          source: parsed.raw,
          digest: await computeSkillDigest(dir),
        });
      }
      continue;
    }

    const sha = await resolveSkillSha(parsed, opts);
    const root = await ensureCheckout(parsed, sha, opts);

    let candidates: Array<{ dir: string; name: string }>;
    if (parsed.subdir) {
      const dirs = await findSkillDirsStrict(join(root, parsed.subdir), `${parsed.raw} (${parsed.subdir})`);
      candidates = dirs.map((dir) => ({ dir, name: basename(dir) }));
    } else {
      candidates = await findSkillDirsStandard(root);
      if (candidates.length === 0) {
        throw new SkillResolveError(
          `No skills found in ${skillDisplayUrl(parsed)}@${sha.slice(0, 12)}: ` +
            `expected ${SKILL_FILE_NAME} at the repo root or under ${STANDARD_CONTAINERS.join(", ")}.`,
        );
      }
    }

    if (parsed.skillName) {
      const hit = candidates.filter((c) => c.name === parsed.skillName);
      if (hit.length === 0) {
        throw new SkillResolveError(
          `Skill ${JSON.stringify(parsed.skillName)} not found in ${skillDisplayUrl(parsed)}@${sha.slice(0, 12)}. ` +
            `Available: ${candidates.map((c) => c.name).sort().join(", ") || "(none)"}`,
        );
      }
      candidates = hit;
    }

    for (const { dir, name } of candidates) {
      await checkSkillSize(dir, parsed.raw);
      resolved.set(name, {
        name,
        dir,
        source: parsed.raw,
        gitUrl: skillDisplayUrl(parsed),
        gitCommit: sha,
        digest: await computeSkillDigest(dir),
      });
    }
  }

  return Array.from(resolved.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The minimal sandbox surface mounting needs — agent.ts passes its own. */
export interface SkillMountTarget {
  files: {
    write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void>;
    makeDir(path: string): Promise<void>;
  };
  commands: {
    run(command: string, opts?: { timeoutMs?: number }): Promise<unknown>;
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Mount resolved skills into a sandbox directory: each skill travels as one
 * deterministic gzipped tarball (executable bits preserved, symlinks and .git
 * never packed — hosted/tar.ts law) and is extracted into
 * `<targetDir>/<name>/`. The harness then discovers it natively.
 */
export async function mountSkills(
  sandbox: SkillMountTarget,
  skills: ResolvedSkill[],
  targetDir: string,
): Promise<void> {
  if (skills.length === 0) return;
  const { tarGzipDirectory } = await import("./hosted/tar.js");
  await sandbox.files.makeDir(targetDir);
  for (const skill of skills) {
    const tarball = await tarGzipDirectory(skill.dir);
    const remoteTar = `${targetDir}/.evolve-skill-${skill.name}.tgz`;
    const remoteDir = `${targetDir}/${skill.name}`;
    await sandbox.files.write(remoteTar, tarball);
    await sandbox.commands.run(
      `mkdir -p ${shellQuote(remoteDir)} && tar -xzf ${shellQuote(remoteTar)} -C ${shellQuote(remoteDir)} && rm -f ${shellQuote(remoteTar)}`,
      { timeoutMs: 60_000 },
    );
  }
}
