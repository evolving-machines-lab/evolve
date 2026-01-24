# =============================================================================
# Evolve All-in-One Sandbox Image
# =============================================================================
# Single image with all AI coding CLIs and skills pre-installed.
#
# Includes:
#   - Claude Code (@anthropic-ai/claude-code)
#   - Codex (@openai/codex)
#   - Gemini CLI (@google/gemini-cli) + Nano Banana extension
#   - Qwen Code (@qwen-code/qwen-code)
#   - ACP adapters for Claude and Codex
#   - Google Chrome for browser automation
#   - Skills cloned from github.com/evolving-machines-lab/evolve
#
# Build: docker build --platform=linux/amd64 -t evolvingmachines/evolve-all:latest .
# Push:  docker push evolvingmachines/evolve-all:latest
# =============================================================================

FROM python:3.12-slim-bookworm

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# System packages
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ripgrep \
    wget \
    gnupg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Node.js 20.x
# ---------------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Google Chrome (for browser automation)
# ---------------------------------------------------------------------------
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Verify installations
# ---------------------------------------------------------------------------
RUN node -v && npm -v && python3 --version && git --version && google-chrome --version

# ---------------------------------------------------------------------------
# AI Coding CLIs (global npm packages)
# ---------------------------------------------------------------------------
RUN npm install -g \
    @anthropic-ai/claude-code@latest \
    @zed-industries/claude-code-acp@latest \
    @openai/codex \
    @zed-industries/codex-acp@latest \
    @google/gemini-cli@latest \
    @qwen-code/qwen-code@latest

# ---------------------------------------------------------------------------
# MCP Tools (HTTP-to-STDIO bridge for remote MCP servers)
# ---------------------------------------------------------------------------
RUN npm install -g mcp-remote

# ---------------------------------------------------------------------------
# Agent Browser CLI (headless browser automation for AI agents)
# ---------------------------------------------------------------------------
RUN npm install -g agent-browser

# ---------------------------------------------------------------------------
# User setup
# ---------------------------------------------------------------------------
RUN groupadd -r user && useradd -r -g user -m -s /bin/bash user \
    && mkdir -p /home/user/.evolve/skills \
                /home/user/.claude/skills \
                /home/user/.codex/skills \
                /home/user/.gemini/skills \
                /home/user/.qwen/skills \
    && chown -R user:user /home/user

# ---------------------------------------------------------------------------
# Working directory
# ---------------------------------------------------------------------------
WORKDIR /home/user

# ---------------------------------------------------------------------------
# Skills (clone from evolve repo - sparse checkout for skills/ only)
# ---------------------------------------------------------------------------
RUN git clone --depth 1 --filter=blob:none --sparse https://github.com/evolving-machines-lab/evolve.git /tmp/evolve \
    && cd /tmp/evolve \
    && git sparse-checkout set skills \
    && mv skills/* /home/user/.evolve/skills/ \
    && rm -rf /tmp/evolve \
    && chown -R user:user /home/user/.evolve

# ---------------------------------------------------------------------------
# Gemini settings (enable experimental skills)
# ---------------------------------------------------------------------------
RUN echo '{"experimental":{"skills":true}}' > /home/user/.gemini/settings.json \
    && chown user:user /home/user/.gemini/settings.json

# ---------------------------------------------------------------------------
# Gemini Extensions (Nano Banana for image generation)
# ---------------------------------------------------------------------------
RUN echo y | gemini extensions install https://github.com/gemini-cli-extensions/nanobanana || true

# ---------------------------------------------------------------------------
# Browser Automation (Playwright)
# ---------------------------------------------------------------------------
RUN npx playwright install chromium

# ---------------------------------------------------------------------------
# Default command
# ---------------------------------------------------------------------------
CMD ["/bin/bash"]
