# Contributing to Evolve SDK

Thanks for your interest in contributing to Evolve SDK!

## Project Structure

```
evolve/
├── packages/
│   ├── sdk-ts/          # TypeScript SDK (@evolvingmachines/sdk)
│   ├── sdk-py/          # Python SDK (evolve-sdk on PyPI)
│   │   └── bridge/      # Node.js bridge for Python SDK
│   └── e2b/             # E2B sandbox integration (@evolvingmachines/e2b)
├── skills/              # Agent skills (pdf, docx, browser, etc.)
├── cookbooks/           # Example applications
│   ├── python/          # Python examples
│   └── typescript/      # TypeScript examples
├── docs/                # SDK documentation
└── assets/              # Logo and images
```

## Reporting Issues

Found a bug or have a feature request? [Open a GitHub issue](https://github.com/evolving-machines-lab/evolve/issues/new).

**For bugs, please include:**
- SDK version (`npm list @evolvingmachines/sdk` or `pip show evolve-sdk`)
- Node.js and Python versions
- Minimal code to reproduce the issue
- Error messages and stack traces

**For feature requests:**
- Describe the use case
- Explain why existing features don't solve it

## Development Setup

```bash
# Clone the repo
git clone https://github.com/evolving-machines-lab/evolve.git
cd evolve

# Install dependencies
npm install

# Build all packages (e2b → sdk-ts → bridge)
npm run build
```

### Running Tests

**Unit tests** run locally without external dependencies:

```bash
# TypeScript
npm run test:ts:unit

# Python
cd packages/sdk-py
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/unit -v
```

**Integration tests** spawn real sandboxes and agents, so they require a `.env` file at the repo root:

```bash
# .env (at repo root)

# Required
EVOLVE_API_KEY=sk-...
E2B_API_KEY=e2b_...

# Optional - which agent to test (default: runs all)
TEST_AGENT_TYPE=codex              # claude | codex | gemini | qwen

# Optional - model overrides
CODEX_MODEL=gpt-5.2
CODEX_REASONING_EFFORT=medium      # low | medium | high
ANTHROPIC_MODEL=opus               # opus | sonnet | haiku
ANTHROPIC_BETAS=context-1m-2025-08-07
GEMINI_MODEL=gemini-3-pro-preview
QWEN_OPENAI_MODEL=qwen3-coder-plus
```

```bash
npm run test:ts:integration    # TypeScript integration tests
npm run test:py:integration    # Python integration tests
```

### Package Dependencies

Build order matters due to dependencies:
1. `@evolvingmachines/e2b` - standalone
2. `@evolvingmachines/sdk` - depends on e2b
3. `evolve-sdk-python-bridge` - depends on both

The root `npm run build` handles this automatically.

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Ensure unit tests pass (`npm run test:ts:unit`)
4. Open a PR with a clear description

## Questions?

Open an issue or reach out at [brandomagnani@evolvingmachines.ai](mailto:brandomagnani@evolvingmachines.ai).
