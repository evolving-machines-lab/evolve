#!/usr/bin/env tsx
/**
 * Unit Test: Skills Resolver — annotated-tag peeling (real git remote)
 *
 * The defect this file pins down: an annotated tag names a TAG OBJECT, and
 * the tag object's sha is not the commit a checkout lands on. A pattern-
 * filtered `ls-remote` advertisement does NOT volunteer the peeled `^{}` row
 * (verified on git 2.44 against local remotes and GitHub https — e.g. Harbor
 * v0.20.0 advertises only tag object f75477f2…, not commit 459ff6ec…), so
 * before the fix `resolveSkillSha` pinned `org/repo@<annotated-tag>` to the
 * TAG OBJECT's sha. All 26 Harbor tags are annotated, so every documented
 * tag-pinned skill reference carried a mis-pin: the stored `gitCommit` and
 * the pinned-ref spelling named an object no checkout ever lands on, and the
 * content-cache key disagreed with the commit the checkout actually produced.
 *
 * The rule under test: a tag reference resolves to the PEELED commit
 * (`rev-parse <ref>^{commit}` semantics) for BOTH spellings — bare (`ann`)
 * and fully qualified (`refs/tags/ann`). Lightweight tags, raw shas, HEAD,
 * and branches (including a branch that shares its name with a tag — the
 * branch still wins, refs/heads sorts first) stay byte-identical.
 *
 * The fixture is a real local bare repo; `gitEnv` carries a GIT_CONFIG
 * url.insteadOf redirect so the resolver's https clone URL dials the fixture
 * — every git call is real, no network, no mocks.
 *
 * Usage: npx tsx tests/unit/skills-tag-peel.test.ts
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  parseSkillRef,
  pinSkillRef,
  resolveSkills,
  resolveSkillSha,
  type ParsedSkillRef,
} from "../../dist/index.js";

const execFileAsync = promisify(execFile);

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const ok = actual === expected;
  if (!ok) {
    console.log(`    got:      ${JSON.stringify(actual)}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
  }
  assert(ok, message);
}

function gitOf(p: ParsedSkillRef): Extract<ParsedSkillRef, { kind: "git" }> {
  if (p.kind !== "git") throw new Error(`expected git ref, got ${p.kind}`);
  return p;
}

/** Fixture git calls carry an identity; annotated tags need one like commits do. */
async function fixtureGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.email=fixture@test", "-c", "user.name=fixture", ...args],
    { cwd },
  );
  return stdout.trim();
}

async function main(): Promise<void> {
  const fixtureDir = mkdtempSync(join(tmpdir(), "evolve-skill-tag-fixture-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "evolve-skill-tag-cache-"));

  try {
    const work = join(fixtureDir, "work");
    const remote = join(fixtureDir, "remote.git");

    await fixtureGit(fixtureDir, ["init", "-q", "work"]);
    writeFileSync(
      join(work, "SKILL.md"),
      "---\nname: testrepo\ndescription: tag-peel fixture skill\n---\nBody.\n",
    );
    await fixtureGit(work, ["add", "SKILL.md"]);
    await fixtureGit(work, ["commit", "-q", "-m", "corpus"]);
    const taggedCommit = await fixtureGit(work, ["rev-parse", "HEAD"]);

    // One commit, two tag spellings: lightweight (the ref IS the commit) and
    // annotated (the ref is a tag OBJECT pointing at the commit).
    await fixtureGit(work, ["tag", "lw"]);
    await fixtureGit(work, ["tag", "-a", "ann", "-m", "annotated release"]);
    const annotatedTagSha = await fixtureGit(work, ["rev-parse", "refs/tags/ann"]);

    // A later commit: the branch tip, distinct from what the tags peel to.
    await fixtureGit(work, ["commit", "-q", "--allow-empty", "-m", "later"]);
    const tipCommit = await fixtureGit(work, ["rev-parse", "HEAD"]);

    // A branch and an ANNOTATED tag sharing one name: refs/heads sorts before
    // refs/tags in the advertisement, so the branch must keep winning.
    await fixtureGit(work, ["branch", "dual"]);
    await fixtureGit(work, ["tag", "-a", "dual-tag", "-m", "x", taggedCommit]);
    await fixtureGit(work, ["tag", "-a", "-f", "dual", "-m", "collides", taggedCommit]);

    await fixtureGit(fixtureDir, ["init", "-q", "--bare", "remote.git"]);
    await fixtureGit(work, [
      "push", "-q", remote,
      "HEAD:refs/heads/main", "refs/heads/dual",
      "refs/tags/lw", "refs/tags/ann", "refs/tags/dual",
    ]);
    await fixtureGit(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    // Let the checkout arm fetch a commit by sha (the same server capability
    // GitHub enables); repo config is read by upload-pack even for file paths.
    await fixtureGit(remote, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);

    // The resolver dials https://github.com/testorg/testrepo.git; redirect
    // that exact URL to the fixture. GIT_CONFIG_* rides the child env, so
    // every git the resolver spawns — ls-remote, fetch — obeys it.
    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/testorg/testrepo.git",
    };
    const opts = { gitEnv, cacheDir };
    const sha = (ref: string) => resolveSkillSha(gitOf(parseSkillRef(ref)), opts);

    assert(annotatedTagSha !== taggedCommit, "fixture: annotated tag object sha differs from its commit");

    console.log("\nAnnotated tag resolves to the PEELED commit (the defect):");
    assertEquals(await sha("testorg/testrepo@ann"), taggedCommit, "bare spelling @ann pins the peeled commit");
    assert((await sha("testorg/testrepo@ann")) !== annotatedTagSha, "bare spelling never pins the tag object sha");
    assertEquals(
      await sha("testorg/testrepo@refs/tags/ann"),
      taggedCommit,
      "qualified spelling @refs/tags/ann pins the peeled commit",
    );

    console.log("\npinSkillRef stores the peeled commit:");
    const pinned = await pinSkillRef("testorg/testrepo@ann", opts);
    assertEquals(pinned.ref, `testorg/testrepo@${taggedCommit}`, "pinned spelling carries the peeled commit");
    assertEquals(pinned.gitCommit, taggedCommit, "pinned gitCommit is the peeled commit");

    console.log("\nLightweight tags, raw shas, HEAD, branches — byte-identical:");
    assertEquals(await sha("testorg/testrepo@lw"), taggedCommit, "lightweight tag still pins its commit");
    assertEquals(await sha(`testorg/testrepo@${tipCommit}`), tipCommit, "raw 40-hex sha still returns as-is");
    assertEquals(await sha("testorg/testrepo@main"), tipCommit, "branch still pins the branch tip");
    assertEquals(await sha("testorg/testrepo"), tipCommit, "no ref still pins the remote HEAD");
    assertEquals(await sha("testorg/testrepo@dual"), tipCommit, "branch/tag name collision: the branch still wins");

    console.log("\nFull resolve: checkout of a tag-pinned reference carries the peeled commit:");
    const resolved = await resolveSkills(["testorg/testrepo@ann"], opts);
    assertEquals(resolved.length, 1, "one skill resolves from the tag-pinned reference");
    assertEquals(resolved[0]?.gitCommit, taggedCommit, "resolved gitCommit is the peeled commit");
    assertEquals(resolved[0]?.name, "testrepo", "root SKILL.md names the skill after the repo");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
