#!/usr/bin/env node
/**
 * Unit tests for docs-site content structure.
 * No build required. Validates _meta.ts, symlinks, file existence, links.
 *
 * Usage: node tests/unit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCS = path.resolve(ROOT, '..', 'docs');
const CONTENT = path.join(ROOT, 'content');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

// --- Group 1: Symlinks ---
console.log('\n=== Symlinks ===');

assert(
  fs.lstatSync(CONTENT).isSymbolicLink(),
  'content is a symlink'
);
assert(
  fs.realpathSync(CONTENT) === fs.realpathSync(DOCS),
  'content symlink resolves to docs/'
);
assert(
  fs.lstatSync(path.join(DOCS, 'changelog.md')).isSymbolicLink(),
  'docs/changelog.md is a symlink'
);
assert(
  fs.existsSync(fs.realpathSync(path.join(DOCS, 'changelog.md'))),
  'docs/changelog.md symlink target exists (CHANGELOG.md)'
);

// --- Group 2: _meta.ts validation ---
console.log('\n=== _meta.ts validation ===');

const rootMeta = (await import(path.join(DOCS, '_meta.ts'))).default;
assert(typeof rootMeta === 'object', 'docs/_meta.ts exports an object');
assert(rootMeta.index?.display === 'hidden', 'index is hidden');
assert(rootMeta.typescript?.type === 'page' && rootMeta.typescript?.title === 'TypeScript SDK', 'typescript tab configured');
assert(rootMeta.python?.type === 'page' && rootMeta.python?.title === 'Python SDK', 'python tab configured');
assert(rootMeta.changelog?.type === 'page' && rootMeta.changelog?.title === 'Changelog', 'changelog tab configured');
assert(rootMeta.cookbooks?.href?.includes('github.com'), 'cookbooks has external href');
assert(rootMeta.cookbooks?.type === 'page', 'cookbooks is type page');
assert(rootMeta['continualcode-poc']?.display === 'hidden', 'continualcode-poc is hidden');

const tsMeta = (await import(path.join(DOCS, 'typescript', '_meta.ts'))).default;
const expectedTsKeys = ['index', '01-getting-started', '02-configuration', '03-runtime', '04-streaming', '05-swarm-pipeline'];
assert(
  JSON.stringify(Object.keys(tsMeta)) === JSON.stringify(expectedTsKeys),
  `typescript _meta.ts has correct keys: ${expectedTsKeys.join(', ')}`
);
assert(tsMeta.index === 'Overview', 'typescript index title is Overview');
assert(tsMeta['01-getting-started'] === 'Getting Started', 'typescript getting-started title correct');

const pyMeta = (await import(path.join(DOCS, 'python', '_meta.ts'))).default;
assert(
  JSON.stringify(Object.keys(pyMeta)) === JSON.stringify(expectedTsKeys),
  'python _meta.ts has same keys as typescript'
);
assert(pyMeta.index === 'Overview', 'python index title is Overview');

// --- Group 3: File existence ---
console.log('\n=== File existence ===');

const expectedFiles = [
  'index.md',
  'changelog.md',
  'continualcode-poc.md',
  'typescript/index.md',
  'typescript/01-getting-started.md',
  'typescript/02-configuration.md',
  'typescript/03-runtime.md',
  'typescript/04-streaming.md',
  'typescript/05-swarm-pipeline.md',
  'python/index.md',
  'python/01-getting-started.md',
  'python/02-configuration.md',
  'python/03-runtime.md',
  'python/04-streaming.md',
  'python/05-swarm-pipeline.md',
];

for (const file of expectedFiles) {
  const fullPath = path.join(DOCS, file);
  const exists = fs.existsSync(fullPath);
  const nonEmpty = exists && fs.statSync(fullPath).size > 0;
  assert(exists && nonEmpty, `${file} exists and is non-empty`);
}

// --- Group 4: Internal link validation ---
console.log('\n=== Internal link validation ===');

const mdLinkRegex = /\[([^\]]*)\]\((\.[^)]*\.md[^)]*)\)/g;
let brokenLinks = 0;

for (const file of expectedFiles) {
  const fullPath = path.join(DOCS, file);
  const content = fs.readFileSync(fullPath, 'utf-8');
  const dir = path.dirname(fullPath);
  let match;
  while ((match = mdLinkRegex.exec(content)) !== null) {
    const [, , linkTarget] = match;
    const targetPath = linkTarget.split('#')[0];
    if (targetPath) {
      const resolved = path.resolve(dir, targetPath);
      if (!fs.existsSync(resolved)) {
        console.error(`  FAIL: Broken link in ${file}: ${linkTarget} -> ${resolved}`);
        brokenLinks++;
        failed++;
      }
    }
  }
}
if (brokenLinks === 0) {
  passed++;
  console.log('  PASS: No broken internal .md links found');
}

// --- Group 5: Config files exist ---
console.log('\n=== Config files ===');

const configFiles = [
  'next.config.mjs',
  'mdx-components.js',
  'src/app/layout.jsx',
  'src/app/[[...mdxPath]]/page.jsx',
];

for (const file of configFiles) {
  assert(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
}

// --- Group 6: Layout content validation ---
console.log('\n=== Layout content ===');

const layoutContent = fs.readFileSync(path.join(ROOT, 'src/app/layout.jsx'), 'utf-8');
assert(layoutContent.includes('docsRepositoryBase'), 'layout has docsRepositoryBase');
assert(layoutContent.includes('github.com/evolving-machines-lab/evolve'), 'layout has correct GitHub URL');
assert(layoutContent.includes('projectLink'), 'layout has projectLink');
assert(layoutContent.includes('Evolve SDK'), 'layout has Evolve SDK text');
assert(layoutContent.includes('Apache-2.0'), 'layout has Apache-2.0 in footer');
assert(layoutContent.includes('search={false}'), 'layout has search disabled');

// --- Summary ---
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
