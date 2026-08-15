#!/usr/bin/env tsx
/**
 * Unit Test: RunOptions.resume — asking for a FRESH conversation in a sandbox
 * the agent has already run in.
 *
 * WHY THIS OPTION EXISTS. The resume flag used to be bound to internal state
 * with no way to override it: `isResume: this.hasRun`. The first run in a
 * sandbox was fresh, every run after it resumed, and a session attached with
 * `withSession()` resumed too (connecting sets hasRun, since the agent may
 * already have run there). That default is right for a chat-shaped session,
 * where each turn builds on the last.
 *
 * It is wrong for a sequence of INDEPENDENT tasks against one shared sandbox,
 * which is exactly the shape of a Harbor multi-step task: the steps share a
 * container and, by default, each step starts the agent in a fresh conversation
 * (harbor docs/content/docs/tasks/multi-step.mdx:210, trial/trial.py:474-479
 * picking agent.run over agent.resume). An evaluator driving N steps in one box
 * therefore had no way to reproduce the benchmark's own default, and silently
 * made every step after the first easier than intended.
 *
 * WHAT THIS PINS:
 *   - the resolution rule, `resume ?? hasRun`: an explicit value wins in BOTH
 *     directions, and omitting it keeps the previous behavior exactly;
 *   - the flag emission for EVERY harness shape, fresh vs resumed, so a
 *     registry edit that drops a resume flag fails here rather than in a run.
 *
 * Usage:
 *   npx tsx tests/unit/run-resume-option.test.ts
 */

import { AGENT_REGISTRY } from "../../src/registry.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

// =============================================================================
// [1] The resolution rule: resume ?? hasRun
// =============================================================================
console.log("\n[1] RunOptions.resume overrides hasRun in both directions");

/** The exact expression agent.ts evaluates when it builds a command. */
const resolveIsResume = (resume: boolean | undefined, hasRun: boolean): boolean =>
  resume ?? hasRun;

assert(resolveIsResume(undefined, false) === false, "omitted + first run = fresh (unchanged default)");
assert(resolveIsResume(undefined, true) === true, "omitted + has run = resume (unchanged default)");
assert(
  resolveIsResume(false, true) === false,
  "resume:false forces a FRESH conversation in a sandbox the agent has run in — the multi-step case",
);
assert(resolveIsResume(true, false) === true, "resume:true forces a resume even on the first run");
assert(resolveIsResume(false, false) === false, "resume:false on a first run is a no-op");
assert(resolveIsResume(true, true) === true, "resume:true on a later run is a no-op");

// =============================================================================
// [2] Flag emission per harness shape, fresh vs resumed
// =============================================================================
console.log("\n[2] every harness emits its own resume flag, and omits it when fresh");

/**
 * One row per harness: the marker its CLI uses to continue a session, and any
 * extra buildCommand input that marker needs. Droid is the odd one — it
 * resumes by SESSION ID, so `isResume` alone emits nothing.
 */
const HARNESS_RESUME_MARKERS: Array<{
  harness: keyof typeof AGENT_REGISTRY;
  marker: string;
  extra?: Record<string, unknown>;
}> = [
  { harness: "claude", marker: "--continue" },
  { harness: "codex", marker: "resume --last" },
  { harness: "gemini", marker: "--resume latest" },
  { harness: "qwen", marker: "--continue" },
  { harness: "kimi", marker: "--continue" },
  { harness: "opencode", marker: "--continue" },
  { harness: "droid", marker: "--session-id", extra: { sessionId: "droid-session-123" } },
];

for (const { harness, marker, extra } of HARNESS_RESUME_MARKERS) {
  const entry = AGENT_REGISTRY[harness];
  const base = {
    prompt: "do the thing",
    model: entry.defaultModel,
    isDirectMode: false,
    ...extra,
  };

  const fresh = entry.buildCommand({ ...base, isResume: false } as never);
  const resumed = entry.buildCommand({ ...base, isResume: true } as never);

  assert(!fresh.includes(marker), `${harness}: a fresh run carries no ${marker}`);
  assert(resumed.includes(marker), `${harness}: a resumed run carries ${marker}`);
  assert(fresh !== resumed, `${harness}: the two commands actually differ`);
}

// =============================================================================
// [3] Droid's session-id resume needs the id, and says so by emitting nothing
// =============================================================================
console.log("\n[3] droid resumes by session id, not by a bare flag");

const droidNoSession = AGENT_REGISTRY.droid.buildCommand({
  prompt: "do the thing",
  model: AGENT_REGISTRY.droid.defaultModel,
  isResume: true,
  isDirectMode: false,
} as never);
assert(
  !droidNoSession.includes("--session-id"),
  "droid with isResume but no session id emits no resume flag (there is no session to name)",
);

// =============================================================================
// SUMMARY
// =============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
