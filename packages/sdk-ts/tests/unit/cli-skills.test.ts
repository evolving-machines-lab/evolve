#!/usr/bin/env tsx
/**
 * Unit Test: `evolve skills` — the CLI serves the bundled skills
 * (src/cli/skills.ts, wired in src/cli/index.ts).
 *
 * The skills directory is a fixture built here, handed to the CLI through
 * EVOLVE_SKILLS_DIR, so every assertion reads bytes this file wrote. One
 * section drops the override and proves the default resolution lands on the
 * checkout's own skill-data/. Covered: list (bare `skills` is list), the
 * hidden pointer, get (one skill, several, --all, --full with agent-browser's
 * `--- path ---` separator), get <skill> <page> with and without the file
 * suffix, path, install (--path, --target, --force, the seven agent homes),
 * --json on every verb, the unknown-name errors that list what exists, the
 * root help's "Start here" block, the API-refusal footer (and its absence on a
 * usage error), and `skills` no longer aliasing the platform `skill` noun.
 *
 * Usage:
 *   npm run test:unit:cli-skills
 *   npx tsx tests/unit/cli-skills.test.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CliUsageError, parseArgs, runCli } from "../../src/cli/index.ts";
import type { CliIO } from "../../src/cli/index.ts";

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

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (!match) {
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
  assert(match, message);
}

function captureIO(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l), tty: false }, out, err };
}

/** stdout as the bytes a terminal would receive: one "\n" after every line. */
function stdout(capture: { out: string[] }): string {
  return capture.out.map((l) => l + "\n").join("");
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

// =============================================================================
// FIXTURE: a skills directory with a hidden pointer, two skills that carry
// references, one that carries templates, one bare, and two strays
// =============================================================================

/** A SKILL.md with the description quoted, as the shipped skills quote theirs (a ": " inside a bare YAML scalar is a parse error). */
function skillMd(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
}

const POINTER = `---\nname: evolve\ndescription: The pointer skill an agent installs.\nallowed-tools: Bash(evolve:*), Bash(npx evolve:*)\n---\n\n# evolve\n\nRun \`evolve skills get evals\`.\n`;
const EVALS_SKILL = skillMd("evolve-evals", "Hosted evals: datasets, jobs, trials. A description long enough to be cut at seventy characters in the list.", "# Evals\n\nThe index.");
const AGENTS_SKILL = skillMd("evolve-agents", "The SDK: run agents in sandboxes.", "# Agents");
const CREATE_TASK_SKILL = skillMd("create-task", "Create a task.", "# Create a task");
const REWARDKIT_SKILL = skillMd("rewardkit", "Write verifiers.", "# Reward Kit");
const TASKS_PAGE = "---\ntitle: Tasks\n---\n\nA task is one directory.\n";
const INDEX_PAGE = "---\ntitle: Evolve documentation\n---\n\nThe landing page.\n";
const SNIPPET = "Shared snippet.\n";
const TS_CHAPTER = "# Getting started (TypeScript)\n";
const TEMPLATE = "criterion = 1\n";

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "evolve-skills-"));
  const put = (rel: string, content: string) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  put("evolve/SKILL.md", POINTER);
  put("evolve-evals/SKILL.md", EVALS_SKILL);
  put("evolve-evals/references/core-concepts/tasks.mdx", TASKS_PAGE);
  put("evolve-evals/references/index.mdx", INDEX_PAGE);
  put("evolve-evals/references/snippets/global-options.mdx", SNIPPET);
  put("evolve-evals/notes.txt", "not served by --full\n");
  put("evolve-agents/SKILL.md", AGENTS_SKILL);
  put("evolve-agents/references/typescript/01-getting-started.md", TS_CHAPTER);
  put("create-task/SKILL.md", CREATE_TASK_SKILL);
  put("rewardkit/SKILL.md", REWARDKIT_SKILL);
  put("rewardkit/templates/criteria.toml", TEMPLATE);
  put("README.md", "a stray file at the top level\n");
  mkdirSync(join(dir, "notes"), { recursive: true });
  return dir;
}

