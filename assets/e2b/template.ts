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
//   - Z Code (from the official .deb, on its own Node 24)
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
  // Kimi Code
  // ---------------------------------------------------------------------------
  .runCmd('curl -fsSL https://code.kimi.com/kimi-code/install.sh | KIMI_INSTALL_DIR=/home/user/.kimi-code KIMI_NO_MODIFY_PATH=1 bash && ln -sf /home/user/.kimi-code/bin/kimi /usr/local/bin/kimi && kimi --version && chown -R user:user /home/user/.kimi-code')

  // ---------------------------------------------------------------------------
  // Z Code (zai-org/ZCode)
  // ---------------------------------------------------------------------------
  // The official Linux .deb (version + sha512 pinned) on its own Node 24 under
  // /opt/zcode; the env below names the catalog and the search binaries the CLI
  // reads from env. Mirrors the Dockerfile block step for step.
  .runCmd(`set -eu
    && ZCODE_VERSION=3.14.3
    && ZCODE_DEB_SHA512=54362bc8bf5b2188ccdeec51349f2c470e52e73f4b06646fbd6d5a990f7012784904c7374656f683c26fc56bf4e023e7d0680a1c42446665a62d9b88e84620d6
    && ZCODE_NODE_VERSION=24.21.0
    && ZCODE_NODE_SHA256=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
    && cd /tmp
    && curl -fsSL -o zcode.deb "https://cdn-zcode.z.ai/zcode/electron/releases/\${ZCODE_VERSION}/linux-x64/ZCode-\${ZCODE_VERSION}-linux-x64.deb"
    && echo "\${ZCODE_DEB_SHA512}  zcode.deb" | sha512sum -c -
    && mkdir -p zcode-deb /opt/zcode
    && dpkg-deb -x zcode.deb zcode-deb
    && mv zcode-deb/opt/ZCode/resources/glm /opt/zcode/glm
    && mv zcode-deb/opt/ZCode/resources/tools /opt/zcode/tools
    && mkdir -p /opt/zcode/glm/provider
    && cp zcode-deb/opt/ZCode/resources/config/provider/zcode-builtin.json /opt/zcode/glm/provider/zcode-builtin.json
    && dpkg-deb -f zcode.deb Version > /opt/zcode/VERSION
    && curl -fsSL -o node.tgz "https://nodejs.org/dist/v\${ZCODE_NODE_VERSION}/node-v\${ZCODE_NODE_VERSION}-linux-x64.tar.gz"
    && echo "\${ZCODE_NODE_SHA256}  node.tgz" | sha256sum -c -
    && mkdir -p /opt/zcode/node
    && tar -xzf node.tgz -C /opt/zcode/node --strip-components=1
    && printf '#!/bin/sh\\nexec /opt/zcode/node/bin/node /opt/zcode/glm/zcode.cjs "$@"\\n' > /usr/local/bin/zcode
    && chmod +x /usr/local/bin/zcode
    && rm -rf zcode.deb zcode-deb node.tgz
    && zcode --version
  `.replace(/\n\s+/g, ' ').trim())
  .setEnvs({
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/opt/zcode/glm/provider/zcode-builtin.json',
    ZCODE_BFS_BINARY: '/opt/zcode/tools/bfs/bfs',
    ZCODE_RG_BINARY: '/opt/zcode/tools/ripgrep/rg',
    ZCODE_UGREP_BINARY: '/opt/zcode/tools/ugrep/ugrep',
  })

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
  .runCmd('mkdir -p ~/.claude/skills ~/.codex/skills ~/.gemini/skills ~/.qwen/skills ~/.kimi-code/skills ~/.agents/skills ~/.factory/skills ~/.zcode/skills')

  // ---------------------------------------------------------------------------
  // Factory Droid CLI
  // ---------------------------------------------------------------------------
  .runCmd('curl -fsSL https://app.factory.ai/cli | sh')

  // Make Droid available to non-login shell commands.
  .setUser('root')
  .runCmd('ln -sf /home/user/.local/bin/droid /usr/local/bin/droid && chown -R user:user /home/user/.factory /home/user/.local')
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
