/**
 * Teardown that can be TRUSTED, for the live integration tests.
 *
 * THE BUG THIS REPLACES. Every test in this directory ended its sandbox with
 * some variant of:
 *
 *     await evolve.kill().catch(() => {});
 *
 * A kill that rejects there leaves the sandbox ALIVE, says nothing, and lets
 * the test report PASS. That is not a theoretical hole: two stale running
 * sandboxes were found by hand on the e2b dashboard and killed by their owner,
 * after runs that had reported success. A leaked sandbox bills until someone
 * notices it, and nothing in a green log points at it.
 *
 * The catch was not careless, either — it is there because a kill failure
 * should not mask the real test failure that preceded it. That intent is kept.
 * What changes is that the failure stops being SILENT.
 *
 * THREE LAYERS, in increasing order of what they actually prove:
 *
 *   1. hardKill() retries once, then reports loudly and remembers. A blip gets
 *      a second chance; a real failure is named with its sandbox id.
 *   2. Every box carries a per-run marker in its metadata, so a leak can be
 *      traced to the run that made it instead of being an anonymous box on a
 *      dashboard.
 *   3. reportLeaks() asks the PROVIDER what is still alive and compares. This
 *      is the layer that matters: teardown which merely LOOKS right is exactly
 *      what let the two stale boxes survive green runs, so the check has to
 *      come from outside the code path that was supposed to do the killing.
 *
 * WHY NOTHING HERE THROWS. These files are scripts that end in process.exit()
 * with a meaning attached — 0 is a passing test, 1 is a failing one. Teardown
 * trouble must not be able to turn a genuine product failure into a confusing
 * one, so this records rather than raises, and `teardownFailed()` lets the
 * caller fold it into its own exit code where that makes sense.
 */

import type { SandboxProvider } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { createDaytonaProvider } from "../../../daytona/src/index.js";
import { createModalProvider } from "../../../modal/src/index.js";

/** Stamped into every sandbox this process creates. */
export const E2E_RUN_ID = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Set when a kill failed or a leak was found. Never reset. */
let teardownProblem = false;

/** Did any teardown in this process fail to do its job? */
export function teardownFailed(): boolean {
  return teardownProblem;
}

/**
 * Create-time options that make a sandbox traceable to this run.
 *
 * Spread into `.withSandboxCreateOptions({ ... })`. `test` is the file's own
 * name so a leak names the test that made it, not just the run.
 *
 * Inert by design: metadata changes nothing about how the sandbox behaves, so
 * adding this cannot alter what any test is measuring.
 */
export function e2eSandboxOptions(test: string): {
  metadata: Record<string, string>;
} {
  return { metadata: { e2e: test, run: E2E_RUN_ID } };
}

/** The subset of a session/sandbox this module needs in order to end it. */
type Killable = { kill: () => Promise<unknown> };

/**
 * Kill something and REFUSE TO BE QUIET ABOUT FAILING.
 *
 * Never throws — see the note at the top about exit codes carrying meaning.
 * `label` is whatever helps a reader find the box: a session name, a sandbox
 * id, the test's own name.
 */
export async function hardKill(target: Killable, label: string): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await target.kill();
      return;
    } catch (e) {
      if (attempt === 2) {
        teardownProblem = true;
        console.error(
          `[teardown] FAILED to kill ${label} after 2 attempts: ${e instanceof Error ? e.message : String(e)}\n` +
            `[teardown] a sandbox may still be RUNNING and billing — check the provider dashboard for run ${E2E_RUN_ID}`,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Ask the provider whether anything from this run is still alive, and say so.
 *
 * Best-effort BY DESIGN, and the distinction matters: a provider that cannot
 * be listed (no `list`, an auth failure, a network blip) is reported as
 * "could not check" and does NOT mark teardown failed, because absence of an
 * answer is not evidence of a leak. Only a sandbox actually seen alive with
 * this run's marker counts.
 */
export async function reportLeaks(provider: SandboxProvider, test: string): Promise<void> {
  if (typeof provider.list !== "function") {
    console.log(`[teardown] ${test}: provider ${provider.providerType} cannot list; leak check skipped`);
    return;
  }
  let alive: Array<{ sandboxId: string; metadata?: Record<string, string> }>;
  try {
    alive = await provider.list({ limit: 200 });
  } catch (e) {
    console.log(
      `[teardown] ${test}: could not list ${provider.providerType} sandboxes, leak check inconclusive: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  const leaked = alive.filter((s) => s.metadata?.run === E2E_RUN_ID);
  if (leaked.length === 0) {
    console.log(`[teardown] ${test}: ${provider.providerType} clean — no sandbox from this run left alive`);
    return;
  }
  teardownProblem = true;
  console.error(`[teardown] ${test}: ${leaked.length} LEAKED ${provider.providerType} sandbox(es) still running:`);
  for (const s of leaked) {
    console.error(`[teardown]   ${s.sandboxId} ${JSON.stringify(s.metadata ?? {})}`);
  }
}

/**
 * Every provider this process could plausibly have created a sandbox on,
 * built from whatever credentials are in the environment.
 *
 * WHY BUILD OUR OWN instead of taking the test's handle: most of these files
 * create their session inside a helper that returns a result, so there is no
 * single place where both "the run is over" and "the provider" are in scope.
 * Asking for a handle would have meant restructuring ten files that cannot be
 * run green here. Credentials are already required for the test to have run at
 * all, so constructing a client from them adds no new requirement — and a
 * provider whose key is absent simply cannot have been used.
 */
function providersFromEnv(): SandboxProvider[] {
  const out: SandboxProvider[] = [];
  if (process.env.E2B_API_KEY) out.push(createE2BProvider({ apiKey: process.env.E2B_API_KEY }));
  if (process.env.DAYTONA_API_KEY) out.push(createDaytonaProvider({ apiKey: process.env.DAYTONA_API_KEY }));
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) out.push(createModalProvider());
  return out;
}

/**
 * End the process the way an integration script should: sweep every provider
 * this run could have touched, then exit.
 *
 * REPLACES `process.exit(code)` AT EVERY EXIT POINT, and keeps its contract —
 * control never returns to the caller, so the surrounding code behaves exactly
 * as it did before.
 *
 * A PASSING RUN THAT LEAKED IS NOT A PASSING RUN: a zero exit is upgraded to 1
 * when teardown failed or a sandbox from this run is still alive. A non-zero
 * code is left alone — the test's own verdict is the more important one, and
 * the leak is reported in the log either way.
 *
 * Deliberately NOT a process.exit monkey-patch, which would have been the only
 * true one-call-site option: overriding exit means the caller keeps running
 * after asking to terminate, and these files call it from inside try blocks,
 * catch handlers and loops. Replacing each call is more edits and far less
 * clever, which is the right trade in files nobody can run green here.
 */
export async function finishE2E(test: string, code: number): Promise<never> {
  const providers = providersFromEnv();
  if (providers.length === 0) {
    console.log(`[teardown] ${test}: no provider credentials in env; leak check skipped`);
  }
  for (const provider of providers) {
    await reportLeaks(provider, test);
  }
  const exitCode = code === 0 && teardownFailed() ? 1 : code;
  if (exitCode !== code) {
    console.error(`[teardown] ${test}: exiting 1 instead of 0 — the run could not prove it cleaned up`);
  }
  process.exit(exitCode);
}
