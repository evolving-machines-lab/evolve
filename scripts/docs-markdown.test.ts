import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderDocsMarkdown } from "./docs-markdown.js";

const options = { root: "/docs", file: "/docs/page.mdx" };

test("keeps the full contents of responsive reference wrappers", () => {
  const source = '<div className="error-code-catalog">\n\n## Keys\n\n| Code | Meaning |\n| --- | --- |\n| `read_only_key` | Use a key with write access. |\n\n[Handle errors](/sdk-reference/errors)\n\n</div>';
  const result = renderDocsMarkdown(source, options);
  assert.ok(result.includes("## Keys"));
  assert.ok(result.includes("| `read_only_key` | Use a key with write access. |"));
  assert.ok(result.includes("[Handle errors](/sdk-reference/errors)"));
  assert.ok(!result.includes("<div"));
});

test("keeps literal code and nested language examples intact", () => {
  const source = '<Tabs>\n  <Tab title="TypeScript">\n    ```typescript\n    import { jobs } from "@evolvingmachines/evolve";\n    const result: Promise<Job> = jobs().get("id");\n    // <Card title="not a component" />\n    ```\n  </Tab>\n  <Tab title="Python">\n    Use `list[Job]` and `await jobs().get("id")`.\n  </Tab>\n</Tabs>';
  const result = renderDocsMarkdown(source, options);
  assert.match(result, /### TypeScript/);
  assert.match(result, /### Python/);
  assert.ok(result.includes('```typescript\nimport { jobs } from "@evolvingmachines/evolve";\nconst result: Promise<Job>'));
  assert.ok(result.includes('// <Card title="not a component" />'));
  assert.ok(result.includes('Use `list[Job]` and `await jobs().get("id")`.'));
  assert.ok(!result.includes("<Tabs>"));
});

test("preserves field metadata, links, callouts, step order, and tree indentation", () => {
  const source = '<Steps><Step title="Install">One.</Step><Step title="Run">Two.</Step></Steps>\n<Card title="Files" href="/files">Read outputs.</Card>\n<ParamField body="limit" type="number" default={50} required>Page size.</ParamField>\n<Warning>Costs apply.</Warning>\n<FileTree>\n- task/\n  - tests/\n    - test.sh\n</FileTree>';
  const result = renderDocsMarkdown(source, options);
  assert.match(result, /### 1\. Install/);
  assert.match(result, /### 2\. Run/);
  assert.ok(result.includes('[Files](/files)'));
  assert.ok(result.includes('Type: `number`. Required. Default: `50`.'));
  assert.ok(result.includes('**Warning:**\n\nCosts apply.'));
  assert.ok(result.includes('- task/\n  - tests/\n    - test.sh'));
});

test("expands snippets without leaving imports or losing examples", () => {
  const root = mkdtempSync(join(tmpdir(), "evolve-docs-render-"));
  try {
    mkdirSync(join(root, "snippets"));
    writeFileSync(join(root, "snippets", "flags.mdx"), '<ParamField path="--json">Print JSON.</ParamField>\n```python\nimport evolve\n```');
    const result = renderDocsMarkdown('import Flags from "/snippets/flags.mdx";\n\n<Flags />', { root, file: join(root, "page.mdx") });
    assert.ok(result.includes('### `--json`'));
    assert.ok(result.includes('```python\nimport evolve\n```'));
    assert.ok(!result.includes('import Flags'));
    assert.ok(!result.includes('<Flags'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuses unknown components, dynamic attributes, malformed nesting and escaping imports", () => {
  assert.throws(() => renderDocsMarkdown('<Unknown>Important fact.</Unknown>', options), /unsupported component/);
  assert.throws(() => renderDocsMarkdown('<Card title={computeTitle()} />', options), /literal/);
  assert.throws(() => renderDocsMarkdown('<Tab title="A">Text</Tabs>', options), /expected/);
  assert.throws(() => renderDocsMarkdown('<Tab title="A">Text', options), /missing/);
  assert.throws(() => renderDocsMarkdown('import Secret from "../outside.mdx";\n<Secret />', options), /escapes/);
});

test("refuses circular snippet imports", () => {
  const root = mkdtempSync(join(tmpdir(), "evolve-docs-render-"));
  try {
    const file = join(root, "page.mdx");
    const source = 'import Self from "./page.mdx";\n<Self />';
    writeFileSync(file, source);
    assert.throws(() => renderDocsMarkdown(source, { root, file }), /Circular/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dedents prose after nested components without changing literal content", () => {
  const source = '<Steps>\n  <Step title="Publish">\n    Before.\n    <Tabs>\n      <Tab title="Local">\n        Example.\n      </Tab>\n    </Tabs>\n    After.\n\n    - Parent\n      - Child\n  </Step>\n</Steps>\n\n`EVOLVE_DOC_LITERAL_0_END`';
  const result = renderDocsMarkdown(source, options);
  assert.match(result, /\nAfter\./);
  assert.ok(!result.includes("    After."));
  assert.ok(result.includes("- Parent\n  - Child"));
  assert.ok(result.includes("`EVOLVE_DOC_LITERAL_0_END`"));
});

test("dedents prose and lists after a snippet imported inside a step", () => {
  const root = mkdtempSync(join(tmpdir(), "evolve-docs-nested-snippet-"));
  try {
    writeFileSync(join(root, "flags.mdx"), '<ParamField path="--json">Print JSON.</ParamField>\n```python\nimport evolve\n```');
    const source = 'import Flags from "./flags.mdx";\n<Steps>\n  <Step title="Run">\n    Before.\n    <Flags />\n    After.\n\n    - Parent\n      - Child\n  </Step>\n</Steps>';
    const result = renderDocsMarkdown(source, { root, file: join(root, "page.mdx") });
    assert.ok(result.includes("\nAfter.\n"));
    assert.ok(result.includes("- Parent\n  - Child"));
    assert.ok(result.includes("### `--json`\n\nPrint JSON."));
    assert.ok(result.includes("```python\nimport evolve\n```"));
    assert.ok(!result.includes("    After."));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("normalizes expanded component spacing without changing blank lines inside code", () => {
  const code = '```python\ndef example():\n    first = 1\n\n\n    return first\n```';
  const source = `<Steps>\n  <Step title="Run">\n    <Tabs>\n      <Tab title="Python">\n${code.split("\n").map((line) => `        ${line}`).join("\n")}\n      </Tab>\n    </Tabs>\n    After.\n  </Step>\n</Steps>\n<Card title="Next" href="/next">Continue.</Card>`;
  const result = renderDocsMarkdown(source, options);
  assert.ok(result.includes(code));
  assert.ok(!result.replace(code, "CODE").includes("\n\n\n"));
  assert.ok(result.startsWith("### 1. Run\n\n### Python"));
  assert.ok(result.endsWith("**[Next](/next)**\n\nContinue.\n"));
});

test("a callout keeps a leading code block, list or table as Markdown", () => {
  const fence = renderDocsMarkdown("<Note>\n```bash\nevolve run\n```\n</Note>", options);
  assert.ok(fence.includes("**Note:**\n\n```bash\nevolve run\n```"));
  const list = renderDocsMarkdown("<Tip>\n- a\n- b\n</Tip>", options);
  assert.ok(list.includes("**Tip:**\n\n- a\n- b"));
});

test("raw HTML the skill cannot show fails generation; inline tags keep their text", () => {
  assert.throws(() => renderDocsMarkdown('<video src="/demo.mp4" />', options), /raw <video>/);
  assert.throws(() => renderDocsMarkdown("<table><tr><td>x</td></tr></table>", options), /raw <(table|tr|td)>/);
  assert.throws(() => renderDocsMarkdown('<Steps><Step>No title.</Step></Steps>', options), /Step needs a title/);
  assert.equal(renderDocsMarkdown("Press <kbd>Enter</kbd>.", options), "Press Enter.\n");
  assert.equal(renderDocsMarkdown("Run <code>evolve run</code> now; x<sup>2</sup>, H<sub>2</sub>O, <b>bold</b>, <em>soft</em>.", options), "Run `evolve run` now; x^2^, H2O, **bold**, *soft*.\n");
  assert.equal(renderDocsMarkdown("Paths like <year>/<month>/<id> stay literal.", options), "Paths like <year>/<month>/<id> stay literal.\n");
  assert.throws(() => renderDocsMarkdown('<audio src="/a.mp3" />', options), /raw <audio>/);
  assert.throws(() => renderDocsMarkdown('<svg width="10"><circle r="1" /></svg>', options), /raw <svg>/);
  assert.throws(() => renderDocsMarkdown("<hr>", options), /raw <hr>/);
  assert.throws(() => renderDocsMarkdown("<pre>raw <Card> text</pre>", options), /raw <pre>/);
  assert.throws(() => renderDocsMarkdown("a <label> placeholder", options), /raw <label>/);
  assert.equal(renderDocsMarkdown("A line<br>continues", options), "A line\ncontinues\n");
  assert.throws(() => renderDocsMarkdown("<Note></Note>", options), /empty <Note>/);
  assert.throws(() => renderDocsMarkdown('<a href="/x" />', options), /needs link text/);
  assert.equal(renderDocsMarkdown('See <a href="/x">the page</a>.', options), "See [the page](/x).\n");
});
