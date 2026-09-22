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

function hasMethodHeading(names: string[], method: string): boolean {
  return names.some((name) => name.split(/[^A-Za-z0-9_]+/).includes(method));
}

test("every hosted client interface is assigned a method reference", () => {
  const discovered = source.statements.filter(ts.isInterfaceDeclaration)
    .map((node) => node.name.text).filter((name) => name.endsWith("Client"));
  const mapped = Object.keys(clients).filter((name) => name.endsWith("Client") && name !== "ManagedSecretsClient");
  assert.deepEqual(discovered.sort(), mapped.sort());
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

for (const [client, page] of Object.entries(clients)) {
  test(`${client} has a reference section for every TypeScript and Python method`, () => {
    const file = client === "ManagedSecretsClient" ? secretSource : source;
    const methods = [...new Set(declaration(client, file).members
      .filter(ts.isMethodSignature).map((method) => method.name.getText(file)))];
    assert.ok(methods.length > 0);
    const reference = read(`docs-evals/sdk-reference/methods/${page}.mdx`);
    const names = headings(reference);
    for (const method of methods) {
      assert.ok(hasMethodHeading(names, method), `${client}.${method} needs its own reference heading`);
    }
    const py = client === "ManagedSecretsClient" ? pythonSecrets : python;
    const start = py.indexOf(`class ${client}:`);
    assert.ok(start >= 0, `Missing Python class ${client}`);
    const body = py.slice(start).split(/\n(?=class |def |async def )/)[0];
    const pyMethods = [...body.matchAll(/^    (?:async )?def ([a-z][a-z0-9_]*)\(/gm)].map((match) => match[1]);
    assert.ok(pyMethods.length > 0);
    for (const method of pyMethods.filter((name) => name !== "close")) {
      const camelCase = method.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      assert.ok(hasMethodHeading(names, method) || hasMethodHeading(names, camelCase), `${client}.${method} needs its own reference section`);
      assert.ok(new RegExp(`\\b${method}\\(`).test(reference), `${client}.${method} needs its Python call or signature`);
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
