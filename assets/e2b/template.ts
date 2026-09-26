import { Template } from 'e2b'

// =============================================================================
// Evolve E2B Template
// =============================================================================
// Single template with all AI coding CLIs pre-installed.
//
// Includes:
//   - Claude Code (@anthropic-ai/claude-code)
//   - Codex (@openai/codex)
//   - Gemini CLI (@google/gemini-cli) + Nano Banana extension
//   - Qwen Code (@qwen-code/qwen-code)
//   - OpenCode (opencode-ai)
//   - Droid CLI
//   - Kimi Code
//   - pi (@earendil-works/pi-coding-agent + pi-mcp-adapter) and Prime Agent (+ its Python kernel)
//   - ACP adapters for Claude and Codex
//   - Google Chrome for browser automation
//   - Skills cloned from github.com/evolving-machines-lab/evolve
//
// To rebuild: cd assets && ./build.sh e2b
// =============================================================================

export const template = Template()

  // ---------------------------------------------------------------------------
  // Base image
  // ---------------------------------------------------------------------------
  .fromImage('e2bdev/code-interpreter:latest')

  // ---------------------------------------------------------------------------
  // System packages (as root)
  // ---------------------------------------------------------------------------
  .setUser('root')
  .setWorkdir('/')

  // Core utilities + Google Chrome (single layer)
  // Remove NodeSource repo (SHA1 key deprecated since 2026-02-01)
  .runCmd('rm -f /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true && apt-get update && apt-get install -y curl git ripgrep wget gnupg && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome-keyring.gpg && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && apt-get update && apt-get install -y google-chrome-stable && rm -rf /var/lib/apt/lists/*')

  // UV package manager for Python
  .runCmd('curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh')

  // Verify installations
  .runCmd('node -v && npm -v && git --version && google-chrome --version')

  // ---------------------------------------------------------------------------
  // AI Coding CLIs (global npm packages)
  // ---------------------------------------------------------------------------
  .runCmd(`npm install -g
    @anthropic-ai/claude-code@latest
    @zed-industries/claude-code-acp@latest
    @openai/codex
    @zed-industries/codex-acp@latest
    @google/gemini-cli@latest
    @qwen-code/qwen-code@latest
    opencode-ai@latest
  `.replace(/\n\s+/g, ' ').trim())

  // ---------------------------------------------------------------------------
  // Node 22 for the pi family (the base ships Node 20; pi needs >= 22.19,
  // Prime >= 22.8): the hosted bundle's pinned tarball and sha256, reached
  // only through the two launcher shims below. Mirrors the Dockerfile block.
  // ---------------------------------------------------------------------------
  .runCmd('set -eu; cd /tmp && curl -fsSL -o node22.tgz https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.gz && echo "7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129  node22.tgz" | sha256sum -c - && mkdir -p /opt/evolve/node22 && tar -xzf node22.tgz -C /opt/evolve/node22 --strip-components=1 && rm node22.tgz && /opt/evolve/node22/bin/node -v')

  // ---------------------------------------------------------------------------
  // pi 0.87.1 (own prefix, Node 22) + pi-mcp-adapter 2.37.0 (pinned, own
  // prefix, scripts and peers skipped; the SDK loads it with --extension from
  // registry.ts PI_MCP_ADAPTER_EXTENSION). The `pi` launcher runs Node 22.
  // ---------------------------------------------------------------------------
  .runCmd('set -eu && /opt/evolve/node22/bin/npm install -g --prefix /opt/evolve/pi --no-audit --no-fund @earendil-works/pi-coding-agent@0.87.1 && mkdir -p /opt/evolve/pi-mcp-adapter && /opt/evolve/node22/bin/npm install --prefix /opt/evolve/pi-mcp-adapter --ignore-scripts --legacy-peer-deps --no-audit --no-fund pi-mcp-adapter@2.37.0 && test -f /opt/evolve/pi-mcp-adapter/node_modules/pi-mcp-adapter/index.ts && printf \'%s\\n\' \'#!/bin/sh\' \'exec /opt/evolve/node22/bin/node /opt/evolve/pi/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js "$@"\' > /usr/local/bin/pi && chmod +x /usr/local/bin/pi && test "$(pi --version)" = "0.87.1"')

  // ---------------------------------------------------------------------------
  // Kimi Code
  // ---------------------------------------------------------------------------
  .runCmd('curl -fsSL https://code.kimi.com/kimi-code/install.sh | KIMI_INSTALL_DIR=/home/user/.kimi-code KIMI_NO_MODIFY_PATH=1 bash && ln -sf /home/user/.kimi-code/bin/kimi /usr/local/bin/kimi && kimi --version && chown -R user:user /home/user/.kimi-code')

  // ---------------------------------------------------------------------------
  // MCP Tools (HTTP-to-STDIO bridge for remote MCP servers)
  // ---------------------------------------------------------------------------
  .runCmd('npm install -g mcp-remote')

  // ---------------------------------------------------------------------------
  // Agent Browser CLI (headless browser automation for AI agents)
  // ---------------------------------------------------------------------------
  .runCmd('npm install -g agent-browser @actionbookdev/cli')

  // TEMPORARY ACTIONBOOK DAEMON WORKAROUND.
  // Remove this runCmd and the matching Dockerfile block only after
  // @actionbookdev/cli includes actionbook/actionbook#611.
  .runCmd('REAL_ACTIONBOOK="$(command -v actionbook)" && mkdir -p /home/user/.local/bin && printf \'%s\\n\' \'#!/usr/bin/env bash\' \'set -euo pipefail\' "REAL_ACTIONBOOK=\\"$REAL_ACTIONBOOK\\"" \'if [[ "${1:-}" == "browser" && "${2:-}" == "start" ]]; then exec /usr/bin/setsid "$REAL_ACTIONBOOK" "$@"; fi\' \'exec "$REAL_ACTIONBOOK" "$@"\' > /home/user/.local/bin/actionbook && chmod +x /home/user/.local/bin/actionbook && chown -R user:user /home/user/.local')

  // ---------------------------------------------------------------------------
  // User setup
  // ---------------------------------------------------------------------------
  .setUser('user')
  .setWorkdir('/home/user')

  // Create skills directories for all CLIs. No baked catalog: skills are
  // resolved at run time by the SDK resolver (packages/sdk-ts/src/skills.ts)
  // from real references and mounted into these directories.
  .runCmd('mkdir -p ~/.claude/skills ~/.codex/skills ~/.gemini/skills ~/.qwen/skills ~/.kimi-code/skills ~/.agents/skills ~/.factory/skills ~/.pi/agent/skills ~/.prime/agent/skills')

  // ---------------------------------------------------------------------------
  // Factory Droid CLI
  // ---------------------------------------------------------------------------
  .runCmd('curl -fsSL https://app.factory.ai/cli | sh')

  // Make Droid available to non-login shell commands.
  .setUser('root')
  .runCmd('ln -sf /home/user/.local/bin/droid /usr/local/bin/droid && chown -R user:user /home/user/.factory /home/user/.local && mkdir -p /opt/evolve/prime-agent && chown user:user /opt/evolve/prime-agent')
  .setUser('user')

  // ---------------------------------------------------------------------------
  // Prime Agent v0.9.6 (release tarballs, sha256-verified against the
  // release's SHA256SUMS; internal packages pinned via npm overrides; kernel
  // baked at install as `user` so the venv lands in this home). Mirrors the
  // Dockerfile block, which carries the reasoning.
  // ---------------------------------------------------------------------------
  .runCmd([
    'set -eu; V=0.9.6; cd /opt/evolve/prime-agent',
    'for f in prime-agent-$V.tgz prime-agent-ai-$V.tgz prime-agent-core-$V.tgz prime-agent-tui-$V.tgz; do curl -fsSL -o "$f" "https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v$V/$f"; done',
    'printf \'%s\\n\' "e5bf0e349e55b3f75c79e66006c993b10c51ed1c9bf15863b06658fcaf0232b2  prime-agent-$V.tgz" "26f2a9ce723b06a000b50619c4873c10fd2692439d65f7430a234ad31216f465  prime-agent-ai-$V.tgz" "e79c23d2e9b38d168806cd5f3eee643fcadab7f6361cf8e7a2d2e90d00f209d0  prime-agent-core-$V.tgz" "0a28ef155beb9357c5e0f5848d0f6110dbdd2bff8346a0befba5b209e189c0f2  prime-agent-tui-$V.tgz" | sha256sum -c -',
    'printf \'%s\\n\' "{\\"private\\":true,\\"dependencies\\":{\\"prime-agent\\":\\"file:./prime-agent-$V.tgz\\"},\\"overrides\\":{\\"@earendil-works/pi-ai\\":\\"file:./prime-agent-ai-$V.tgz\\",\\"@earendil-works/pi-agent-core\\":\\"file:./prime-agent-core-$V.tgz\\",\\"@earendil-works/pi-tui\\":\\"file:./prime-agent-tui-$V.tgz\\"}}" > package.json',
    'PATH=/opt/evolve/node22/bin:$PATH PRIME_AGENT_TELEMETRY=0 PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1 npm install --no-audit --no-fund',
    'test -f /home/user/.prime/agent/kernel-venv/.bootstrap-version',
    'rm -rf /home/user/.cache/uv',
  ].join(' && '))

  // The launcher runs Prime with the Node 22 runtime, PATH untouched for its children.
  .setUser('root')
  .runCmd('printf \'%s\\n\' \'#!/bin/sh\' \'exec /opt/evolve/node22/bin/node /opt/evolve/prime-agent/node_modules/prime-agent/dist/cli.js "$@"\' > /usr/local/bin/prime-agent && chmod +x /usr/local/bin/prime-agent && test "$(prime-agent --version)" = "0.9.6"')
  .setUser('user')

  // ---------------------------------------------------------------------------
  // Gemini Extensions (Nano Banana for image generation)
  // ---------------------------------------------------------------------------
  // Best-effort: newer Gemini CLI builds can prompt for an API key here.
  .runCmd('timeout 30s sh -c \'printf "y\\ny\\n\\n" | gemini extensions install https://github.com/gemini-cli-extensions/nanobanana\' || true')

  // ---------------------------------------------------------------------------
  // Browser Automation (Playwright)
  // ---------------------------------------------------------------------------
  .runCmd('npx playwright install chromium')
