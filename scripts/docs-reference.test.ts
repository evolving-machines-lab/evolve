import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const source = ts.createSourceFile("types.ts", read("packages/sdk-ts/src/hosted/types.ts"), ts.ScriptTarget.Latest, true);
const secretSource = ts.createSourceFile("secrets.ts", read("packages/sdk-ts/src/managed-secrets.ts"), ts.ScriptTarget.Latest, true);
const python = read("packages/sdk-py/evolve/hosted.py");
const pythonSecrets = read("packages/sdk-py/evolve/managed_secrets.py");

// These checks guard reference coverage. Human review still checks the meaning
// of each description, parameter, example, and language-specific difference.
const clients: Record<string, string> = {
  DatasetsClient: "datasets",
  AgentsClient: "agents",
  SkillsClient: "skills",
  JobsClient: "jobs",
  TrialsClient: "trials",
  AnalysesClient: "analyses",
  ChecksClient: "checks",
  AuthClient: "auth",
  OrgsClient: "auth",
  RunFilesystem: "filesystem",
  TaskPackageFiles: "filesystem",
  ManagedSecretsClient: "secrets",
};

function declaration(name: string, file = source): ts.InterfaceDeclaration {
  const node = file.statements.find((item): item is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(item) && item.name.text === name);
  assert.ok(node, `Missing source interface ${name}`);
  return node;
}