const SERVED_NAMES = ["agents", "create-task", "evals", "rewardkit"];

async function main(): Promise<void> {
  const fixture = writeFixture();
  const savedEnv = { ...process.env };
  const restoreEnv = () => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  };
  process.env.EVOLVE_SKILLS_DIR = fixture;

  try {
    // -------------------------------------------------------------------------
    console.log("\n--- list: bare `skills` is `skills list`; the pointer is hidden ---");
    {
      const bare = captureIO();
      assertEqual(await runCli(["skills"], bare.io), 0, "bare `evolve skills` exits 0");
      const list = captureIO();
      assertEqual(await runCli(["skills", "list"], list.io), 0, "`skills list` exits 0");
      assertEqual(bare.out, list.out, "bare `skills` prints exactly what `skills list` prints");
      const names = list.out.map((l) => l.trim().split(/\s+/)[0]);
      assertEqual(names, SERVED_NAMES, "one row per content skill, sorted, served names (evolve- prefix dropped)");
      assert(!list.out.some((l) => /^\s*evolve\s/.test(l)), "the pointer `evolve` is not listed");
      const evalsRow = list.out.find((l) => l.trim().startsWith("evals")) ?? "";
      const description = evalsRow.trim().replace(/^evals\s+/, "");
      assert(description.endsWith("..."), "a long description is cut with an ellipsis");
      assert(description.length <= 70, `the cut description is at most 70 characters (got ${description.length})`);
      assert(description.startsWith("Hosted evals: datasets, jobs, trials."), "the cut keeps the description's head");
      const shortRow = list.out.find((l) => l.trim().startsWith("rewardkit")) ?? "";
      assert(shortRow.trim().endsWith("Write verifiers."), "a short description is printed whole");
      assert(!list.out.some((l) => l.includes("README") || l.includes("notes")), "strays (a file, a folder with no SKILL.md) are not skills");
      assert(!list.err.length, "list writes nothing to stderr");
    }

    console.log("\n--- list --json: [{ name, description, path }] ---");
    {
      const json = captureIO();
      assertEqual(await runCli(["skills", "list", "--json"], json.io), 0, "list --json exits 0");
      const rows = JSON.parse(json.out.join("\n")) as { name: string; description: string; path: string }[];
      assertEqual(rows.map((r) => r.name), SERVED_NAMES, "--json carries the same names in the same order");
      assertEqual(
        rows.map((r) => Object.keys(r).sort()),
        SERVED_NAMES.map(() => ["description", "name", "path"]),
        "every row is exactly { name, description, path }"
      );
      const evals = rows.find((r) => r.name === "evals")!;
      assert(evals.description.startsWith("Hosted evals: datasets, jobs, trials. A description long enough"), "--json carries the whole description, never cut");
      assertEqual(evals.path, join(fixture, "evolve-evals"), "path is the skill's directory (the folder keeps its evolve- name)");
      assert(!rows.some((r) => r.name === "evolve"), "--json hides the pointer too");
    }

    // -------------------------------------------------------------------------
    console.log("\n--- get: the SKILL.md as it is, front matter included ---");
    {
      const one = captureIO();
      assertEqual(await runCli(["skills", "get", "evals"], one.io), 0, "get evals exits 0");
      assertEqual(stdout(one), EVALS_SKILL, "stdout is the file's bytes, front matter included, nothing added");

      const pointer = captureIO();
      assertEqual(await runCli(["skills", "get", "evolve"], pointer.io), 0, "get evolve prints the pointer (hidden from list, not from get)");
      assertEqual(stdout(pointer), POINTER, "the pointer's bytes, unchanged");

      const two = captureIO();
      assertEqual(await runCli(["skills", "get", "create-task", "rewardkit"], two.io), 0, "get with two names exits 0");
      assertEqual(stdout(two), `${CREATE_TASK_SKILL}\n---\n\n${REWARDKIT_SKILL}`, "two skills are joined by a blank line, a --- rule and a blank line (agent-browser's boundary)");

      const folderName = captureIO();
      assertEqual(await runCli(["skills", "get", "evolve-evals"], folderName.io), 1, "the folder name evolve-evals is not a served name (one name per skill)");
      assert(folderName.err.join("\n").includes("evals"), "the refusal lists the served names");
    }

    console.log("\n--- get --full: every file under references/ and templates/, each behind `--- <path> ---` ---");
    {
      const full = captureIO();
      assertEqual(await runCli(["skills", "get", "evals", "--full"], full.io), 0, "get evals --full exits 0");
      const expected =
        EVALS_SKILL +
        "\n--- references/core-concepts/tasks.mdx ---\n\n" + TASKS_PAGE +
        "\n--- references/index.mdx ---\n\n" + INDEX_PAGE +
        "\n--- references/snippets/global-options.mdx ---\n\n" + SNIPPET;
      assertEqual(stdout(full), expected, "SKILL.md, then each reference in sorted path order behind its separator");
      assert(!stdout(full).includes("not served by --full"), "a file outside references/ and templates/ is not part of --full");

      const templates = captureIO();
      assertEqual(await runCli(["skills", "get", "rewardkit", "--full"], templates.io), 0, "get rewardkit --full exits 0");
      assertEqual(stdout(templates), REWARDKIT_SKILL + "\n--- templates/criteria.toml ---\n\n" + TEMPLATE, "templates/ rides --full the same way");

      const bare = captureIO();
      assertEqual(await runCli(["skills", "get", "create-task", "--full"], bare.io), 0, "--full on a skill with no extra files exits 0");
      assertEqual(stdout(bare), CREATE_TASK_SKILL, "and prints the SKILL.md alone");
    }

    console.log("\n--- get --all: every content skill, never the pointer ---");
    {
      const all = captureIO();
      assertEqual(await runCli(["skills", "get", "--all"], all.io), 0, "get --all exits 0");
      const text = stdout(all);
      assertEqual(
        text,
        [AGENTS_SKILL, CREATE_TASK_SKILL, EVALS_SKILL, REWARDKIT_SKILL].join("\n---\n\n"),
        "--all prints the content skills in name order with the same boundary"
      );
      assert(!text.includes("name: evolve\n"), "the pointer is not part of --all");

      const allFull = captureIO();
      assertEqual(await runCli(["skills", "get", "--all", "--full"], allFull.io), 0, "get --all --full exits 0");
      assert(stdout(allFull).includes("--- references/typescript/01-getting-started.md ---"), "--all --full carries every skill's references");

      const both = captureIO();
      assertEqual(await runCli(["skills", "get", "--all", "evals"], both.io), 2, "--all with a name is a usage error");
      const none = captureIO();
      assertEqual(await runCli(["skills", "get"], none.io), 2, "get with neither a name nor --all is a usage error");
      assert(none.err.join("\n").includes("--all"), "the usage error names --all as the other form");
    }

    console.log("\n--- get <skill> <page>: one reference by its site path, suffix optional ---");
    {
      const page = captureIO();
      assertEqual(await runCli(["skills", "get", "evals", "core-concepts/tasks"], page.io), 0, "get evals core-concepts/tasks exits 0");
      assertEqual(stdout(page), TASKS_PAGE, "prints that page's bytes, no separator");
      const suffixed = captureIO();
      assertEqual(await runCli(["skills", "get", "evals", "core-concepts/tasks.mdx"], suffixed.io), 0, "the .mdx suffix is accepted");
      assertEqual(stdout(suffixed), TASKS_PAGE, "and names the same page");
      const index = captureIO();
      assertEqual(await runCli(["skills", "get", "evals", "index"], index.io), 0, "a top-level page (index) resolves");
      assertEqual(stdout(index), INDEX_PAGE, "to references/index.mdx");
      const md = captureIO();
      assertEqual(await runCli(["skills", "get", "agents", "typescript/01-getting-started"], md.io), 0, "a .md reference resolves without its suffix too");
      assertEqual(stdout(md), TS_CHAPTER, "to references/typescript/01-getting-started.md");

      const unknown = captureIO();
      assertEqual(await runCli(["skills", "get", "evals", "core-concepts/nope"], unknown.io), 1, "an unknown page exits 1");
      const err = unknown.err.join("\n");
      assert(err.includes("core-concepts/nope"), "the error names the page asked for");
      assert(err.includes("core-concepts/tasks") && err.includes("index") && err.includes("snippets/global-options"), "the error lists the skill's pages");
      assert(!err.includes(".mdx"), "pages are listed by site path, without the suffix");

      const escape = captureIO();
      assertEqual(await runCli(["skills", "get", "evals", "../SKILL"], escape.io), 1, "a page path that leaves references/ is refused");

      const fullPage = captureIO();
      assertEqual(await runCli(["skills", "get", "evals", "core-concepts/tasks", "--full"], fullPage.io), 2, "--full on a page is a usage error (a page is one file)");

      const pageJson = captureIO();
      assertEqual(await runCli(["skills", "get", "evals", "index", "--json"], pageJson.io), 0, "get <skill> <page> --json exits 0");
      assertEqual(
        JSON.parse(pageJson.out.join("\n")),
        [{ name: "evals", page: "index", path: join(fixture, "evolve-evals", "references", "index.mdx"), content: INDEX_PAGE }],
        "--json on a page is [{ name, page, path, content }]"
      );
    }

    console.log("\n--- get --json: [{ name, path, content }] and, with --full, files ---");
    {
      const json = captureIO();
      assertEqual(await runCli(["skills", "get", "evals", "--json"], json.io), 0, "get evals --json exits 0");
      assertEqual(
        JSON.parse(json.out.join("\n")),
        [{ name: "evals", path: join(fixture, "evolve-evals"), content: EVALS_SKILL }],
        "--json is [{ name, path, content }]"
      );
      const full = captureIO();
      assertEqual(await runCli(["skills", "get", "rewardkit", "--full", "--json"], full.io), 0, "get --full --json exits 0");
      assertEqual(
        JSON.parse(full.out.join("\n")),
        [{ name: "rewardkit", path: join(fixture, "rewardkit"), content: REWARDKIT_SKILL, files: [{ path: "templates/criteria.toml", content: TEMPLATE }] }],
        "--full --json adds files: [{ path, content }]"
      );
    }

    console.log("\n--- unknown skill: the error lists the names ---");
    {
      const unknown = captureIO();
      assertEqual(await runCli(["skills", "get", "nosuch"], unknown.io), 1, "get nosuch exits 1");
      const err = unknown.err.join("\n");
      assert(err.includes("nosuch"), "the error names the skill asked for");
      const listed = (/skills: ([^)]*)\)/.exec(err)?.[1] ?? "").split(", ");
      assertEqual(listed, SERVED_NAMES, "the error lists the served names, and not the hidden pointer");
      const json = captureIO();
      assertEqual(await runCli(["skills", "get", "nosuch", "--json"], json.io), 1, "get nosuch --json exits 1");
      const body = JSON.parse(json.out.join("\n")) as { error: { message: string } };
      assert(typeof body.error.message === "string" && body.error.message.includes("nosuch"), "--json carries the refusal as { error: { message } }");
    }

    // -------------------------------------------------------------------------
    console.log("\n--- path: the directory ---");
    {
      const root = captureIO();
      assertEqual(await runCli(["skills", "path"], root.io), 0, "path exits 0");
      assertEqual(root.out, [fixture], "path prints the skills directory");
      const one = captureIO();
      assertEqual(await runCli(["skills", "path", "evals"], one.io), 0, "path evals exits 0");
      assertEqual(one.out, [join(fixture, "evolve-evals")], "path <name> prints that skill's directory");
      const rootJson = captureIO();
      await runCli(["skills", "path", "--json"], rootJson.io);
      assertEqual(JSON.parse(rootJson.out.join("\n")), { path: fixture }, "path --json is { path }");
      const oneJson = captureIO();
      await runCli(["skills", "path", "evals", "--json"], oneJson.io);
      assertEqual(JSON.parse(oneJson.out.join("\n")), { name: "evals", path: join(fixture, "evolve-evals") }, "path <name> --json is { name, path }");
      const unknown = captureIO();
      assertEqual(await runCli(["skills", "path", "nosuch"], unknown.io), 1, "path nosuch exits 1");
      assert(unknown.err.join("\n").includes("create-task"), "and lists the names");
    }

    // -------------------------------------------------------------------------
    console.log("\n--- install: the pointer into a skills directory ---");
    {
      const home = mkdtempSync(join(tmpdir(), "evolve-install-"));
      const target = join(home, "custom");
      const first = captureIO();
      assertEqual(await runCli(["skills", "install", "--path", target], first.io), 0, "install --path exits 0");
      const written = join(target, "evolve", "SKILL.md");
      assertEqual(readFileSync(written, "utf8"), POINTER, "writes <path>/evolve/SKILL.md with the pointer's bytes");
      assertEqual(first.out, [written], "prints the path written");

      const again = captureIO();
      assertEqual(await runCli(["skills", "install", "--path", target], again.io), 0, "a second install over the same bytes exits 0");
      assertEqual(again.out, [written], "and prints the path again");

      writeFileSync(written, "edited by hand\n");
      const differs = captureIO();
      assertEqual(await runCli(["skills", "install", "--path", target], differs.io), 1, "a differing file is refused without --force");
      assert(differs.err.join("\n").includes(written) && differs.err.join("\n").includes("--force"), "the refusal names the file and --force");
      assertEqual(readFileSync(written, "utf8"), "edited by hand\n", "and the file is left as it was");
      const forced = captureIO();
      assertEqual(await runCli(["skills", "install", "--path", target, "--force"], forced.io), 0, "--force exits 0");
      assertEqual(readFileSync(written, "utf8"), POINTER, "--force overwrites");

      const json = captureIO();
      assertEqual(await runCli(["skills", "install", "--path", target, "--json"], json.io), 0, "install --json exits 0");
      assertEqual(JSON.parse(json.out.join("\n")), [{ target: "path", path: written, status: "unchanged" }], "install --json is [{ target, path, status }]");

      const jsonWrite = captureIO();
      rmSync(written);
      await runCli(["skills", "install", "--path", target, "--json"], jsonWrite.io);
      assertEqual(JSON.parse(jsonWrite.out.join("\n")), [{ target: "path", path: written, status: "written" }], "status is written when the file was written");

      const fileInTheWay = join(home, "a-file");
      writeFileSync(fileInTheWay, "not a directory\n");
      const blocked = captureIO();
      assertEqual(await runCli(["skills", "install", "--path", join(fileInTheWay, "nested")], blocked.io), 1, "a --path under a file is refused, nothing written");
      assert(blocked.err.join("\n").includes(fileInTheWay), "the refusal names the file in the way");

      // The seven agent homes, resolved from HOME (and XDG_CONFIG_HOME for
      // opencode), each getting evolve/SKILL.md.
      process.env.HOME = home;
      process.env.XDG_CONFIG_HOME = join(home, "xdg");
      const all = captureIO();
      assertEqual(await runCli(["skills", "install"], all.io), 0, "install with no flags (--target all) exits 0");
      const expectedHomes = [
        join(home, ".claude", "skills", "evolve", "SKILL.md"),
        join(home, ".codex", "skills", "evolve", "SKILL.md"),
        join(home, ".cursor", "skills", "evolve", "SKILL.md"),
        join(home, ".copilot", "skills", "evolve", "SKILL.md"),
        join(home, ".gemini", "skills", "evolve", "SKILL.md"),
        join(home, "xdg", "opencode", "skills", "evolve", "SKILL.md"),
        join(home, ".agents", "skills", "evolve", "SKILL.md"),
      ];
      assertEqual(all.out, expectedHomes, "prints the seven paths, one per target, in target order");
      for (const p of expectedHomes) assertEqual(readFileSync(p, "utf8"), POINTER, `${p.slice(home.length)} holds the pointer`);
      delete process.env.XDG_CONFIG_HOME;
      const one = captureIO();
      assertEqual(await runCli(["skills", "install", "--target", "opencode", "--json"], one.io), 0, "install --target opencode exits 0");
      assertEqual(
        JSON.parse(one.out.join("\n")),
        [{ target: "opencode", path: join(home, ".config", "opencode", "skills", "evolve", "SKILL.md"), status: "written" }],
        "opencode falls back to ~/.config when XDG_CONFIG_HOME is unset"
      );
      const badTarget = captureIO();
      assertEqual(await runCli(["skills", "install", "--target", "nosuch"], badTarget.io), 2, "an unknown --target is a usage error");
      assert(badTarget.err.join("\n").includes("opencode"), "that lists the targets");
      const bothFlags = captureIO();
      assertEqual(await runCli(["skills", "install", "--target", "claude", "--path", target], bothFlags.io), 2, "--target with --path is a usage error");
      rmSync(home, { recursive: true, force: true });
    }

    // -------------------------------------------------------------------------
    console.log("\n--- resolution: EVOLVE_SKILLS_DIR first, then the package's skill-data/ ---");
    {
      process.env.EVOLVE_SKILLS_DIR = join(fixture, "does-not-exist");
      const missing = captureIO();
      assertEqual(await runCli(["skills", "list"], missing.io), 1, "EVOLVE_SKILLS_DIR pointing at nothing is a refusal");
      assert(missing.err.join("\n").includes("EVOLVE_SKILLS_DIR") && missing.err.join("\n").includes("does-not-exist"), "that names the variable and the path");

      delete process.env.EVOLVE_SKILLS_DIR;
      const checkout = captureIO();
      assertEqual(await runCli(["skills", "path"], checkout.io), 0, "without the override, path resolves");
      // The package's own copy first (staged by every build and pack, so it
      // is there after `npm run test:unit` and absent in a bare checkout),
      // then the repo root's two levels above the package.
      const staged = join(PACKAGE_ROOT, "skill-data");
      const expected = existsSync(staged) ? staged : join(REPO_ROOT, "skill-data");
      assertEqual(checkout.out, [expected], `to ${existsSync(staged) ? "the package's staged" : "the checkout's"} skill-data/`);
      if (existsSync(staged)) {
        assertEqual(
          readFileSync(join(staged, "evolve-evals", "SKILL.md"), "utf8"),
          readFileSync(join(REPO_ROOT, "skill-data", "evolve-evals", "SKILL.md"), "utf8"),
          "the staged copy is the repo root's, byte for byte"
        );
      }
      const list = captureIO();
      await runCli(["skills", "list", "--json"], list.io);
      const names = (JSON.parse(list.out.join("\n")) as { name: string }[]).map((r) => r.name);
      assertEqual(names, ["agents", "create-adapter", "create-task", "evals", "publish", "rewardkit"], "the checkout serves the six content skills");
      const pointer = captureIO();
      await runCli(["skills", "get", "evolve"], pointer.io);
      assertEqual(stdout(pointer), readFileSync(join(REPO_ROOT, "skills", "evolve", "SKILL.md"), "utf8"), "the served pointer is byte-equal to skills/evolve/SKILL.md");
      process.env.EVOLVE_SKILLS_DIR = fixture;
    }

    // -------------------------------------------------------------------------
    console.log("\n--- help: the root page opens with Start here; the group help lists the verbs ---");
    {
      const root = captureIO();
      await runCli(["--help"], root.io);
      const text = root.out.join("\n");
      const startHere = text.indexOf("Start here (for AI agents):");
      const commands = text.indexOf("Commands:");
      assert(startHere !== -1, "root help carries the Start here block");
      assert(commands !== -1 && startHere < commands, "before the command list");
      assert(text.includes("  evolve skills get evals\n"), "the block names `evolve skills get evals`");
      assert(text.includes("`skills get create-task`, `rewardkit`, `create-adapter`, `publish`"), "and the task-authoring skills");
      assert(/^  skills\s/m.test(text), "the command list has a skills row");

      const group = captureIO();
      assertEqual(await runCli(["skills", "--help"], group.io), 0, "skills --help exits 0");
      const groupText = group.out.join("\n");
      for (const verb of ["list", "get", "path", "install"]) assert(new RegExp(`^  ${verb}\\s`, "m").test(groupText), `skills --help lists ${verb}`);
      assert(groupText.includes("EVOLVE_SKILLS_DIR"), "skills --help names the directory override");

      const get = captureIO();
      await runCli(["skills", "get", "--help"], get.io);
      const getText = get.out.join("\n");
      assert(getText.includes("--full") && getText.includes("--all"), "get --help documents --full and --all");
      assert(getText.includes("core-concepts/tasks"), "get --help shows the page form with a real page");
    }

    console.log("\n--- grammar: `skills` is its own group, `skill` stays the platform noun ---");
    {
      assertEqual(parseArgs(["skills", "list"]).command, "skills list", "skills list parses as the bundled-skills verb");
      assertEqual(parseArgs(["skills"]).command, "skills list", "bare skills parses as skills list");
      assertEqual(parseArgs(["skill", "list"]).command, "skill list", "skill list is still the platform-stored skills verb");
      let threw = false;
      try {
        parseArgs(["skills", "nosuch"]);
      } catch (e) {
        threw = e instanceof CliUsageError && (e as Error).message.includes("install");
      }
      assert(threw, "an unknown skills verb is a usage error listing the verbs");
    }

    // -------------------------------------------------------------------------
    console.log("\n--- refusal footer: an API refusal ends with the errors page; a usage error does not ---");
    {
      const originalFetch = globalThis.fetch;
      (globalThis as any).fetch = async () =>
        ({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: new Headers(),
          json: async () => ({ error: { code: "unauthorized", message: "bad key" } }),
          text: async () => JSON.stringify({ error: { code: "unauthorized", message: "bad key" } }),
          body: null,
        }) as unknown as Response;
      try {
        const refused = captureIO();
        assertEqual(await runCli(["auth", "status", "--api-key", "k", "--base-url", "http://127.0.0.1:9"], refused.io), 1, "an API refusal exits 1");
        assertEqual(refused.err[refused.err.length - 1], "Docs: evolve skills get evals sdk-reference/errors", "stderr ends with the docs line");
        assert(refused.err[0].includes("bad key"), "after the server's sentence");
        const refusedJson = captureIO();
        await runCli(["auth", "status", "--api-key", "k", "--base-url", "http://127.0.0.1:9", "--json"], refusedJson.io);
        assertEqual(refusedJson.err[refusedJson.err.length - 1], "Docs: evolve skills get evals sdk-reference/errors", "under --json the footer still rides stderr");
        assert(refusedJson.out.every((l) => !l.includes("Docs:")), "and never stdout");
      } finally {
        globalThis.fetch = originalFetch;
      }
      const usage = captureIO();
      assertEqual(await runCli(["job", "show"], usage.io), 2, "a usage error exits 2");
      assert(!usage.err.some((l) => l.startsWith("Docs:")), "with no docs footer");
      const local = captureIO();
      assertEqual(await runCli(["skills", "get", "nosuch"], local.io), 1, "a local refusal exits 1");
      assert(!local.err.some((l) => l.startsWith("Docs:")), "with no docs footer either (it is not an API refusal)");
    }
  } finally {
    restoreEnv();
    rmSync(fixture, { recursive: true, force: true });
  }

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
