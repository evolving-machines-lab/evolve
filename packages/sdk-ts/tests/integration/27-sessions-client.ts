#!/usr/bin/env tsx
/**
 * Integration Test 27: Sessions Client
 *
 * End-to-end test for the standalone sessions() client against the live dashboard.
 * Tests all 4 methods:
 *   1. list()     — paginated listing with filters (state, agent, tagPrefix, sort)
 *   2. get()      — single session metadata
 *   3. events()   — parsed JSONL events + delta fetch with since
 *   4. download() — raw trace file to disk (streaming)
 *
 * Gateway-only — requires EVOLVE_API_KEY.
 *
 * Usage:
 *   npx tsx tests/integration/27-sessions-client.ts
 */

import { sessions } from "../../dist/index.js";
import type { SessionInfo, SessionPage, SessionEvent } from "../../dist/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "fs";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/27-sessions-client");

function log(msg: string) {
  console.log(`[27] ${msg}`);
}

function save(name: string, content: string) {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(resolve(LOGS_DIR, name), content);
}

function assertEq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  log(`  ✓ ${label}`);
}

function assert(condition: boolean, label: string) {
  if (!condition) {
    throw new Error(`${label}: assertion failed`);
  }
  log(`  ✓ ${label}`);
}

async function main() {
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  const apiKey = process.env.EVOLVE_API_KEY;
  if (!apiKey) {
    log("SKIP: EVOLVE_API_KEY not set");
    process.exit(0);
  }

  log("Starting sessions() client integration test...\n");
  const start = Date.now();

  const client = sessions();

  try {
    // ── 1. list() — basic ────────────────────────────────────────────
    log("── 1. list(limit=5, state='ended', sort='newest')");
    const page: SessionPage = await client.list({
      limit: 5,
      state: "ended",
      sort: "newest",
    });
    assert(Array.isArray(page.items), "items is array");
    assert(typeof page.hasMore === "boolean", "hasMore is boolean");
    assert(page.nextCursor === null || typeof page.nextCursor === "string", "nextCursor is string|null");
    for (const item of page.items) {
      assertEq(item.state, "ended", `item ${item.id.slice(0, 12)} state=ended`);
    }
    log(`  → ${page.items.length} items, hasMore=${page.hasMore}`);
    save("list-basic.json", JSON.stringify(page, null, 2));

    if (page.items.length === 0) {
      log("SKIP: No sessions found — cannot test get/events/download");
      process.exit(0);
    }

    const session = page.items[0];

    // ── 2. list() — filter by agent ──────────────────────────────────
    log(`\n── 2. list(agent='${session.agent}', limit=3)`);
    const filtered = await client.list({ agent: session.agent, limit: 3 });
    for (const item of filtered.items) {
      assertEq(item.agent, session.agent, `agent=${session.agent}`);
    }
    log(`  → ${filtered.items.length} items, all agent=${session.agent}`);

    // ── 3. list() — filter by tagPrefix ──────────────────────────────
    const prefix = session.tag.slice(0, 4);
    log(`\n── 3. list(tagPrefix='${prefix}', limit=3)`);
    const tagged = await client.list({ tagPrefix: prefix, limit: 3 });
    for (const item of tagged.items) {
      assert(item.tag.startsWith(prefix), `tag '${item.tag}' starts with '${prefix}'`);
    }
    log(`  → ${tagged.items.length} items matching prefix`);

    // ── 4. list() — pagination ───────────────────────────────────────
    log("\n── 4. Pagination: list(limit=2) then list(cursor=nextCursor)");
    const p1 = await client.list({ limit: 2, state: "ended" });
    if (p1.nextCursor) {
      const p2 = await client.list({ limit: 2, state: "ended", cursor: p1.nextCursor });
      const p1Ids = new Set(p1.items.map(i => i.id));
      const p2Ids = new Set(p2.items.map(i => i.id));
      const overlap = [...p1Ids].filter(id => p2Ids.has(id));
      assertEq(overlap.length, 0, "pages don't overlap");
      log(`  → Page 1: ${p1.items.length}, Page 2: ${p2.items.length}, no overlap`);
    } else {
      log(`  → Only ${p1.items.length} total, no second page`);
    }

    // ── 5. list() — sort by cost ─────────────────────────────────────
    log("\n── 5. list(sort='cost', limit=5, state='ended')");
    const costSorted = await client.list({ sort: "cost", limit: 5, state: "ended" });
    const costs = costSorted.items
      .map(i => i.cost)
      .filter((c): c is number => c !== null);
    if (costs.length >= 2) {
      const isDescending = costs.every((c, i) => i === 0 || costs[i - 1] >= c);
      assert(isDescending, `costs sorted desc: [${costs.join(", ")}]`);
    }
    log(`  → ${costs.length} costed items`);

    // ── 6. get() — single session ────────────────────────────────────
    log(`\n── 6. get('${session.id.slice(0, 12)}...')`);
    const info: SessionInfo = await client.get(session.id);
    assertEq(info.id, session.id, "id matches");
    assertEq(info.tag, session.tag, "tag matches");
    assertEq(info.agent, session.agent, "agent matches");
    assert(["live", "ended"].includes(info.state), `state is live|ended`);
    assert(["alive", "dead", "unknown"].includes(info.runtimeStatus), `runtimeStatus valid`);
    assert(typeof info.stepCount === "number", "stepCount is number");
    assert(typeof info.createdAt === "string", "createdAt is string");
    log(`  → model=${info.model} provider=${info.provider} cost=${info.cost}`);
    log(`  → sandboxId=${info.sandboxId} runtimeStatus=${info.runtimeStatus}`);
    log(`  → stepCount=${info.stepCount} toolStats=${JSON.stringify(info.toolStats)}`);
    save("get-session.json", JSON.stringify(info, null, 2));

    // ── 7. events() — full fetch ─────────────────────────────────────
    log(`\n── 7. events('${session.id.slice(0, 12)}...')`);
    const events: SessionEvent[] = await client.events(session.id);
    assert(Array.isArray(events), "events is array");
    log(`  → ${events.length} events`);
    if (events.length > 0) {
      log(`  → first event keys: [${Object.keys(events[0]).slice(0, 5).join(", ")}]`);
    }
    save("events.json", JSON.stringify(events, null, 2));

    // ── 8. events() — since=0 (falsy but valid) ─────────────────────
    log(`\n── 8. events(since=0) — falsy-but-valid edge case`);
    const eventsSince0 = await client.events(session.id, { since: 0 });
    assertEq(eventsSince0.length, events.length, "since=0 returns same count as full fetch");

    // ── 9. events() — delta fetch ────────────────────────────────────
    if (events.length > 2) {
      const sinceN = events.length - 2;
      log(`\n── 9. events(since=${sinceN}) — delta fetch`);
      const delta = await client.events(session.id, { since: sinceN });
      assert(delta.length <= events.length, `delta (${delta.length}) <= full (${events.length})`);
      log(`  → ${delta.length} events (delta from ${sinceN})`);
    } else {
      log("\n── 9. SKIP: not enough events for delta test");
    }

    // ── 10. download() — stream to temp dir ──────────────────────────
    const tmpDir = await mkdtemp(join(tmpdir(), "evolve-test-27-"));
    try {
      log(`\n── 10. download('${session.id.slice(0, 12)}...', to='${tmpDir}')`);
      const path = await client.download(session.id, { to: tmpDir });
      assert(typeof path === "string", "path is string");
      assert(existsSync(path), `file exists: ${path}`);
      const size = statSync(path).size;
      assert(size > 0, `file is non-empty (${size} bytes)`);
      const firstLine = readFileSync(path, "utf-8").split("\n")[0].trim();
      assert(firstLine.startsWith("{"), "first line is valid JSONL");
      log(`  → path=${path}`);
      log(`  → size=${size} bytes`);
      save("download-path.txt", path);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // ── Done ─────────────────────────────────────────────────────────
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`PASS — All 10 tests passed (${duration}s)`);
    log(`============================================================\n`);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    save("error.txt", err instanceof Error ? err.stack || msg : msg);

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`FAIL — ${msg} (${duration}s)`);
    log(`============================================================\n`);
    process.exit(1);
  }
}

main();
