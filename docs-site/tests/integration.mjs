#!/usr/bin/env node
/**
 * Integration tests for docs-site build output.
 * Prerequisite: npm run build (out/ directory must exist)
 *
 * Usage: node tests/integration.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

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

/** Find HTML file for a page path, trying both flat and nested patterns. */
function findPage(pagePath) {
  const flat = path.join(OUT, `${pagePath}.html`);
  const nested = path.join(OUT, pagePath, 'index.html');
  const root = path.join(OUT, pagePath + '.html');
  if (fs.existsSync(flat)) return flat;
  if (fs.existsSync(nested)) return nested;
  if (pagePath === '' && fs.existsSync(path.join(OUT, 'index.html'))) return path.join(OUT, 'index.html');
  return null;
}

function readPage(pagePath) {
  const file = findPage(pagePath);
  return file ? fs.readFileSync(file, 'utf-8') : null;
}

// --- Group 1: Build output exists ---
console.log('\n=== Build output ===');
assert(fs.existsSync(OUT), 'out/ directory exists');
assert(fs.existsSync(path.join(OUT, 'index.html')), 'out/index.html exists');

// Count HTML files
function countHtml(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countHtml(path.join(dir, entry.name));
    else if (entry.name.endsWith('.html')) count++;
  }
  return count;
}
const htmlCount = countHtml(OUT);
assert(htmlCount >= 15, `At least 15 HTML files generated (found ${htmlCount})`);

// --- Group 2: All expected pages ---
console.log('\n=== Expected pages ===');

const expectedPages = [
  '',  // index
  'typescript',
  'typescript/01-getting-started',
  'typescript/02-configuration',
  'typescript/03-runtime',
  'typescript/04-streaming',
  'typescript/05-swarm-pipeline',
  'python',
  'python/01-getting-started',
  'python/02-configuration',
  'python/03-runtime',
  'python/04-streaming',
  'python/05-swarm-pipeline',
  'changelog',
];

for (const page of expectedPages) {
  const file = findPage(page);
  assert(file !== null, `Page "${page || '/'}" has HTML output`);
}

// --- Group 3: Content markers ---
console.log('\n=== Content markers ===');

const indexHtml = readPage('');
if (indexHtml) {
  assert(indexHtml.includes('Evolve SDK'), 'index contains "Evolve SDK"');
  assert(indexHtml.includes('TypeScript SDK'), 'index contains "TypeScript SDK" nav');
  assert(indexHtml.includes('Python SDK'), 'index contains "Python SDK" nav');
}

const tsOverview = readPage('typescript');
if (tsOverview) {
  assert(tsOverview.includes('evolvingmachines/sdk') || tsOverview.includes('@evolvingmachines'), 'TS overview contains package name');
}

const pyOverview = readPage('python');
if (pyOverview) {
  assert(pyOverview.includes('evolve-sdk') || pyOverview.includes('pip install'), 'Python overview contains package name');
}

const changelog = readPage('changelog');
if (changelog) {
  assert(changelog.includes('Changelog') || changelog.includes('changelog'), 'Changelog page contains title');
}

// Verify each page has valid HTML structure
for (const page of expectedPages) {
  const html = readPage(page);
  if (html) {
    assert(html.includes('<html') && html.includes('</html>'), `Page "${page || '/'}" has valid HTML structure`);
  }
}

// --- Group 4: Navigation HTML ---
console.log('\n=== Navigation ===');

// Use a doc page that should have full navigation
const tsGettingStarted = readPage('typescript/01-getting-started');
const navSource = tsGettingStarted || indexHtml;
if (navSource) {
  assert(navSource.includes('TypeScript SDK'), 'Nav contains "TypeScript SDK"');
  assert(navSource.includes('Python SDK'), 'Nav contains "Python SDK"');
  assert(navSource.includes('Changelog'), 'Nav contains "Changelog"');
  assert(navSource.includes('Cookbooks'), 'Nav contains "Cookbooks"');
  assert(
    navSource.includes('github.com/evolving-machines-lab/evolve/tree/main/cookbooks'),
    'Cookbooks link points to correct GitHub URL'
  );
}

// --- Group 5: Sidebar ---
console.log('\n=== Sidebar ===');

if (tsGettingStarted) {
  const sidebarEntries = ['Overview', 'Getting Started', 'Configuration', 'Runtime', 'Streaming', 'Swarm'];
  for (const entry of sidebarEntries) {
    assert(tsGettingStarted.includes(entry), `TS sidebar contains "${entry}"`);
  }
}

const pyGettingStarted = readPage('python/01-getting-started');
if (pyGettingStarted) {
  assert(pyGettingStarted.includes('Overview'), 'Python sidebar contains "Overview"');
  assert(pyGettingStarted.includes('Getting Started'), 'Python sidebar contains "Getting Started"');
}

// --- Group 6: Footer ---
console.log('\n=== Footer ===');

if (navSource) {
  assert(navSource.includes('Apache-2.0'), 'Footer contains "Apache-2.0"');
  assert(navSource.includes('Evolving Machines'), 'Footer contains "Evolving Machines"');
}

// --- Group 7: Static assets ---
console.log('\n=== Static assets ===');

const nextDir = path.join(OUT, '_next');
assert(fs.existsSync(nextDir), '_next/ directory exists');

function findFilesWithExt(dir, ext) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...findFilesWithExt(full, ext));
      else if (entry.name.endsWith(ext)) results.push(full);
    }
  } catch { /* ignore */ }
  return results;
}

assert(findFilesWithExt(nextDir, '.js').length > 0, '_next/ contains JS bundles');
assert(findFilesWithExt(nextDir, '.css').length > 0, '_next/ contains CSS bundles');

// --- Group 8: No broken internal links ---
console.log('\n=== Internal link integrity ===');

const hrefRegex = /href="(\/[^"]*?)"/g;
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';
let brokenCount = 0;

for (const page of expectedPages) {
  const html = readPage(page);
  if (!html) continue;
  let match;
  const regex = new RegExp(hrefRegex.source, 'g');
  while ((match = regex.exec(html)) !== null) {
    let href = match[1];
    // Strip base path prefix if present
    if (BASE_PATH && href.startsWith(BASE_PATH)) {
      href = href.slice(BASE_PATH.length) || '/';
    }
    // Skip anchors, query strings, _next assets, and external paths
    if (href.startsWith('/_next') || href.includes('#') || href.includes('?')) continue;
    // Check if the target exists as a page
    const targetPage = href.replace(/^\//, '').replace(/\/$/, '');
    const targetFile = findPage(targetPage);
    if (!targetFile) {
      // Also try as a directory with index.html
      const asDir = path.join(OUT, href.replace(/^\//, ''), 'index.html');
      if (!fs.existsSync(asDir) && !fs.existsSync(path.join(OUT, href.replace(/^\//, '') + '.html'))) {
        brokenCount++;
        if (brokenCount <= 5) {
          console.error(`  WARN: Potentially broken link on "${page || '/'}": ${match[1]}`);
        }
      }
    }
  }
}
assert(brokenCount === 0, `No broken internal HTML links (found ${brokenCount})`);

// --- Summary ---
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
