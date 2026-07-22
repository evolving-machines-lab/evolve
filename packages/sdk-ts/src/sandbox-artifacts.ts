import { posix } from "path";
import type { FileMap, SandboxInstance } from "./types";

const MAX_ARTIFACT_FILES = 256;
const MAX_ARTIFACT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 500 * 1024 * 1024;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

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

  const listing = await sandbox.commands.run(
    `find -- ${roots.map(shellQuote).join(" ")} -type f -printf '%p\\0%s\\0' 2>/dev/null || true`,
    { cwd: workingDirectory, timeoutMs: 30_000 },
  );
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
