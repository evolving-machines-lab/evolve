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
#   - Claude Code, Codex, Gemini CLI, Qwen Code, OpenCode, Droid
#   - Kimi Code
#   - DeepSeek Harness (dsh, pinned)
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
ENV PATH="/home/user/.local/bin:${PATH}"

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
# Kimi Code
# ---------------------------------------------------------------------------
RUN curl -fsSL https://code.kimi.com/kimi-code/install.sh | KIMI_INSTALL_DIR=/home/user/.kimi-code KIMI_NO_MODIFY_PATH=1 bash \
    && ln -sf /home/user/.kimi-code/bin/kimi /usr/local/bin/kimi \
    && kimi --version \
    && chown -R user:user /home/user/.kimi-code

# ---------------------------------------------------------------------------
# DeepSeek Harness (dsh)
# ---------------------------------------------------------------------------
# PINNED, not @latest: the headless surface the SDK drives (--json,
# --session-id, stdin) exists only in the `next` prerelease line; npm `latest`
# (0.1.5-rc.3) has none of it and a different session format. npm verifies the
# tarball against the registry's recorded sha512 integrity on install (the
# vendor publishes no separate checksum file) and pulls the glibc
# @deepseek-ai/node-addon-system-linux-x64 optional dep (POSIX flock; session
# writes require it), so optional deps stay ON here.
#
# ITS OWN NODE. dsh needs node >=22.19 (or >=24); this base image ships node
# 20 (probed 2026-09-25: v20.20.2), which every other CLI here runs on. So dsh
# gets a private Node 22 under /opt/node22 — v22.23.1, the same LTS the hosted
# eval bundle carries — verified against nodejs.org's published SHASUMS256.txt,
# and `dsh` on PATH is a two-line launcher onto it. Nothing else in the image
# changes runtime; the npm bin shim (`#!/usr/bin/env node`, node 20) is not
# what runs.
ARG DSH_NODE_VERSION=22.23.1
RUN cd /tmp \
    && curl -fsSLO "https://nodejs.org/dist/v${DSH_NODE_VERSION}/node-v${DSH_NODE_VERSION}-linux-x64.tar.xz" \
    && curl -fsSL "https://nodejs.org/dist/v${DSH_NODE_VERSION}/SHASUMS256.txt" \
       | grep " node-v${DSH_NODE_VERSION}-linux-x64.tar.xz\$" | sha256sum -c - \
    && mkdir -p /opt/node22 \
    && tar -xJf "node-v${DSH_NODE_VERSION}-linux-x64.tar.xz" -C /opt/node22 --strip-components=1 \
    && rm "node-v${DSH_NODE_VERSION}-linux-x64.tar.xz" \
    && /opt/node22/bin/npm install -g --prefix /opt/dsh @deepseek-ai/dsh@0.1.7-rc.2 \
    && printf '#!/bin/sh\nexec /opt/node22/bin/node /opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"\n' > /usr/local/bin/dsh \
    && chmod 0755 /usr/local/bin/dsh \
    && dsh --version

# ---------------------------------------------------------------------------
# MCP Tools (HTTP-to-STDIO bridge for remote MCP servers)
# ---------------------------------------------------------------------------
RUN npm install -g mcp-remote

# ---------------------------------------------------------------------------
# Agent Browser CLI (headless browser automation for AI agents)
# ---------------------------------------------------------------------------
RUN npm install -g agent-browser @actionbookdev/cli

# TEMPORARY ACTIONBOOK DAEMON WORKAROUND.
# Remove this RUN block and the matching E2B template runCmd only after
# @actionbookdev/cli includes actionbook/actionbook#611.
RUN REAL_ACTIONBOOK="$(command -v actionbook)" \
    && mkdir -p /home/user/.local/bin \
    && printf '%s\n' \
        '#!/usr/bin/env bash' \
        'set -euo pipefail' \
        "REAL_ACTIONBOOK=\"$REAL_ACTIONBOOK\"" \
        'if [[ "${1:-}" == "browser" && "${2:-}" == "start" ]]; then exec /usr/bin/setsid "$REAL_ACTIONBOOK" "$@"; fi' \
        'exec "$REAL_ACTIONBOOK" "$@"' \
        > /home/user/.local/bin/actionbook \
    && chmod +x /home/user/.local/bin/actionbook \
    && chown -R user:user /home/user/.local

# ---------------------------------------------------------------------------
# User setup
# ---------------------------------------------------------------------------
RUN mkdir -p /home/user/.claude/skills \
             /home/user/.codex/skills \
             /home/user/.gemini/skills \
             /home/user/.qwen/skills \
             /home/user/.kimi-code/skills \
             /home/user/.agents/skills \
             /home/user/.factory/skills \
             /home/user/.dsh/skills \
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
# Factory Droid CLI
# ---------------------------------------------------------------------------
RUN curl -fsSL https://app.factory.ai/cli | sh

# Make Droid available to non-login shell commands.
USER root
RUN ln -sf /home/user/.local/bin/droid /usr/local/bin/droid \
    && chown -R user:user /home/user/.factory /home/user/.local
USER user

# ---------------------------------------------------------------------------
# Skills: no baked catalog. Skills are resolved at run time by the SDK's
# resolver (packages/sdk-ts/src/skills.ts) from real references and mounted
# into the per-CLI skills directories created above.
# ---------------------------------------------------------------------------
# Gemini Extensions (Nano Banana for image generation)
# ---------------------------------------------------------------------------
# Best-effort: newer Gemini CLI builds can prompt for an API key here.
RUN timeout 30s sh -c 'printf "y\ny\n\n" | gemini extensions install https://github.com/gemini-cli-extensions/nanobanana' || true

# ---------------------------------------------------------------------------
# Browser Automation (Playwright)
# ---------------------------------------------------------------------------
RUN npx playwright install chromium

# ---------------------------------------------------------------------------
# Refresh stamp (see assets/docker/write-refresh-stamp.ts)
# ---------------------------------------------------------------------------
# Everything above installs its tools with @latest, so this Dockerfile's text
# can stay identical while the image it describes moves underneath it. The
# stamp is the supported way to say so: it is an ordinary build input, hashing
# into the derived c-<12hex> tag like any other file, and it is COPY'd here so
# it is genuine image content rather than a hash decoration —
# `cat /etc/evolve-image-refresh` in a sandbox reports which refresh built it.
# Last because nothing above should depend on it — not to save a rebuild:
# build.ts builds with --no-cache, so every layer is rebuilt regardless, which
# is the point of a forced refresh (it is how the @latest tools actually move).
USER root
COPY refresh-stamp /etc/evolve-image-refresh
RUN chmod 0644 /etc/evolve-image-refresh
USER user

# ---------------------------------------------------------------------------
# Default command
# ---------------------------------------------------------------------------
CMD ["/bin/bash"]
