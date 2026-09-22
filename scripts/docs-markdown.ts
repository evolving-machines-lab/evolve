/** Render the documentation's supported MDX components as readable skill text.
 * Content is authored once. Unsupported components fail generation instead of
 * silently dropping instructions, parameters, or examples.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import ts from "typescript";

type Attributes = Record<string, string | boolean>;
const containers = new Set(["CardGroup", "Tabs", "CodeGroup", "Steps", "AccordionGroup", "FileTree", "Tree"]);
const titled = new Set(["Tab", "Accordion", "Expandable"]);
const callouts = new Set(["Note", "Tip", "Warning", "Info", "Check", "Danger"]);
const fencedCode = /^([ \t]*)(`{3,}|~{3,})([^\n]*)\n[\s\S]*?^\1\2[ \t]*$/gm;

/** Collapse presentation spacing only after components have been expanded.
 * Fenced examples keep their original blank lines and whitespace.
 */
function normalizeSpacing(text: string): string {
  const prose = (value: string) => value.replace(/\n[ \t]+\n/g, "\n\n").replace(/\n{3,}/g, "\n\n");
  let output = "";
  let offset = 0;
  for (const match of text.matchAll(fencedCode)) {
    output += prose(text.slice(offset, match.index)) + match[0];
    offset = match.index! + match[0].length;
  }
  return (output + prose(text.slice(offset))).trim();
}

function dedent(text: string): string {
  const lines = text.replace(/^\n|\n\s*$/g, "").split("\n");
  const nonempty = lines.filter((line) => line.trim());
  const indent = Math.min(...nonempty.map((line) => /^\s*/.exec(line)![0].length));
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join("\n").trim();
}