function headings(text: string): string[] {
  const plain = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
  return [...plain.matchAll(/^#{2,4}\s+(.+)$|<Accordion\s+title="([^"]+)"/gm)]
    .map((match) => (match[1] ?? match[2]).replace(/`/g, ""));
}

/** A heading documents a method when it IS the method (`## get`) or a qualified spelling of it (`## package.get`), a TypeScript / Python pair counting as one;
 * a heading that merely mentions the name (`## When to call get`) does not. Each heading is claimed once, so two
 * clients on one page cannot share a section. */
function claimMethodHeading(names: string[], claimed: Set<string>, method: string): boolean {
  const matches = (name: string): boolean => name.split(" / ").some((part) => part === method || part.endsWith(`.${method}`) || part === `${method}()`);
  const index = names.findIndex((name, at) => !claimed.has(`${at}`) && matches(name));
  if (index < 0) return false;
  claimed.add(`${index}`);
  return true;
}

function hasMethodHeading(names: string[], method: string): boolean {
  return claimMethodHeading(names, new Set(), method);
}

function pythonFences(text: string): string {
  return [...text.matchAll(/^```python[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]).join("\n");
}

/** The CLI's command groups, read from its GROUPS table: every 2-space key until the table closes. */
function cliGroups(): string[] {
  const cli = read("packages/sdk-ts/src/cli/index.ts");
  const start = cli.indexOf("const GROUPS: Record<string, GroupSpec> = {");
  assert.ok(start >= 0, "the CLI's GROUPS table moved; update this test");
  const body = cli.slice(start);
  const end = body.search(/^};$/m);
  return [...body.slice(0, end).matchAll(/^  ([a-z][a-z-]*): \{/gm)].map((match) => match[1]);
}

test("every hosted interface with methods is assigned a method reference", () => {
  const discovered = source.statements.filter(ts.isInterfaceDeclaration)
    .filter((node) => node.members.some(ts.isMethodSignature))
    .map((node) => node.name.text).filter((name) => name !== "Awaitable");
  const mapped = Object.keys(clients).filter((name) => name !== "ManagedSecretsClient");
  assert.deepEqual(discovered.sort(), mapped.sort(), "an interface with methods appeared in hosted/types.ts without a reference page");
});

test("every CLI command group has a reference page", () => {
  const groups = cliGroups();
  assert.ok(groups.length >= 10, `only ${groups.length} CLI groups found; the table parser may be stale`);
  for (const group of groups) {
    assert.doesNotThrow(() => read(`docs-evals/cli-reference/${group}.mdx`), `CLI group "${group}" needs docs-evals/cli-reference/${group}.mdx`);
  }
});

test("every known error has exactly one explanation in the error catalog", () => {
  const { codes } = JSON.parse(read("packages/sdk-ts/hosted-error-codes.json")) as { codes: string[] };
  const rows = [...read("docs-evals/sdk-reference/error-codes.mdx").matchAll(/^\|\s*`([a-z][a-z0-9_]+)`\s*\|(.+)$/gm)];
  const names = rows.map((row) => row[1]);
  assert.deepEqual([...names].sort(), [...codes].sort(), "The catalog must explain each canonical code once, with no invented codes");
  for (const row of rows) {
    assert.ok(row[2].replace(/[|`*]/g, "").trim().length > 20, `${row[1]} needs an explanation, not only a name`);
  }
});

const claimedHeadings = new Map<string, Set<string>>();
for (const [client, page] of Object.entries(clients)) {
  test(`${client} has a reference section for every TypeScript and Python method`, () => {
    const file = client === "ManagedSecretsClient" ? secretSource : source;
    const methods = [...new Set(declaration(client, file).members
      .filter(ts.isMethodSignature).map((method) => method.name.getText(file)))];
    assert.ok(methods.length > 0);
    const reference = read(`docs-evals/sdk-reference/methods/${page}.mdx`);
    const names = headings(reference);
    const claimed = claimedHeadings.get(page) ?? new Set<string>();
    claimedHeadings.set(page, claimed);
    for (const method of methods) {
      assert.ok(claimMethodHeading(names, claimed, method), `${client}.${method} needs its own reference heading (a heading equal to the name, or <client>.${method} on a shared page)`);
    }
    const pythonCode = pythonFences(reference);
    const py = client === "ManagedSecretsClient" ? pythonSecrets : python;
    const start = py.indexOf(`class ${client}:`);
    assert.ok(start >= 0, `Missing Python class ${client}`);
    const body = py.slice(start).split(/\n(?=class |def |async def )/)[0];
    const pyMethods = [...body.matchAll(/^    (?:async )?def ([a-z][a-z0-9_]*)\(/gm)].map((match) => match[1]);
    assert.ok(pyMethods.length > 0);
    for (const method of pyMethods.filter((name) => name !== "close")) {
      const camelCase = method.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      assert.ok(hasMethodHeading(names, method) || hasMethodHeading(names, camelCase), `${client}.${method} needs its own reference section`);
      assert.ok(new RegExp(`\\b${method}\\(`).test(pythonCode), `${client}.${method} needs its Python call or signature inside a python code block`);
    }
  });
}

test("shared SDK lifecycle and metadata entry points remain documented", () => {
  const index = read("docs-evals/sdk-reference/index.mdx");
  assert.match(index, /async with/);
  assert.match(index, /close\(\)/);
  assert.ok(hasMethodHeading(headings(read("docs-evals/sdk-reference/methods/meta.mdx")), "meta"));
});

test("task rollup and comparison result fields remain in the type reference", () => {
  const text = read("docs-evals/sdk-reference/types.mdx");
  const blocks = [...text.matchAll(/^```(?:ts|typescript)[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]);
  const documented = ts.createSourceFile("reference.ts", blocks.join("\n"), ts.ScriptTarget.Latest, true);
  for (const name of ["JobTaskRollup", "CompareCoverage", "CompareCell", "CompareTaskRow", "CompareJobAggregate", "CompareResponse"]) {
    const expected = declaration(name).members.filter(ts.isPropertySignature).map((member) => member.name.getText(source));
    const actual = declaration(name, documented).members.filter(ts.isPropertySignature).map((member) => member.name.getText(documented));
    assert.deepEqual(actual.sort(), expected.sort(), `${name} must document all returned fields`);
  }
});

test("every job event discriminator remains in the type reference", () => {
  const node = source.statements.find((item): item is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(item) && item.name.text === "JobEvent");
  assert.ok(node);
  const events = [...node.getText(source).matchAll(/type:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(events.length > 0);
  const text = read("docs-evals/sdk-reference/types.mdx");
  for (const event of events) assert.ok(text.includes(`\`${event}\``), `Missing job event ${event}`);
});
