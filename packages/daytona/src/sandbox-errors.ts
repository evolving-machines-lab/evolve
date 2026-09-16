// SOURCE of the sandbox observation errors; the provider packages carry generated copies
// (`npm run generate:sandbox-errors`) because the SDK depends on them and cannot be imported back.
// Recognise an instance by NAME (the guards below): a copy's instanceof never matches.

/** A capability this provider lacks: `feature` in dotted form (`files.watchDir`), `provider` type, optional `reason`. */
export class SandboxFeatureUnsupportedError extends Error {
  readonly feature: string;
  readonly provider: string;
  readonly reason?: string;

  constructor(feature: string, provider: string, reason?: string) {
    super(`${provider} does not support ${feature}${reason ? `: ${reason}` : ""}`);
    this.name = "SandboxFeatureUnsupportedError";
    this.feature = feature;
    this.provider = provider;
    this.reason = reason;
  }
}

/** A path the sandbox does not have — never an empty success. */
export class SandboxPathNotFoundError extends Error {
  readonly path: string;
  readonly provider: string;

  constructor(path: string, provider: string) {
    super(`${provider}: no such file or directory: ${path}`);
    this.name = "SandboxPathNotFoundError";
    this.path = path;
    this.provider = provider;
  }
}

/** An inspect refused because the sandbox is not running; `state` is the provider's own word (`paused`, `exited with code 137`). */
export class SandboxNotRunningError extends Error {
  readonly sandboxId: string;
  readonly provider: string;
  readonly state: string;

  constructor(sandboxId: string, provider: string, state: string) {
    super(`${provider} sandbox ${sandboxId} is not running (${state}); inspect never starts or resumes a sandbox`);
    this.name = "SandboxNotRunningError";
    this.sandboxId = sandboxId;
    this.provider = provider;
    this.state = state;
  }
}

function named(err: unknown, name: string): err is Error {
  return !!err && typeof err === "object" && (err as { name?: unknown }).name === name;
}

/** True for a SandboxFeatureUnsupportedError from ANY package's copy. */
export function isSandboxFeatureUnsupportedError(err: unknown): err is SandboxFeatureUnsupportedError {
  return named(err, "SandboxFeatureUnsupportedError");
}

/** True for a SandboxPathNotFoundError from ANY package's copy. */
export function isSandboxPathNotFoundError(err: unknown): err is SandboxPathNotFoundError {
  return named(err, "SandboxPathNotFoundError");
}

/** True for a SandboxNotRunningError from ANY package's copy. */
export function isSandboxNotRunningError(err: unknown): err is SandboxNotRunningError {
  return named(err, "SandboxNotRunningError");
}