function attributes(tag: string, where: string): Attributes {
  const opening = tag.replace(/\/?\s*>$/, "/>");
  const source = ts.createSourceFile("component.tsx", `const element = ${opening};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const statement = source.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) throw new Error(`${where}: invalid component ${tag}`);
  const node = statement.declarationList.declarations[0].initializer;
  if (!node || !ts.isJsxSelfClosingElement(node)) throw new Error(`${where}: invalid component ${tag}`);
  const result: Attributes = {};
  for (const property of node.attributes.properties) {
    if (!ts.isJsxAttribute(property)) throw new Error(`${where}: spread attributes are not supported in skill content`);
    const name = property.name.getText(source);
    const value = property.initializer;
    if (!value) result[name] = true;
    else if (ts.isStringLiteral(value)) result[name] = value.text;
    else if (ts.isJsxExpression(value) && value.expression) {
      const expression = value.expression;
      if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) result[name] = expression.text;
      else if (expression.kind === ts.SyntaxKind.TrueKeyword) result[name] = true;
      else if (expression.kind === ts.SyntaxKind.FalseKeyword) result[name] = false;
      else throw new Error(`${where}: ${name} must be a literal, not executable JSX`);
    } else throw new Error(`${where}: unreadable ${name} attribute`);
  }
  return result;
}

/** Find > outside quotes and JSX expression braces. */
function tagEnd(text: string, start: number): number {
  let quote = "";
  let braces = 0;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === ">" && braces === 0) return i + 1;
  }
  throw new Error("Unterminated documentation component");
}

function component(name: string, props: Attributes, body: string, step: number, where: string): string {
  const content = dedent(body);
  const title = String(props.title ?? "");
  // Layout wrappers carry no instructions; retain their entire Markdown body.
  if (name === "div") return `\n\n${content}\n\n`;
  if (containers.has(name)) return `\n\n${content}\n\n`;
  if (name === "Card") {
    if (!title) throw new Error(`${where}: Card needs a title`);
    const label = props.href ? `[${title}](${props.href})` : title;
    return `\n\n**${label}**\n\n${content}\n\n`;
  }
  if (name === "Step") return `\n\n### ${step}. ${title}\n\n${content}\n\n`;
  if (titled.has(name)) return `\n\n${title ? `### ${title}\n\n` : ""}${content}\n\n`;
  if (callouts.has(name)) return `\n\n**${title || name}:** ${content}\n\n`;
  if (name === "Frame") return `\n\n${content}${props.caption ? `\n\n*${props.caption}*` : ""}\n\n`;
  if (name === "ParamField" || name === "ResponseField") {
    const field = props.body ?? props.query ?? props.path ?? props.header ?? props.name;
    if (!field) throw new Error(`${where}: ${name} needs a field name`);
    const details = [props.type && `Type: \`${props.type}\``, props.required === true && "Required", props.default !== undefined && `Default: \`${props.default}\``].filter(Boolean).join(". ");
    return `\n\n### \`${field}\`\n\n${details ? `${details}.\n\n` : ""}${content}\n\n`;
  }
  if (name === "img") {
    if (!props.src || !props.alt) throw new Error(`${where}: images need src and descriptive alt text`);
    return `![${props.alt}](${props.src})`;
  }
  if (name === "br") return "\n";
  throw new Error(`${where}: unsupported component <${name}>; add an explicit Markdown rendering`);
}

export function renderDocsMarkdown(input: string, options: { file: string; root: string; ancestors?: string[] }): string {
  const file = resolve(options.file);
  const ancestors = options.ancestors ?? [];
  if (ancestors.includes(file)) throw new Error(`Circular documentation import: ${[...ancestors, file].join(" -> ")}`);
  const saved: string[] = [];
  let prefix = "EVOLVE_DOC_LITERAL_";
  while (input.includes(prefix)) prefix += "_";
  const save = (value: string) => `${prefix}${saved.push(value) - 1}_END`;
  // Protect examples before interpreting any markup. Normalize only the MDX
  // indentation around a fenced example, never the example's own indentation.
  let text = input.replace(fencedCode, (block, indent: string) => {
    const normalized = block.split("\n").map((line: string) => line.startsWith(indent) ? line.slice(indent.length) : line).join("\n");
    return indent + save(normalized);
  });
  text = text.replace(/(`+)([^\n]*?)\1/g, (literal) => save(literal));
  text = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const imports = new Map<string, string>();
  text = text.replace(/^\s*import\s+([A-Z]\w*)\s+from\s+["']([^"']+)["'];?\s*$/gm, (_, name: string, reference: string) => {
    const root = resolve(options.root);
    let target = reference.startsWith("/") ? resolve(root, `.${reference}`) : resolve(dirname(file), reference);
    if (!target.endsWith(".mdx") && !target.endsWith(".md")) target += ".mdx";
    if (!target.startsWith(root + sep)) throw new Error(`${file}: documentation import escapes the site: ${reference}`);
    const source = readFileSync(target, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    const rendered = renderDocsMarkdown(source, { ...options, file: target, ancestors: [...ancestors, file] });
    imports.set(name, rendered);
    return "";
  });
  let position = 0;
  function render(expected?: string): string {
    let output = "";
    let step = 0;
    while (position < text.length) {
      const match = /<\/?(?:[A-Z][\w.]*|img|br|div)\b/.exec(text.slice(position));
      if (!match) {
        output += text.slice(position);
        position = text.length;
        break;
      }
      const start = position + match.index;
      output += text.slice(position, start);
      const end = tagEnd(text, start);
      const tag = text.slice(start, end);
      position = end;
      const name = /^<\/?([\w.]+)/.exec(tag)![1];
      if (tag.startsWith("</")) {
        if (name !== expected) throw new Error(`${file}: expected </${expected}>, got </${name}>`);
        return output;
      }
      const selfClosing = /\/\s*>$/.test(tag) || name === "img" || name === "br";
      if (imports.has(name)) {
        if (!selfClosing) throw new Error(`${file}: imported snippets must be self-closing`);
        output += save(`\n\n${imports.get(name)!}\n\n`);
        continue;
      }
      const props = attributes(tag, file);
      const child = selfClosing ? "" : render(name);
      // Keep the source indentation until the parent is rendered. Inserting
      // an already dedented child here would prevent the parent's following
      // prose from being dedented, turning it into an accidental code block.
      output += save(component(name, props, child, name === "Step" ? ++step : 0, file));
    }
    if (expected) throw new Error(`${file}: missing </${expected}>`);
    return output;
  }
  let result = render().replace(/\n[ \t]+\n/g, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
  if (/^\s*(?:import|export)\s/m.test(result)) throw new Error(`${file}: unresolved MDX import/export`);
  const literal = new RegExp(`${prefix}(\\d+)_END`, "g");
  const restore = (value: string): string => value.replace(literal, (_, index: string) => restore(saved[Number(index)]));
  result = normalizeSpacing(restore(result));
  return result + "\n";
}
