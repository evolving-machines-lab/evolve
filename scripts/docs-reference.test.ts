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
// A client that shares a page owns the headings under its prefix.
const headingPrefix: Record<string, string> = { TaskPackageFiles: "package" };

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

// Claimed once per page, so two clients sharing a page cannot share a section; a prefixed client owns `<prefix>.<method>` headings.
function claimMethodHeading(names: string[], claimed: Set<string>, method: string, prefix?: string): boolean {
  const wanted = prefix ? `${prefix}.${method}` : method;
  const matches = (name: string): boolean => name.split(" / ").some((part) => part === wanted || part === `${wanted}()`);
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

/** The CLI's command groups and top-level verbs, read from its two tables: every 2-space key until each table closes. */
function cliGroups(): string[] {
  const cli = read("packages/sdk-ts/src/cli/index.ts");
  const keys = (marker: string): string[] => {
    const start = cli.indexOf(marker);
    assert.ok(start >= 0, `the CLI table "${marker}" moved; update this test`);
    const body = cli.slice(start);
    return [...body.slice(0, body.search(/^};$/m)).matchAll(/^  ([a-z][a-z-]*): \{/gm)].map((match) => match[1]);
  };
  return [...new Set([...keys("const GROUPS: Record<string, GroupSpec> = {"), ...keys("const TOP_LEVEL_COMMANDS: Record<string, CommandSpec> = {")])];
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

test("model tabs cover every model with per-model effort guidance and defaults", () => {
  const { harnesses } = JSON.parse(read("packages/sdk-ts/harness-capabilities.json")) as {
    harnesses: Record<string, {
      retired?: boolean;
      models: { alias: string; modelId: string }[];
      defaultEffort: string;
      defaultModel: string;
    }>;
  };
  const page = read("docs-evals/core-concepts/models.mdx");
  const tabEntries = [...page.matchAll(/<Tab title="[^"]+">([\s\S]*?)<\/Tab>/g)]
    .map((match) => {
      const body = match[1];
      const name = body.match(/\*\*Harness:\*\* `([^`]+)`/)?.[1];
      assert.ok(name, "Each harness tab must name its CLI/SDK identifier");
      return [name, body] as const;
    });
  const tabs = new Map(tabEntries);
  assert.equal(tabEntries.length, tabs.size, "Each harness must have exactly one tab");
  const active = Object.entries(harnesses).filter(([, spec]) => !spec.retired);
  assert.deepEqual([...tabs.keys()].sort(), active.map(([name]) => name).sort());
  const codeValues = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

  for (const [name, spec] of active) {
    const body = tabs.get(name)!;
    const models: string[] = [];
    const alternatives: [string, string][] = [];
    const beforeTable = body.slice(0, body.indexOf("| Model |"));
    assert.equal(beforeTable.match(/\*\*Default model:\*\* `([^`]+)`/)?.[1], spec.defaultModel,
      `${name}: show the Agent SDK default model above the table`);
    assert.equal(beforeTable.match(/\*\*Default effort:\*\* `([^`]+)`/)?.[1], spec.defaultEffort,
      `${name}: show the configured default effort above the table`);
    for (const table of body.matchAll(/^[ \t]*\|([^\n]+)\|[ \t]*\n[ \t]*\|[ :|\-]+\|[ \t]*\n((?:[ \t]*\|[^\n]+\|[ \t]*(?:\n|$))+)/gm)) {
      const columns = table[1].split("|").map((column) => column.trim());
      for (const row of table[2].trim().split("\n").filter((line) => line.trim().startsWith("|"))) {
        const cells = row.trim().slice(1, -1).split("|");
        if (columns[0] === "Model") {
          const model = codeValues(cells[1]);
          assert.equal(model.length, 1, `${name}: each model row needs one runtime string`);
          models.push(model[0]);
          assert.equal(columns[2], "Supported reasoning efforts", `${name}: effort belongs beside each model`);
          assert.ok(cells[2]?.trim(), `${name}/${model[0]}: missing effort guidance`);
          // Model support comes from independent harness/provider evidence;
          // Evolve's broad input enum is not a model capability specification.
          assert.doesNotMatch(cells[2], /not verified|not applied|configured|default ignored/i,
            `${name}/${model[0]}: resolve the model contract before documenting it`);
          assert.doesNotMatch(row, /SDK default|\(default\)|model-default/,
            `${name}/${model[0]}: defaults belong above the table`);
        }
        if (columns[1] === "Also accepted") {
          const aliases = codeValues(cells[0]);
          const modelIds = codeValues(cells[1]);
          assert.equal(aliases.length, 1, `${name}: alternate spelling needs one alias`);
          assert.equal(modelIds.length, 1, `${name}: alternate spelling needs one model ID`);
          alternatives.push([aliases[0], modelIds[0]]);
        }
      }
    }
    assert.deepEqual(models.sort(), spec.models.map((model) => model.alias).sort(), `${name}: model strings, each listed once`);
    assert.deepEqual(alternatives.sort(), spec.models
      .filter((model) => model.alias !== model.modelId)
      .map((model) => [model.alias, model.modelId]).sort(), `${name}: alternate spellings, each paired with its alias once`);
    assert.doesNotMatch(body, /\*\*Effort (?:inputs|levels):\*\*/, `${name}: do not replace per-model guidance with a harness-wide enum`);
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
      assert.ok(claimMethodHeading(names, claimed, method, headingPrefix[client]), `${client}.${method} needs its own reference heading (${headingPrefix[client] ? `${headingPrefix[client]}.${method}` : method}, or a TypeScript / Python pair)`);
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
      assert.ok(claimMethodHeading(names, new Set(), method, headingPrefix[client]) || claimMethodHeading(names, new Set(), camelCase, headingPrefix[client]), `${client}.${method} needs its own reference section`);
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
