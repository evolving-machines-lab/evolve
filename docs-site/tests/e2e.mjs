#!/usr/bin/env node
/**
 * E2E tests: serve out/ and verify HTTP responses.
 * Uses a built-in Node.js static file server (zero dependencies).
 * Prerequisite: npm run build (out/ directory must exist)
 *
 * Usage: node tests/e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'out');
const PORT = 3457;

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

// --- Minimal static file server ---
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let filePath = path.join(OUT, url.pathname);

    // Try: exact path, then path + .html, then path/index.html
    const candidates = [
      filePath,
      filePath + '.html',
      path.join(filePath, 'index.html'),
    ];

    let found = null;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        found = candidate;
        break;
      }
    }

    if (!found) {
      // Try 404.html
      const notFound = path.join(OUT, '404.html');
      if (fs.existsSync(notFound)) {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end(fs.readFileSync(notFound));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
      return;
    }

    const ext = path.extname(found);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    res.end(fs.readFileSync(found));
  });

  return new Promise((resolve) => {
    server.listen(PORT, () => resolve(server));
  });
}

/** Make an HTTP GET request and return { statusCode, headers, body }. */
function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

// --- Run tests ---
const server = await startServer();
console.log(`Server running at http://localhost:${PORT}`);

try {
  // --- Group 1: All pages return HTTP 200 ---
  console.log('\n=== HTTP 200 for all pages ===');

  const pages = [
    '/',
    '/typescript',
    '/typescript/01-getting-started',
    '/typescript/02-configuration',
    '/typescript/03-runtime',
    '/typescript/04-streaming',
    '/typescript/05-swarm-pipeline',
    '/python',
    '/python/01-getting-started',
    '/python/02-configuration',
    '/python/03-runtime',
    '/python/04-streaming',
    '/python/05-swarm-pipeline',
    '/changelog',
  ];

  for (const page of pages) {
    const res = await get(page);
    assert(res.statusCode === 200, `GET ${page} -> 200 (got ${res.statusCode})`);
  }

  // --- Group 2: Content-Type headers ---
  console.log('\n=== Content-Type ===');

  for (const page of pages.slice(0, 3)) { // Spot check a few
    const res = await get(page);
    assert(
      res.headers['content-type']?.includes('text/html'),
      `GET ${page} Content-Type is text/html`
    );
  }

  // --- Group 3: Response body content ---
  console.log('\n=== Response body content ===');

  const indexRes = await get('/');
  assert(indexRes.body.includes('Evolve SDK'), 'GET / body contains "Evolve SDK"');

  const tsRes = await get('/typescript');
  assert(
    tsRes.body.includes('evolvingmachines') || tsRes.body.includes('TypeScript'),
    'GET /typescript body contains expected content'
  );

  const pyRes = await get('/python');
  assert(
    pyRes.body.includes('evolve') || pyRes.body.includes('Python'),
    'GET /python body contains expected content'
  );

  const clRes = await get('/changelog');
  assert(clRes.body.includes('Changelog') || clRes.body.includes('changelog'), 'GET /changelog has title');

  const tsGsRes = await get('/typescript/01-getting-started');
  assert(tsGsRes.body.includes('Install'), 'GET /typescript/01-getting-started contains "Install"');

  // --- Group 4: 404 handling ---
  console.log('\n=== 404 handling ===');

  const notFoundRes = await get('/nonexistent-page');
  assert(notFoundRes.statusCode === 404, `GET /nonexistent-page -> 404 (got ${notFoundRes.statusCode})`);

} finally {
  server.close();
}

// --- Summary ---
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
