import { Template } from 'e2b'

// =============================================================================
// Evolve E2B Template
// =============================================================================
// Single template with all AI coding CLIs and skills pre-installed.
//
// Includes:
//   - Claude Code (@anthropic-ai/claude-code)
//   - Codex (@openai/codex)
//   - Gemini CLI (@google/gemini-cli) + Nano Banana extension
//   - Qwen Code (@qwen-code/qwen-code)
//   - ACP adapters for Claude and Codex
//   - Google Chrome for browser automation
//   - Skills cloned from github.com/evolvingmachines/evolve
//
// To rebuild: npm run build (or ./build.sh)
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
  .runCmd('apt-get update && apt-get install -y curl git ripgrep wget gnupg && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome-keyring.gpg && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && apt-get update && apt-get install -y google-chrome-stable && rm -rf /var/lib/apt/lists/*')

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
  `.replace(/\n\s+/g, ' ').trim())

  // ---------------------------------------------------------------------------
  // MCP Tools (HTTP-to-STDIO bridge for remote MCP servers)
  // ---------------------------------------------------------------------------
  .runCmd('npm install -g mcp-remote')

  // ---------------------------------------------------------------------------
  // User setup
  // ---------------------------------------------------------------------------
  .setUser('user')
  .setWorkdir('/home/user')

  // Create skills directories for all CLIs
  .runCmd('mkdir -p ~/.evolve/skills ~/.claude/skills ~/.codex/skills ~/.gemini/skills ~/.qwen/skills')

  // ---------------------------------------------------------------------------
  // Skills
  // ---------------------------------------------------------------------------
  // Clone skills from evolve OSS repo (sparse checkout for skills/ only)
  .runCmd('git clone --depth 1 --filter=blob:none --sparse https://github.com/evolvingmachines/evolve.git /tmp/evolve && cd /tmp/evolve && git sparse-checkout set skills && mv skills/* ~/.evolve/skills/ && rm -rf /tmp/evolve')

  // Enable Gemini experimental skills
  .runCmd('echo \'{"experimental":{"skills":true}}\' > ~/.gemini/settings.json')

  // ---------------------------------------------------------------------------
  // Gemini Extensions (Nano Banana for image generation)
  // ---------------------------------------------------------------------------
  .runCmd('echo y | gemini extensions install https://github.com/gemini-cli-extensions/nanobanana')

  // ---------------------------------------------------------------------------
  // Browser Automation (Playwright)
  // ---------------------------------------------------------------------------
  .runCmd('npx playwright install chromium')
