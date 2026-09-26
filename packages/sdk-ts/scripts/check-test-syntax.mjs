// tsx runs one test file at a time, so a helper no suite imports can sit unparseable and every gate
// stays green (two files did on 2026-09-25); TypeScript's own parser reads the whole tests tree here.
import { readFileSync } from "node:fs";
import ts from "typescript";

const files = ts.sys.readDirectory("tests", [".ts"]);
let errors = 0;
for (const file of files) {
  const { diagnostics = [] } = ts.transpileModule(readFileSync(file, "utf8"), { fileName: file, reportDiagnostics: true });
  for (const d of diagnostics) {
    const where = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
    console.error(`${file}:${where.line + 1}:${where.character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    errors++;
  }
}
if (errors > 0) {
  console.error(`check-test-syntax: ${errors} syntax error(s) in tests/`);
  process.exit(1);
}
console.log(`check-test-syntax: ${files.length} files under tests/ parse`);
