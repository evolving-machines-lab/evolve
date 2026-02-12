#!/usr/bin/env tsx
/**
 * Unit Test: Storage Config Resolution
 *
 * Tests resolveStorageConfig() URL parsing for all supported formats:
 * s3://, virtual-hosted AWS, R2, MinIO, and gateway mode.
 *
 * Usage:
 *   npm run test:unit:storage-config
 *   npx tsx tests/unit/storage-config.test.ts
 */

import {
  resolveStorageConfig,
  type StorageConfig,
} from "../../dist/index.js";

// =============================================================================
// TEST HELPERS
// =============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.log(`  \u2717 ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const match = actual === expected;
  if (match) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.log(`  \u2717 ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

async function assertThrows(fn: () => unknown, substring: string, message: string): Promise<void> {
  try {
    await fn();
    failed++;
    console.log(`  \u2717 ${message} (did not throw)`);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(substring)) {
      passed++;
      console.log(`  \u2713 ${message}`);
    } else {
      failed++;
      console.log(`  \u2717 ${message} (threw "${msg}", expected to contain "${substring}")`);
    }
  }
}

// =============================================================================
// TESTS: s3:// URL parsing
// =============================================================================

async function testS3UrlParsing(): Promise<void> {
  console.log("\n[1] s3:// URL Parsing");

  // s3://bucket/prefix
  const r1 = resolveStorageConfig({ url: "s3://my-bucket/agent-snapshots" }, false);
  assertEqual(r1.bucket, "my-bucket", "s3:// URL: bucket parsed correctly");
  assertEqual(r1.prefix, "agent-snapshots", "s3:// URL: prefix parsed correctly");
  assertEqual(r1.mode, "byok", "s3:// URL: mode is byok");
  assert(r1.endpoint === undefined, "s3:// URL: no endpoint");

  // s3://bucket/nested/prefix/
  const r2 = resolveStorageConfig({ url: "s3://my-bucket/a/b/c/" }, false);
  assertEqual(r2.bucket, "my-bucket", "s3:// nested prefix: bucket correct");
  assertEqual(r2.prefix, "a/b/c", "s3:// nested prefix: trailing slash stripped");

  // s3://bucket (no prefix)
  const r3 = resolveStorageConfig({ url: "s3://my-bucket" }, false);
  assertEqual(r3.bucket, "my-bucket", "s3:// no prefix: bucket correct");
  assertEqual(r3.prefix, "", "s3:// no prefix: empty prefix");
}

// =============================================================================
// TESTS: Virtual-hosted AWS URL
// =============================================================================

async function testVirtualHostedAws(): Promise<void> {
  console.log("\n[2] Virtual-Hosted AWS URL");

  const r1 = resolveStorageConfig(
    { url: "https://my-bucket.s3.us-west-2.amazonaws.com/evolve/checkpoints" },
    false
  );
  assertEqual(r1.bucket, "my-bucket", "Virtual-hosted: bucket extracted from subdomain");
  assertEqual(r1.prefix, "evolve/checkpoints", "Virtual-hosted: prefix from path");
  assert(r1.endpoint === undefined, "Virtual-hosted: no custom endpoint");

  // No prefix
  const r2 = resolveStorageConfig(
    { url: "https://other-bucket.s3.eu-central-1.amazonaws.com/" },
    false
  );
  assertEqual(r2.bucket, "other-bucket", "Virtual-hosted no prefix: bucket correct");
  assertEqual(r2.prefix, "", "Virtual-hosted no prefix: empty prefix");
}

// =============================================================================
// TESTS: R2 (Cloudflare) path-style URL
// =============================================================================

async function testR2PathStyle(): Promise<void> {
  console.log("\n[3] R2 Path-Style URL");

  const r1 = resolveStorageConfig(
    { url: "https://abc123.r2.cloudflarestorage.com/my-bucket/prefix" },
    false
  );
  assertEqual(r1.bucket, "my-bucket", "R2: bucket from first path segment");
  assertEqual(r1.prefix, "prefix", "R2: prefix from remaining path");
  assertEqual(r1.endpoint, "https://abc123.r2.cloudflarestorage.com", "R2: endpoint extracted");
  assertEqual(r1.mode, "byok", "R2: mode is byok");
}

// =============================================================================
// TESTS: MinIO / custom endpoint
// =============================================================================

async function testMinioPathStyle(): Promise<void> {
  console.log("\n[4] MinIO / Custom Endpoint");

  const r1 = resolveStorageConfig(
    { url: "https://minio.internal:9000/evolve-data/snapshots" },
    false
  );
  assertEqual(r1.bucket, "evolve-data", "MinIO: bucket from first path segment");
  assertEqual(r1.prefix, "snapshots", "MinIO: prefix from remaining path");
  assertEqual(r1.endpoint, "https://minio.internal:9000", "MinIO: endpoint includes port");

  // localhost:9000 (common MinIO dev setup)
  const r2 = resolveStorageConfig(
    { url: "https://localhost:9000/mybucket/prefix" },
    false
  );
  assertEqual(r2.bucket, "mybucket", "localhost MinIO: bucket correct");
  assertEqual(r2.prefix, "prefix", "localhost MinIO: prefix correct");
  assertEqual(r2.endpoint, "https://localhost:9000", "localhost MinIO: endpoint correct");
}

// =============================================================================
// TESTS: Gateway mode
// =============================================================================

async function testGatewayMode(): Promise<void> {
  console.log("\n[5] Gateway Mode");

  // Empty config with isGateway=true
  const r1 = resolveStorageConfig({}, true, "https://dashboard.example.com", "gw-key-123");
  assertEqual(r1.mode, "gateway", "Gateway: mode is gateway");
  assertEqual(r1.gatewayUrl, "https://dashboard.example.com", "Gateway: URL passed through");
  assertEqual(r1.gatewayApiKey, "gw-key-123", "Gateway: API key passed through");

  // undefined config with isGateway=true
  const r2 = resolveStorageConfig(undefined, true, "https://dash.io", "key");
  assertEqual(r2.mode, "gateway", "Gateway undefined config: mode is gateway");
}

// =============================================================================
// TESTS: Region handling
// =============================================================================

async function testRegionHandling(): Promise<void> {
  console.log("\n[6] Region Handling");

  // Explicit region
  const r1 = resolveStorageConfig(
    { url: "s3://bucket/prefix", region: "eu-west-1" },
    false
  );
  assertEqual(r1.region, "eu-west-1", "Explicit region used");

  // Default region (no AWS_REGION env)
  const origRegion = process.env.AWS_REGION;
  delete process.env.AWS_REGION;
  const r2 = resolveStorageConfig({ url: "s3://bucket/prefix" }, false);
  assertEqual(r2.region, "us-east-1", "Default region is us-east-1");

  // Restore
  if (origRegion !== undefined) process.env.AWS_REGION = origRegion;
}

// =============================================================================
// TESTS: Explicit overrides
// =============================================================================

async function testExplicitOverrides(): Promise<void> {
  console.log("\n[7] Explicit Overrides");

  // Explicit bucket overrides URL-parsed bucket
  const r1 = resolveStorageConfig(
    { url: "s3://url-bucket/url-prefix", bucket: "explicit-bucket" },
    false
  );
  assertEqual(r1.bucket, "explicit-bucket", "Explicit bucket overrides URL bucket");
  assertEqual(r1.prefix, "url-prefix", "URL prefix still used when bucket overridden");

  // Explicit prefix overrides URL-parsed prefix
  const r2 = resolveStorageConfig(
    { url: "s3://my-bucket/url-prefix", prefix: "explicit-prefix" },
    false
  );
  assertEqual(r2.prefix, "explicit-prefix", "Explicit prefix overrides URL prefix");

  // Explicit config, no URL at all: { bucket, prefix, region }
  const explicit = resolveStorageConfig(
    { bucket: "b", prefix: "p", region: "eu-west-1" },
    false
  );
  assertEqual(explicit.bucket, "b", "Explicit config no URL: bucket");
  assertEqual(explicit.prefix, "p", "Explicit config no URL: prefix");
  assertEqual(explicit.region, "eu-west-1", "Explicit config no URL: region");
  assertEqual(explicit.mode, "byok", "Explicit config no URL: mode is byok");

  // Explicit credentials
  const r3 = resolveStorageConfig(
    {
      url: "s3://bucket/prefix",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
    },
    false
  );
  assertEqual(r3.credentials?.accessKeyId, "AKID", "Credentials passed through");
  assertEqual(r3.credentials?.secretAccessKey, "SECRET", "Secret key passed through");
}

// =============================================================================
// TESTS: Error cases
// =============================================================================

async function testErrorCases(): Promise<void> {
  console.log("\n[8] Error Cases");

  // No URL + isGateway=false → throws
  await assertThrows(
    () => resolveStorageConfig({}, false),
    "Storage requires either a URL",
    "No URL + not gateway throws"
  );

  // https:// URL with no path → throws (no bucket in path)
  await assertThrows(
    () => resolveStorageConfig({ url: "https://example.com" }, false),
    "no bucket in path",
    "HTTPS with no path throws"
  );

  // Bucket-only config (no URL) works
  const r1 = resolveStorageConfig({ bucket: "direct-bucket" }, false);
  assertEqual(r1.bucket, "direct-bucket", "Bucket-only config works");
  assertEqual(r1.mode, "byok", "Bucket-only config is byok mode");
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Storage Config Resolution Unit Tests");
  console.log("=".repeat(60));

  await testS3UrlParsing();
  await testVirtualHostedAws();
  await testR2PathStyle();
  await testMinioPathStyle();
  await testGatewayMode();
  await testRegionHandling();
  await testExplicitOverrides();
  await testErrorCases();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
