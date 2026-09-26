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
//   - DeepSeek Harness (dsh, pinned @deepseek-ai/dsh@0.1.7-rc.2)
//   - Z Code (from the official .deb, on the image's Node 24)
//   - Antigravity CLI
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

  // Node 24.21.0, the image's one Node: the base image's Node 20 is below agent-browser (>= 24), pi,
  // Prime Agent and Z Code. Mirrors the Dockerfile block; sha256 from nodejs.org/dist/v24.21.0/SHASUMS256.txt.
  .runCmd('set -eu; NODE_VERSION=24.21.0; NODE_SHA256=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff; cd /tmp && curl -fsSL -o node.tgz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" && echo "${NODE_SHA256}  node.tgz" | sha256sum -c - && apt-get remove -y nodejs && tar -xzf node.tgz -C /usr/local --strip-components=1 --exclude=\'*/CHANGELOG.md\' --exclude=\'*/LICENSE\' --exclude=\'*/README.md\' && rm node.tgz && test "$(command -v node)" = /usr/local/bin/node && test "$(node -v)" = "v${NODE_VERSION}"')

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
    @earendil-works/pi-coding-agent@0.87.1
  `.replace(/\n\s+/g, ' ').trim())

  // ---------------------------------------------------------------------------
  // pi's MCP adapter (pi's core has no MCP), loaded by the SDK with --extension from this path.
  // Peers skipped: pi aliases its own packages at load time, so nothing is installed beside it.
  // ---------------------------------------------------------------------------
  .runCmd('mkdir -p /opt/evolve/pi-mcp-adapter && npm install --prefix /opt/evolve/pi-mcp-adapter --ignore-scripts --legacy-peer-deps --no-audit --no-fund pi-mcp-adapter@2.37.0 && test -f /opt/evolve/pi-mcp-adapter/node_modules/pi-mcp-adapter/index.ts && test "$(pi --version)" = "0.87.1"')

  // ---------------------------------------------------------------------------
  // Kimi Code
  // ---------------------------------------------------------------------------
  .runCmd('curl -fsSL https://code.kimi.com/kimi-code/install.sh | KIMI_INSTALL_DIR=/home/user/.kimi-code KIMI_NO_MODIFY_PATH=1 bash && ln -sf /home/user/.kimi-code/bin/kimi /usr/local/bin/kimi && kimi --version && chown -R user:user /home/user/.kimi-code')

  // ---------------------------------------------------------------------------
  // DeepSeek Harness (dsh)
  // ---------------------------------------------------------------------------
  // Pinned (see the Dockerfile's dsh block): only the `next` prerelease line has
  // the headless --json surface; optional deps stay on for the flock addon; runs on
  // the image's one Node.
  .runCmd('npm install -g @deepseek-ai/dsh@0.1.7-rc.2 && dsh --version')

  // ---------------------------------------------------------------------------
  // Z Code (zai-org/ZCode)
  // ---------------------------------------------------------------------------
  // No npm package or installer exists: the CLI is the `glm` bundle inside the official .deb (sha512 pinned),
  // unpacked under /opt/zcode. The env below names the catalog and the search binaries the CLI reads from env.
  .runCmd(`set -eu
    && ZCODE_VERSION=3.14.3
    && ZCODE_DEB_SHA512=54362bc8bf5b2188ccdeec51349f2c470e52e73f4b06646fbd6d5a990f7012784904c7374656f683c26fc56bf4e023e7d0680a1c42446665a62d9b88e84620d6
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
    && printf '#!/bin/sh\\nexec node /opt/zcode/glm/zcode.cjs "$@"\\n' > /usr/local/bin/zcode
    && chmod +x /usr/local/bin/zcode
    && rm -rf zcode.deb zcode-deb
    && zcode --version
  `.replace(/\n\s+/g, ' ').trim())
  .setEnvs({
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/opt/zcode/glm/provider/zcode-builtin.json',
    ZCODE_BFS_BINARY: '/opt/zcode/tools/bfs/bfs',
    ZCODE_RG_BINARY: '/opt/zcode/tools/ripgrep/rg',
    ZCODE_UGREP_BINARY: '/opt/zcode/tools/ugrep/ugrep',
  })

  // ---------------------------------------------------------------------------
  // Antigravity CLI (Google): the vendor's manifest-named release tarball, sha512-verified, on PATH as `antigravity`.
  // Never `agy install`: it edits shell profiles and arms the background auto-updater.
  // ---------------------------------------------------------------------------
  .runCmd('curl -fsSL -o /tmp/antigravity-cli.tgz https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.11-6016716732497920/linux-x64/cli_linux_x64.tar.gz && echo "ca12c262343f29a2b87423d1ff1e4244989e936e37fe1f8e56056b0f91cd02f93f133321229ce35c86c2d84b977e919937a3fd9430cfd769a16d6b03ede25081  /tmp/antigravity-cli.tgz" | sha512sum -c - && tar -xzf /tmp/antigravity-cli.tgz -C /usr/local/bin antigravity && chmod 0755 /usr/local/bin/antigravity && rm -f /tmp/antigravity-cli.tgz && AGY_CLI_DISABLE_AUTO_UPDATE=true antigravity --version')

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
  .runCmd('mkdir -p ~/.claude/skills ~/.codex/skills ~/.gemini/skills ~/.qwen/skills ~/.kimi-code/skills ~/.agents/skills ~/.factory/skills ~/.pi/agent/skills ~/.prime/agent/skills ~/.dsh/skills ~/.zcode/skills ~/.gemini/config/skills')

  // ---------------------------------------------------------------------------
  // Factory Droid CLI
  // ---------------------------------------------------------------------------
  .runCmd('curl -fsSL https://app.factory.ai/cli | sh')

  // Make Droid available to non-login shell commands.
  .setUser('root')
  .runCmd('ln -sf /home/user/.local/bin/droid /usr/local/bin/droid && chown -R user:user /home/user/.factory /home/user/.local && mkdir -p /opt/evolve/prime-agent && chown user:user /opt/evolve/prime-agent')
  .setUser('user')

  // ---------------------------------------------------------------------------
  // Prime Agent v0.9.6, not on npm: tarballs verified against the release's SHA256SUMS, internal packages
  // pinned with npm overrides, installed as `user` so the kernel venv lands in this home. Mirrors the Dockerfile.
  // ---------------------------------------------------------------------------
  .runCmd([
    'set -eu; V=0.9.6; cd /opt/evolve/prime-agent',
    'for f in prime-agent-$V.tgz prime-agent-ai-$V.tgz prime-agent-core-$V.tgz prime-agent-tui-$V.tgz; do curl -fsSL -o "$f" "https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v$V/$f"; done',
    'printf \'%s\\n\' "e5bf0e349e55b3f75c79e66006c993b10c51ed1c9bf15863b06658fcaf0232b2  prime-agent-$V.tgz" "26f2a9ce723b06a000b50619c4873c10fd2692439d65f7430a234ad31216f465  prime-agent-ai-$V.tgz" "e79c23d2e9b38d168806cd5f3eee643fcadab7f6361cf8e7a2d2e90d00f209d0  prime-agent-core-$V.tgz" "0a28ef155beb9357c5e0f5848d0f6110dbdd2bff8346a0befba5b209e189c0f2  prime-agent-tui-$V.tgz" | sha256sum -c -',
    'printf \'%s\\n\' "{\\"private\\":true,\\"dependencies\\":{\\"prime-agent\\":\\"file:./prime-agent-$V.tgz\\"},\\"overrides\\":{\\"@earendil-works/pi-ai\\":\\"file:./prime-agent-ai-$V.tgz\\",\\"@earendil-works/pi-agent-core\\":\\"file:./prime-agent-core-$V.tgz\\",\\"@earendil-works/pi-tui\\":\\"file:./prime-agent-tui-$V.tgz\\"}}" > package.json',
    'PRIME_AGENT_TELEMETRY=0 PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1 npm install --no-audit --no-fund',
    'test -f /home/user/.prime/agent/kernel-venv/.bootstrap-version',
    // Prime's built-in Python skills into the same venv (a session would sync them with uv at its first cell).
    'uv pip install --python /home/user/.prime/agent/kernel-venv/bin/python $(for d in /opt/evolve/prime-agent/node_modules/prime-agent/dist/skills/*/; do [ -f "$d/pyproject.toml" ] && printf \' --editable %s\' "$d"; done)',
    'for d in /opt/evolve/prime-agent/node_modules/prime-agent/dist/skills/*/; do [ -f "$d/pyproject.toml" ] || continue; /home/user/.prime/agent/kernel-venv/bin/python -c "import $(basename "$d" | tr - _)" || exit 1; done',
    'rm -rf /home/user/.cache/uv',
  ].join(' && '))

  .setUser('root')
  .runCmd('ln -sf /opt/evolve/prime-agent/node_modules/.bin/prime-agent /usr/local/bin/prime-agent && test "$(prime-agent --version)" = "0.9.6"')
  .setUser('user')
  // The baked kernel's interpreter: with it set, Prime runs no bootstrap and no skill sync.
  .setEnvs({ PRIME_AGENT_KERNEL_PYTHON: '/home/user/.prime/agent/kernel-venv/bin/python' })

  // ---------------------------------------------------------------------------
  // Gemini Extensions (Nano Banana for image generation)
  // ---------------------------------------------------------------------------
  // Best-effort: newer Gemini CLI builds can prompt for an API key here.
  .runCmd('timeout 30s sh -c \'printf "y\\ny\\n\\n" | gemini extensions install https://github.com/gemini-cli-extensions/nanobanana\' || true')

  // ---------------------------------------------------------------------------
  // Browser Automation (Playwright)
  // ---------------------------------------------------------------------------
  .runCmd('npx playwright install chromium')
