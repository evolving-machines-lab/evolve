# =============================================================================
# Evolve All-in-One Sandbox Image
# =============================================================================
# Uses e2bdev/code-interpreter:latest as base for 100% parity with E2B template.
#
# Base image includes:
#   - Python 3.12 + ML/science packages (numpy, pandas, scikit-learn, scipy, etc.)
#   - Node.js
#   - Many pre-installed libraries (see E2B code-interpreter docs)
#
# This Dockerfile adds:
#   - Google Chrome + Playwright for browser automation
#   - Claude Code, Codex, Gemini CLI, Qwen Code, OpenCode
#   - Kimi CLI (Python)
#   - ACP adapters for Claude and Codex
#   - Skills from github.com/evolving-machines-lab/evolve
#
# Build: docker build --platform=linux/amd64 -t evolvingmachines/evolve-all:latest .
# Push:  docker push evolvingmachines/evolve-all:latest
# =============================================================================

FROM e2bdev/code-interpreter:latest

# ---------------------------------------------------------------------------
# Switch to root for system installations
# ---------------------------------------------------------------------------
USER root

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# System packages
# ---------------------------------------------------------------------------
# Remove NodeSource repo (SHA1 key deprecated since 2026-02-01)
RUN rm -f /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true \
    && apt-get update && apt-get install -y \
    curl \
    git \
    ripgrep \
    wget \
    gnupg \
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
# UV package manager for Python
# ---------------------------------------------------------------------------
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

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
    @qwen-code/qwen-code@latest \
    opencode-ai@latest

# ---------------------------------------------------------------------------
# Kimi CLI (Python package — requires Python >= 3.12)
# ---------------------------------------------------------------------------
RUN pip install kimi-cli

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
RUN mkdir -p /home/user/.evolve/skills \
             /home/user/.claude/skills \
             /home/user/.codex/skills \
             /home/user/.gemini/skills \
             /home/user/.qwen/skills \
             /home/user/.kimi/skills \
             /home/user/.agents/skills \
    && chown -R user:user /home/user

# ---------------------------------------------------------------------------
# Switch to user
# ---------------------------------------------------------------------------
USER user

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
    && rm -rf /tmp/evolve

# ---------------------------------------------------------------------------
# Gemini settings (enable experimental skills)
# ---------------------------------------------------------------------------
RUN echo '{"experimental":{"skills":true}}' > /home/user/.gemini/settings.json

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
