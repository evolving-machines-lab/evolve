// The SDK may write config as one account for a harness that runs as another, and a file the reader
// cannot open kills it at startup: every home write is handed over (as Harbor does, installed/base.py).
import { DEFAULT_HOME_DIR } from "../constants";
import type { SandboxCommandResult, SandboxInstance } from "../types";
import { EvolveConfigError } from "../utils/config";
import { shellSingleQuote } from "../utils/shell";

/** What `chown` takes — a user name, a uid, or uid:gid — and nothing a shell could read otherwise. */
const HOME_OWNER_RE = /^(?:[A-Za-z_][A-Za-z0-9_-]*\$?|[0-9]+(?::[0-9]+)?)$/;

const COMMAND_TIMEOUT_MS = 10000;

export interface HomeFileOptions {
  /** The config home the path lives under. Default: the SDK's default home. */
  homeDir?: string;
  /** The account the file is written for. Default: the owner of `homeDir`. */
  owner?: string;
  /** Octal mode set on the file after the write, for a file that holds a credential. */
  mode?: string;
}

/** A home write whose directory could not be prepared or whose hand-over the box refused. */
export class HomeFileError extends Error {
  constructor(
    readonly path: string,
    readonly step: "prepare" | "hand-over",
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    const what = step === "prepare" ? "preparing the directory of" : "handing over";
    super(`${what} ${path} failed (exit ${exitCode}): ${stderr.trim() || "no stderr"}`);
    this.name = "HomeFileError";
  }
}

export function validateHomeOwner(owner: string): string {
  const value = owner.trim();
  if (!HOME_OWNER_RE.test(value)) {
    throw new EvolveConfigError("homeOwner", `homeOwner must be a user name, a uid, or uid:gid; got ${JSON.stringify(owner)}`);
  }
  return value;
}

/** Every directory below the home on the way to the file, then the file. */
export function homeFileChain(homeDir: string, path: string): string[] {
  const prefix = homeDir.endsWith("/") ? homeDir : `${homeDir}/`;
  if (!path.startsWith(prefix)) {
    throw new Error(`${path} is not inside the config home ${homeDir}`);
  }
  const parts = path.slice(prefix.length).split("/").filter((part) => part.length > 0);
  return parts.map((_, index) => prefix + parts.slice(0, index + 1).join("/"));
}

/** Creates the missing directories one level at a time and prints each one made, so only they change hands. */
export function homeFilePrepareCommand(homeDir: string, path: string): string {
  const dirs = homeFileChain(homeDir, path).slice(0, -1);
  if (dirs.length === 0) return "true";
  // `-d`, not `-e`: a file where a directory must be fails here (mkdir EEXIST), not at the write.
  return `for d in ${dirs.map(shellSingleQuote).join(" ")}; do [ -d "$d" ] || { mkdir "$d" && printf '%s\\n' "$d" || exit 1; }; done`;
}

export function homeFileOwnershipCommand(
  homeDir: string,
  path: string,
  createdDirs: readonly string[],
  options: Pick<HomeFileOptions, "owner" | "mode"> = {},
): string {
  const chown = `chown -h "$o" ${[...createdDirs, path].map(shellSingleQuote).join(" ")}`;
  const handOver = options.owner
    ? `o=${shellSingleQuote(validateHomeOwner(options.owner))} && ${chown}`
    : `o="$(stat -c %u:%g ${shellSingleQuote(homeDir)})" && { [ "\${o%%:*}" = "$(id -u)" ] || ${chown}; }`;
  return options.mode ? `${handOver} && chmod ${options.mode} ${shellSingleQuote(path)}` : handOver;
}

/** Prepare the file's directories, write the file, hand the new directories and the file to their owner. */
export async function writeHomeFile(
  sandbox: SandboxInstance,
  path: string,
  content: string,
  options: HomeFileOptions = {},
): Promise<void> {
  const homeDir = options.homeDir ?? DEFAULT_HOME_DIR;
  const chain = homeFileChain(homeDir, path);
  const prepared = await sandbox.commands.run(homeFilePrepareCommand(homeDir, path), { timeoutMs: COMMAND_TIMEOUT_MS });
  failLoud(path, "prepare", prepared);
  // Only names the command printed AND this write asked for: the box's stdout never picks a chown target.
  const printed = new Set(prepared.stdout.split("\n").map((line) => line.trim()));
  const created = chain.slice(0, -1).filter((dir) => printed.has(dir));
  await sandbox.files.write(path, content);
  const handed = await sandbox.commands.run(homeFileOwnershipCommand(homeDir, path, created, options), {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  failLoud(path, "hand-over", handed);
}

function failLoud(path: string, step: HomeFileError["step"], result: SandboxCommandResult): void {
  if (result.exitCode !== 0) throw new HomeFileError(path, step, result.exitCode, result.stderr ?? "");
}
