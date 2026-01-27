#!/usr/bin/env tsx
/**
 * Quick OAuth File Verification (no sandbox needed)
 *
 * Verifies that OAuth file resolution works correctly by checking files
 * and creating Evolve instances.
 */

import { Evolve } from "../../dist/index.js";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";

console.log("=== Quick OAuth File Verification ===\n");

// Test Codex
const codexPath = `${homedir()}/.codex/auth.json`;
console.log(`Codex auth file: ${codexPath}`);
console.log(`  Exists: ${existsSync(codexPath)}`);

if (existsSync(codexPath)) {
  try {
    const evolve = new Evolve()
      .withAgent({
        type: "codex",
        oauthFile: "~/.codex/auth.json",
        model: "gpt-5.2",
      });
    console.log(`  ✓ Evolve instance created successfully with oauthFile`);

    // Check file content is valid JSON
    const content = readFileSync(codexPath, "utf-8");
    const parsed = JSON.parse(content);
    console.log(`  ✓ Auth file is valid JSON`);
    console.log(`    Has tokens: ${!!parsed.tokens}`);
    console.log(`    Has access_token: ${!!parsed.tokens?.access_token}`);
  } catch (e) {
    console.log(`  ✗ Error: ${e}`);
  }
}

console.log("");

// Test Gemini
const geminiPath = `${homedir()}/.gemini/oauth_creds.json`;
console.log(`Gemini auth file: ${geminiPath}`);
console.log(`  Exists: ${existsSync(geminiPath)}`);

if (existsSync(geminiPath)) {
  try {
    const evolve = new Evolve()
      .withAgent({
        type: "gemini",
        oauthFile: "~/.gemini/oauth_creds.json",
        model: "gemini-2.5-flash",
      });
    console.log(`  ✓ Evolve instance created successfully with oauthFile`);

    // Check file content is valid JSON
    const content = readFileSync(geminiPath, "utf-8");
    const parsed = JSON.parse(content);
    console.log(`  ✓ Auth file is valid JSON`);
    console.log(`    Has access_token: ${!!parsed.access_token}`);
    console.log(`    Has refresh_token: ${!!parsed.refresh_token}`);
  } catch (e) {
    console.log(`  ✗ Error: ${e}`);
  }
}

console.log("\n=== Verification Complete ===");
