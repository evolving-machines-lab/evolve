import { posix } from "path";
import type { FileMap, SandboxInstance } from "./types";

const MAX_ARTIFACT_FILES = 256;
const MAX_ARTIFACT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 500 * 1024 * 1024;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Collect declared files/directories from the sandbox as text content.
 *
 * TEXT-ONLY contract: contents are returned as strings. ASCII-armored formats
 * (git patches incl. `--binary` hunks, JSON, logs) are safe; raw binary files
 * are not and need a bytes path if ever required.
 */
export async function collectSandboxArtifacts(
  sandbox: SandboxInstance,
  workingDirectory: string,
  paths: string[],
): Promise<FileMap> {
  if (paths.length === 0 || paths.length > MAX_ARTIFACT_FILES) {
    throw new Error(
      `collectArtifacts() requires between 1 and ${MAX_ARTIFACT_FILES} paths.`,
    );
  }

  const roots = paths.map((input) => {
    if (!input || input.includes("\0")) {
      throw new Error(`Invalid artifact path: ${JSON.stringify(input)}`);
    }
    const value = posix.normalize(input);
    if (!posix.isAbsolute(value) && (value === ".." || value.startsWith("../"))) {
      throw new Error(`Artifact path escapes the working directory: ${input}`);
    }
    return posix.isAbsolute(value) ? value : posix.join(workingDirectory, value);
  });

  // A missing or unreadable declared root is an infrastructure failure — it must
  // never read as "the agent produced nothing". An empty result is legitimate
  // only when every declared root exists and is readable.
  const rootCheck = await sandbox.commands.run(
    roots
      .map(
        (root) =>
          `if [ ! -e ${shellQuote(root)} ]; then echo MISSING ${shellQuote(root)}; elif [ ! -r ${shellQuote(root)} ]; then echo UNREADABLE ${shellQuote(root)}; fi`,
      )
      .join("; "),
    { cwd: workingDirectory, timeoutMs: 15_000 },
  );
  const rootProblems = rootCheck.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (rootProblems.length > 0) {
    throw new Error(`Artifact roots are not collectable: ${rootProblems.join("; ")}`);
  }

  let listing;
  try {
    listing = await sandbox.commands.run(
      `find -- ${roots.map(shellQuote).join(" ")} -type f -printf '%p\\0%s\\0'`,
      { cwd: workingDirectory, timeoutMs: 30_000 },
    );
  } catch (error) {
    throw new Error(`Artifact listing failed: ${(error as Error).message}`);
  }
  if (listing.exitCode !== 0) {
    throw new Error(
      `Artifact listing failed (exit ${listing.exitCode}): ${(listing.stderr || "").slice(0, 500)}`,
    );
  }
  const fields = listing.stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) {
    throw new Error("Sandbox returned malformed artifact metadata.");
  }

  const filesByPath = new Map<string, number>();
  let totalBytes = 0;
  for (let index = 0; index < fields.length; index += 2) {
    const fullPath = fields[index];
    const sizeBytes = Number(fields[index + 1]);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error(`Sandbox returned an invalid artifact size: ${fullPath}`);
    }
    if (sizeBytes > MAX_ARTIFACT_FILE_BYTES) {
      throw new Error(`Artifact exceeds ${MAX_ARTIFACT_FILE_BYTES} bytes: ${fullPath}`);
    }
    if (!filesByPath.has(fullPath)) {
      filesByPath.set(fullPath, sizeBytes);
      totalBytes += sizeBytes;
    }
  }
  if (filesByPath.size > MAX_ARTIFACT_FILES) {
    throw new Error(`Artifact collection exceeds ${MAX_ARTIFACT_FILES} files.`);
  }
  if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
    throw new Error(`Artifact collection exceeds ${MAX_ARTIFACT_TOTAL_BYTES} bytes.`);
  }

  const files: FileMap = {};
  for (const fullPath of [...filesByPath.keys()].sort()) {
    const declared = roots.some(
      (root) => fullPath === root || fullPath.startsWith(`${root.replace(/\/$/, "")}/`),
    );
    if (!posix.isAbsolute(fullPath) || !declared) {
      throw new Error(`Sandbox returned an invalid artifact path: ${fullPath}`);
    }
    const relativePath = posix.relative(workingDirectory, fullPath);
    const key = relativePath && relativePath !== ".." && !relativePath.startsWith("../")
      ? relativePath
      : fullPath;
    files[key] = await sandbox.files.read(fullPath);
  }
  return files;
}
