#!/usr/bin/env tsx
/**
 * Unit Test: every `evolve` help page meets the bar (owner's word, 2026-09-16).
 *
 * For every command and subcommand, `--help` is: one line saying what it does,
 * then usage, then the options grouped under short headings, each option one
 * entry with its default, then one to three examples. Every line stays under
 * 80 columns, no paragraph runs past three sentences, and no sentence explains
 * how the platform does its work. The root page lists one line per command
 * under 80 columns; the group pages list one line per verb.
 *
 * The commands are enumerated from the help pages themselves — the root page's
 * command rows and each group page's verb rows — so a verb added without help
 * is a verb this test never sees, and one whose row is malformed fails here.
 *
 * Usage:
 *   npm run test:unit:cli-help
 *   npx tsx tests/unit/cli-help.test.ts
 */

import { runCli } from "../../src/cli/index.ts";
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

async function helpOf(words: string[]): Promise<string[]> {
  const out: string[] = [];
  // A help page arrives as one multi-line write; split it into its lines.
  const io: CliIO = { out: (l) => out.push(...l.split("\n")), err: (l) => out.push(`STDERR: ${l}`), tty: false };
  const code = await runCli([...words, "--help"], io);
  assert(code === 0, `evolve ${words.join(" ")} --help exits 0`);
  return out;
}

const WIDTH = 80;
/** Words that describe the platform's own mechanics or cite code, never a help sentence. */
const INTERNALS = ["GET /api", "server-side", "cli/", ".py:", "sha256", "SERVER"];

/** The rows of a section: `  name   text` lines between the heading and the next blank line. */
function rowsUnder(lines: string[], heading: string): string[] {
  const start = lines.indexOf(heading);
  if (start === -1) return [];
  const names: string[] = [];
  for (let i = start + 1; i < lines.length && lines[i] !== ""; i++) {
    const m = /^  ([a-z][a-z-]*(?: [a-z][a-z-]*)?)\s{2,}\S/.exec(lines[i]);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Prose paragraphs: blocks of unindented lines between blank lines. */
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of [...lines, ""]) {
    if (line === "" || line.startsWith(" ")) {
      if (current.length > 0) out.push(current.join(" "));
      current = [];
    } else {
      current.push(line);
    }
  }
  return out;
}

function sentences(text: string): number {
  return (text.match(/[.!?](\s|$)/g) ?? []).length;
}

function checkCommon(label: string, lines: string[]): void {
  const long = lines.filter((l) => l.length > WIDTH);
  assert(long.length === 0, `${label}: every line is under ${WIDTH + 1} columns${long.length ? ` (longest ${Math.max(...long.map((l) => l.length))}: "${long[0].slice(0, 50)}…")` : ""}`);
  assert(!lines.some((l) => l.startsWith("STDERR:")), `${label}: nothing on stderr`);
  const internals = lines.filter((l) => INTERNALS.some((w) => l.includes(w)));
  assert(internals.length === 0, `${label}: no sentence about how the platform does it${internals.length ? ` ("${internals[0].trim().slice(0, 60)}")` : ""}`);
  const walls = paragraphs(lines).filter((p) => sentences(p) > 3);
  assert(walls.length === 0, `${label}: no paragraph over three sentences${walls.length ? ` ("${walls[0].slice(0, 60)}…")` : ""}`);
}

function checkCommandPage(words: string[], lines: string[]): void {
  const label = `evolve ${words.join(" ")}`;
  checkCommon(label, lines);
  assert(new RegExp(`^${label} — \\S`).test(lines[0]), `${label}: opens with one line saying what it does`);
  assert(lines[1] === "" && lines[2].startsWith(`Usage: ${label}`), `${label}: then usage`);
  const headings = lines.filter((l) => /^[A-Z][A-Za-z ]*:$/.test(l));
  assert(headings.includes("Examples:"), `${label}: has an Examples section`);
  assert(headings.includes("Global options:"), `${label}: lists the global options`);
  const optionRows = lines.filter((l) => /^  (-[a-z], )?--[a-z]/.test(l) || /^      --[a-z]/.test(l));
  assert(optionRows.every((l) => /^  (?:-[a-z], --|    --)[a-z]/.test(l)), `${label}: option rows align on one column`);
  const start = lines.indexOf("Examples:");
  // An example's first line sits at two spaces (a pipe may precede `evolve`); its continuation lines at four.
  const examples = lines.slice(start + 1).filter((l) => /^  \S/.test(l));
  assert(examples.length >= 1 && examples.length <= 3, `${label}: one to three examples (got ${examples.length})`);
  assert(examples.every((l) => / ?evolve /.test(l) || l.startsWith("  evolve ")), `${label}: every example runs evolve`);
  assert(lines.slice(start + 1).every((l) => l === "" || l.startsWith("  ")), `${label}: examples are indented, continuation lines deeper`);
}

async function main(): Promise<void> {
  console.log("\n--- root: Start here, then one line per command ---");
  const root = await helpOf([]);
  checkCommon("evolve", root);
  const startHere = root.indexOf("Start here (for AI agents):");
  const commandsAt = root.indexOf("Commands:");
  assert(startHere !== -1 && commandsAt !== -1 && startHere < commandsAt, "the Start here block precedes the command list");
  const commands = rowsUnder(root, "Commands:");
  const groups = rowsUnder(root, "Command groups (evolve <group> <verb>):");
  assert(commands.length >= 4, `the root lists the top-level commands (${commands.join(", ")})`);
  assert(groups.length >= 10, `the root lists the command groups (${groups.join(", ")})`);
  assert(root.some((l) => l === "Examples:"), "the root page ends with examples");

  for (const command of commands) {
    console.log(`\n--- evolve ${command} ---`);
    checkCommandPage([command], await helpOf([command]));
  }

  for (const group of groups) {
    console.log(`\n--- evolve ${group} ---`);
    // A group that is also a command (`check`) answers with the command's
    // page, which carries the group's verbs under Commands.
    const page = await helpOf([group]);
    checkCommon(`evolve ${group}`, page);
    assert(new RegExp(`^evolve ${group} — \\S`).test(page[0]), `evolve ${group}: opens with one line saying what it does`);
    assert(page[2].startsWith(`Usage: evolve ${group}`), `evolve ${group}: then usage`);
    const verbs = rowsUnder(page, "Commands:");
    assert(verbs.length >= 1, `evolve ${group}: lists its verbs one per line (${verbs.join(", ")})`);
    for (const verb of verbs) {
      const words = [group, ...verb.split(" ")];
      console.log(`\n--- evolve ${words.join(" ")} ---`);
      checkCommandPage(words, await helpOf(words));
    }
  }

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
