/**
 * The typed refusals of the sandbox observation surface — ONE home, three
 * declared mirrors.
 *
 * SOURCE: packages/sdk-ts/src/sandbox-errors.ts. The provider packages
 * (@evolvingmachines/e2b, /daytona, /modal) cannot import this package — the
 * SDK depends on them, so the build order is providers → sdk — and each
 * therefore carries a GENERATED copy at packages/<provider>/src/sandbox-errors.ts.
 * `npm run generate:sandbox-errors` (repo root) rewrites the copies from this
 * file; packages/sdk-ts/tests/unit/sandbox-errors.test.ts fails the unit suite
 * whenever a copy is stale. Edit the source, never a mirror.
 *
 * Because the copies are separate classes, `instanceof` cannot recognise an
 * instance across a package boundary. Match by NAME through the guards below —
 * the same rule the e2b adapter applies to the vendor's TimeoutError, and for
 * the same reason: a duplicated class must not turn a typed refusal back into
 * an unrecognised throw.
 */

/**
 * A capability this provider does not have — full support or a typed
 * refusal, never a silent fallback (the honesty law). `feature` is the
 * contract member in dotted form (`files.watchDir`, `commands.kill`,
 * `metrics`), `provider` the provider type (`e2b`, `daytona`, `modal`), and
 * `reason`, when given, says why and what to do instead.
 */
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

/** A path the sandbox does not have — `not_found`, never an empty success. */
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

/**
 * An inspect-only attach refused because the sandbox is not running.
 * `state` is the provider's own word for what it is instead (`paused`,
 * `stopped`, `exited with code 137`); attaching would have meant starting
 * or resuming it, which an observer must never do.
 */
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
