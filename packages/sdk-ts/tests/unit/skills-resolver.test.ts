#!/usr/bin/env tsx
/**
 * Unit Test: Skills Resolver
 *
 * The one resolver (src/skills.ts) between a skill reference string and skill
 * content in a sandbox. Covers:
 * - Reference grammar: skills.sh forms, Harbor org/repo[@ref] shorthand,
 *   https URLs with /tree/<ref>/<subdir>, local paths, upload handles,
 *   and loud refusals for everything else
 * - Pinned-ref spelling for every git form
 * - Harbor's content digest recipe (sha256 over sorted relpath\0sha256\0)
 * - Local discovery law: SKILL.md dir, strict children, loud refusals
 * - Duplicate names last-wins, output sorted by name
 * - Mounting through a fake sandbox: tarball per skill, extract command
 *
 * No network: git-backed fetch is exercised by the hosted platform's tests
 * and the real E2E round.
 *
 * Usage: npx tsx tests/unit/skills-resolver.test.ts
 */

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkillRef,
  resolveSkills,
  computeSkillDigest,
  mountSkills,
  SkillRefError,
  SkillResolveError,
  type ParsedSkillRef,
  type ResolvedSkill,
} from "../../dist/index.js";

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
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.log(`    got:      ${JSON.stringify(actual)}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
  }
  assert(ok, message);
}

async function assertThrows(
  fn: () => unknown | Promise<unknown>,
  errorName: string,
  fragment: string,
  message: string,
): Promise<void> {
  try {
    await fn();
    assert(false, `${message} (did not throw)`);
  } catch (e) {
    const err = e as Error;
    assert(
      err.name === errorName && err.message.includes(fragment),
      `${message} (${err.name}: ${err.message.slice(0, 100)})`,
    );
  }
}

function gitOf(p: ParsedSkillRef): Extract<ParsedSkillRef, { kind: "git" }> {
  if (p.kind !== "git") throw new Error(`expected git ref, got ${p.kind}`);
  return p;
}

async function main(): Promise<void> {
  // ==========================================================================
  console.log("\nReference grammar: skills.sh forms");
  // ==========================================================================
  {
    const p = gitOf(parseSkillRef("skills.sh/vercel-labs/agent-skills"));
    assertEquals(
      [p.host, p.org, p.repo, p.gitRef, p.skillName, p.viaSkillsSh],
      ["github.com", "vercel-labs", "agent-skills", undefined, undefined, true],
      "skills.sh/owner/repo maps to github.com with no pin",
    );
  }
  {
    const p = gitOf(parseSkillRef("skills.sh/vercel-labs/agent-skills/frontend-design"));
    assertEquals(p.skillName, "frontend-design", "third segment selects one skill");
  }
  {
    const p = gitOf(parseSkillRef("skills.sh/o/r/s@abc123"));
    assertEquals([p.gitRef, p.skillName], ["abc123", "s"], "@ref parsed off the last segment");
  }
  {
    const p = gitOf(parseSkillRef("https://skills.sh/o/r@main"));
    assertEquals([p.org, p.repo, p.gitRef, p.viaSkillsSh], ["o", "r", "main", true], "https://skills.sh form accepted");
  }
  await assertThrows(() => parseSkillRef("skills.sh/only-owner"), "SkillRefError", "skills.sh/<owner>/<repo>", "one-segment skills.sh ref refused");
  await assertThrows(() => parseSkillRef("skills.sh/a/b/c/d"), "SkillRefError", "skills.sh/<owner>/<repo>", "four-segment skills.sh ref refused");

  // ==========================================================================
  console.log("\nReference grammar: Harbor shorthand and URLs");
  // ==========================================================================
  {
    const p = gitOf(parseSkillRef("anthropics/skills"));
    assertEquals([p.host, p.org, p.repo, p.gitRef], ["github.com", "anthropics", "skills", undefined], "org/repo shorthand");
  }
  {
    const p = gitOf(parseSkillRef("anthropics/skills@v1.2"));
    assertEquals(p.gitRef, "v1.2", "org/repo@ref keeps the ref");
  }
  {
    const p = gitOf(parseSkillRef("https://gitlab.com/org/repo.git"));
    assertEquals([p.host, p.repo], ["gitlab.com", "repo"], "https URL on any host, .git stripped");
  }
  {
    const p = gitOf(parseSkillRef("https://github.com/org/repo/tree/main/skills/web-design"));
    assertEquals([p.gitRef, p.subdir], ["main", "skills/web-design"], "tree URL carries ref and subdir");
  }
  await assertThrows(() => parseSkillRef("https://github.com/org"), "SkillRefError", "org/name", "URL without repo refused");
  await assertThrows(() => parseSkillRef("pdf"), "SkillRefError", "Cannot parse skill reference", "bare catalog name is not a reference anymore");
  await assertThrows(() => parseSkillRef("dev-browser"), "SkillRefError", "Cannot parse skill reference", "old catalog names refused by grammar");
  await assertThrows(() => parseSkillRef(""), "SkillRefError", "empty", "empty string refused");

  // ==========================================================================
  console.log("\nReference grammar: local paths and uploads");
  // ==========================================================================
  {
    const p = parseSkillRef("./my-skill");
    assert(p.kind === "local", "./ prefix is a local path");
  }
  {
    const p = parseSkillRef("/abs/skill");
    assert(p.kind === "local", "absolute path is local");
  }
  {
    const p = parseSkillRef("upload:sk_123");
    assert(p.kind === "upload" && p.id === "sk_123", "upload:<id> parses to an upload handle");
  }
  await assertThrows(() => parseSkillRef("upload:"), "SkillRefError", "upload", "upload with no id refused");
  await assertThrows(
    () => resolveSkills(["upload:sk_123"]),
    "SkillResolveError",
    "platform",
    "resolver refuses upload handles (platform-only)",
  );

  // ==========================================================================
  console.log("\nDigest: Harbor's recipe, byte for byte");
  // ==========================================================================
  const digestDir = mkdtempSync(join(tmpdir(), "skilldigest-"));
  try {
    mkdirSync(join(digestDir, "sub"), { recursive: true });
    writeFileSync(join(digestDir, "SKILL.md"), "hello\n");
    writeFileSync(join(digestDir, "sub", "b.txt"), "bee");
    // Expected value computed by the recipe at skills.py:200-209:
    // sha256 over "<relpath>\0<sha256hex(content)>\0" in sorted relpath order.
    const h = createHash("sha256");
    for (const [rel, content] of [
      ["SKILL.md", "hello\n"],
      ["sub/b.txt", "bee"],
    ] as const) {
      h.update(rel);
      h.update("\0");
      h.update(createHash("sha256").update(content).digest("hex"));
      h.update("\0");
    }
    const expected = `sha256:${h.digest("hex")}`;
    assertEquals(await computeSkillDigest(digestDir), expected, "digest matches Harbor's recipe on a known tree");
  } finally {
    rmSync(digestDir, { recursive: true, force: true });
  }

  // ==========================================================================
  console.log("\nLocal discovery law");
  // ==========================================================================
  const root = mkdtempSync(join(tmpdir(), "skillroot-"));
  try {
    // Single skill dir
    const single = join(root, "one-skill");
    mkdirSync(single);
    writeFileSync(join(single, "SKILL.md"), "# one\n");
    const singleResolved = await resolveSkills([single]);
    assertEquals(singleResolved.map((s: ResolvedSkill) => s.name), ["one-skill"], "dir with SKILL.md is one skill named after the dir");
    assert(singleResolved[0].digest.startsWith("sha256:"), "local skill carries a digest");
    assert(singleResolved[0].gitCommit === undefined, "local skill has no git commit");

    // Root of skills, all valid
    const multi = join(root, "catalog");
    for (const name of ["beta", "alpha"]) {
      mkdirSync(join(multi, name), { recursive: true });
      writeFileSync(join(multi, name, "SKILL.md"), `# ${name}\n`);
    }
    const multiResolved = await resolveSkills([multi]);
    assertEquals(multiResolved.map((s: ResolvedSkill) => s.name), ["alpha", "beta"], "skill root resolves children, sorted by name");

    // Root with an invalid child: loud refusal naming the child
    const broken = join(root, "broken");
    mkdirSync(join(broken, "good"), { recursive: true });
    writeFileSync(join(broken, "good", "SKILL.md"), "# g\n");
    mkdirSync(join(broken, "no-manifest"), { recursive: true });
    writeFileSync(join(broken, "no-manifest", "readme.txt"), "x");
    await assertThrows(
      () => resolveSkills([broken]),
      "SkillResolveError",
      "no-manifest",
      "child without SKILL.md is a loud refusal naming the child",
    );

    // Missing path
    await assertThrows(
      () => resolveSkills([join(root, "does-not-exist")]),
      "SkillResolveError",
      "does not exist",
      "missing local path is a loud refusal",
    );

    // Duplicate names: last wins
    const dupA = join(root, "dupA", "same-name");
    const dupB = join(root, "dupB", "same-name");
    mkdirSync(dupA, { recursive: true });
    mkdirSync(dupB, { recursive: true });
    writeFileSync(join(dupA, "SKILL.md"), "# first\n");
    writeFileSync(join(dupB, "SKILL.md"), "# second\n");
    const dupResolved = await resolveSkills([dupA, dupB]);
    assertEquals(dupResolved.length, 1, "duplicate skill names collapse");
    assertEquals(dupResolved[0].source, dupB, "last reference wins the name");

    // ========================================================================
    console.log("\nMounting through a fake sandbox");
    // ========================================================================
    const writes: Array<{ path: string; bytes: number }> = [];
    const commands: string[] = [];
    const fakeSandbox = {
      files: {
        async write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
          const bytes = typeof content === "string" ? Buffer.byteLength(content) : (content as Buffer).byteLength ?? (content as Buffer).length;
          writes.push({ path, bytes });
        },
        async makeDir(_path: string): Promise<void> {},
      },
      commands: {
        async run(command: string): Promise<void> {
          commands.push(command);
        },
      },
    };
    await mountSkills(fakeSandbox, multiResolved, "/home/user/.claude/skills");
    assertEquals(writes.length, 2, "one tarball uploaded per skill");
    assert(writes.every((w) => w.bytes > 0), "tarballs are non-empty");
    assert(
      writes.every((w) => w.path.startsWith("/home/user/.claude/skills/.evolve-skill-")),
      "tarballs land beside the target dir",
    );
    assert(
      commands.length === 2 &&
        commands[0].includes("tar -xzf") &&
        commands[0].includes("'/home/user/.claude/skills/alpha'") &&
        commands[1].includes("'/home/user/.claude/skills/beta'"),
      "each skill extracts into targetDir/<name>",
    );
    assert(commands.every((c) => c.includes("rm -f")), "tarball is removed after extraction");

    await mountSkills(fakeSandbox, [], "/anywhere");
    assertEquals(writes.length, 2, "mounting zero skills touches nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // ==========================================================================
  console.log(`\n${passed} passed, ${failed} failed`);
  // ==========================================================================
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
