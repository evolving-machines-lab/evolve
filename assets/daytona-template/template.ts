import { Image } from '@daytonaio/sdk'

// =============================================================================
// Evolve Daytona Snapshot
// =============================================================================
// Single snapshot with all AI coding CLIs and skills pre-installed.
//
// Includes:
//   - Claude Code (@anthropic-ai/claude-code)
//   - Codex (@openai/codex)
//   - Gemini CLI (@google/gemini-cli) + Nano Banana extension
//   - Qwen Code (@qwen-code/qwen-code)
//   - ACP adapters for Claude and Codex
//   - Google Chrome for browser automation
//   - Skills cloned from github.com/evolving-machines-lab/evolve
//
// To rebuild: npm run build (or ./build.sh)
// =============================================================================

export const image = Image.base('ubuntu:22.04')

  // ---------------------------------------------------------------------------
  // System packages
  // ---------------------------------------------------------------------------
  .runCommands(
    // Core utilities
    'apt-get update && apt-get install -y curl git ripgrep wget gnupg',
    // Node.js 20.x
    'curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs',
    // Google Chrome
    'wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome-keyring.gpg && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && apt-get update && apt-get install -y google-chrome-stable',
    // UV + Python 3.12
    'curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh && uv python install 3.12 && ln -s $(uv python find 3.12) /usr/local/bin/python3 && ln -s /usr/local/bin/python3 /usr/local/bin/python',
    // Cleanup
    'rm -rf /var/lib/apt/lists/*'
  )

  // ---------------------------------------------------------------------------
  // Verify installations
  // ---------------------------------------------------------------------------
  .runCommands('node -v && npm -v && python3 --version && git --version && google-chrome --version')

  // ---------------------------------------------------------------------------
  // AI Coding CLIs (global npm packages)
  // ---------------------------------------------------------------------------
  .runCommands(
    'npm install -g @anthropic-ai/claude-code@latest @zed-industries/claude-code-acp@latest @openai/codex @zed-industries/codex-acp@latest @google/gemini-cli@latest @qwen-code/qwen-code@latest'
  )

  // ---------------------------------------------------------------------------
  // MCP Tools (HTTP-to-STDIO bridge for remote MCP servers)
  // ---------------------------------------------------------------------------
  .runCommands('npm install -g mcp-remote')

  // ---------------------------------------------------------------------------
  // Agent Browser CLI (headless browser automation for AI agents)
  // ---------------------------------------------------------------------------
  .runCommands('npm install -g agent-browser')

  // ---------------------------------------------------------------------------
  // User setup
  // ---------------------------------------------------------------------------
  .runCommands(
    // Create user
    'groupadd -r user && useradd -r -g user -m -s /bin/bash user',
    // Create skills directories for all CLIs
    'mkdir -p /home/user/.evolve/skills /home/user/.claude/skills /home/user/.codex/skills /home/user/.gemini/skills /home/user/.qwen/skills',
    // Set ownership
    'chown -R user:user /home/user'
  )

  // ---------------------------------------------------------------------------
  // Working directory
  // ---------------------------------------------------------------------------
  .workdir('/home/user')

  // ---------------------------------------------------------------------------
  // Skills
  // ---------------------------------------------------------------------------
  // Clone skills from evolve repo (sparse checkout for skills/ only)
  .runCommands(
    'git clone --depth 1 --filter=blob:none --sparse https://github.com/evolving-machines-lab/evolve.git /tmp/evolve && cd /tmp/evolve && git sparse-checkout set skills && mv skills/* /home/user/.evolve/skills/ && rm -rf /tmp/evolve && chown -R user:user /home/user/.evolve'
  )

  // ---------------------------------------------------------------------------
  // Gemini settings (enable experimental skills)
  // ---------------------------------------------------------------------------
  .runCommands(
    'echo \'{"experimental":{"skills":true}}\' > /home/user/.gemini/settings.json && chown user:user /home/user/.gemini/settings.json'
  )

  // ---------------------------------------------------------------------------
  // Gemini Extensions (Nano Banana for image generation)
  // ---------------------------------------------------------------------------
  .runCommands('echo y | gemini extensions install https://github.com/gemini-cli-extensions/nanobanana || true')

  // ---------------------------------------------------------------------------
  // Browser Automation (Playwright)
  // ---------------------------------------------------------------------------
  .runCommands('npx playwright install chromium')

  // ---------------------------------------------------------------------------
  // Default command
  // ---------------------------------------------------------------------------
  .cmd(['/bin/bash'])
