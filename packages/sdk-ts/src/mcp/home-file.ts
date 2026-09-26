/**
 * Files the SDK writes into the sandbox's config home — settings, per-run routing
 * files, session state — belong to the HOME'S OWNER, read off the directory itself.
 * The SDK may run as another account than the harness that reads them (a host that
 * runs commands as root and points the home at the agent's account); a file the
 * reader cannot open kills the harness at startup. Harbor's installed agents chown
 * their config uploads to the agent user at write time (agents/installed/base.py).
 * When the owner is the writer nothing changes hands; a refused hand-over fails the
 * write. `chown -h`, one level each: a symlink is the entry, never its target.
 */
import { DEFAULT_HOME_DIR } from "../constants";
import type { SandboxInstance } from "../types";
import { shellSingleQuote } from "../utils/shell";

export interface HomeFileOptions {
  /** The config home the path lives under. Default: the SDK's default home. */
  homeDir?: string;
  /** Octal mode set on the file after the write, for a file that holds a credential. */
  mode?: string;
}

/** Every directory below the home on the way to the file, then the file: the entries one write can create. */
export function homeFileChain(homeDir: string, path: string): string[] {
  const prefix = homeDir.endsWith("/") ? homeDir : `${homeDir}/`;
  if (!path.startsWith(prefix)) {
    throw new Error(`${path} is not inside the config home ${homeDir}`);
  }
  const parts = path.slice(prefix.length).split("/").filter((part) => part.length > 0);
  return parts.map((_, index) => prefix + parts.slice(0, index + 1).join("/"));
}

/** The hand-over as one shell command; `mode` appends the chmod of the file. */
export function homeFileOwnershipCommand(homeDir: string, path: string, mode?: string): string {
  const chain = homeFileChain(homeDir, path).map(shellSingleQuote).join(" ");
  const handOver =
    `o="$(stat -c %u:%g ${shellSingleQuote(homeDir)})" && ` +
    `{ [ "\${o%%:*}" = "$(id -u)" ] || chown -h "$o" ${chain}; }`;
  return mode ? `${handOver} && chmod ${mode} ${shellSingleQuote(path)}` : handOver;
}

/** Make the file's directory, write the file, hand both to the home's owner. */
export async function writeHomeFile(
  sandbox: SandboxInstance,
  path: string,
  content: string,
  options: HomeFileOptions = {},
): Promise<void> {
  const homeDir = options.homeDir ?? DEFAULT_HOME_DIR;
  // Built first: a path outside the home is refused before anything lands.
  const command = homeFileOwnershipCommand(homeDir, path, options.mode);
  await sandbox.files.makeDir(path.slice(0, path.lastIndexOf("/")));
  await sandbox.files.write(path, content);
  await sandbox.commands.run(command, { timeoutMs: 10000 });
}
