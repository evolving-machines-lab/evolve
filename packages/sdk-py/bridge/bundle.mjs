#!/usr/bin/env node
/**
 * Bundle the bridge with all dependencies for PyPI distribution.
 *
 * This creates a standalone bridge.js that includes @evolve/sdk and @evolve/e2b,
 * so users installing from pip don't need those packages to exist.
 */

import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['dist/bridge.js'],
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/bridge.bundle.cjs',
  banner: {
    js: `#!/usr/bin/env node
/**
 * Evolve Python Bridge
 * Copyright (c) 2025 Swarmlink, Inc. All rights reserved.
 *
 * PROPRIETARY AND CONFIDENTIAL
 * This software is licensed under proprietary terms.
 * See LICENSE file for full terms and conditions.
 *
 * Unauthorized copying, modification, distribution, or use is strictly prohibited.
 */
// Node v24+ compatibility: provide __filename-based URL for CJS context
var __bundleUrl = require("url").pathToFileURL(__filename).href;
`,
  },
  define: {
    'import.meta.url': '__bundleUrl',
  },
  external: [],  // Bundle everything except Node.js builtins (auto-detected)
  mainFields: ['main'],  // Use CJS version (index.cjs) instead of ESM chunks
});

console.log('✓ Created standalone bundle: dist/bridge.bundle.cjs');
