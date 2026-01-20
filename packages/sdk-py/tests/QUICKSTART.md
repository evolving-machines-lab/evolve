# Python SDK Test Suite - Quick Start Guide

This test suite provides comprehensive coverage of the Evolve SDK Python SDK, mirroring the TypeScript SDK test structure.

## 🚀 Quick Setup (3 Steps)

```bash
# 1. Create virtual environment (from packages/sdk-py/)
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements-dev.txt

# 3. Run tests
pytest -sv
```

**Tip:** Use `-s` to see emoji-based test output!

That's it! Tests will use environment variables from root `.env` file automatically.

---

## 📋 Test Coverage

The test suite includes **31+ tests** across **6 test files**:

1. **test_01_basic_methods.py** (6 tests)
   - `run()` - AI task execution
   - `execute_command()` - Direct shell commands
   - Multi-turn conversations (auto-resume vs explicit history)
   - Working directory configuration
   - Environment secrets (`withSecrets()`)
   - Port forwarding (`get_host()`)

2. **test_02_file_operations.py** (5 tests)
   - Single file upload
   - Batch file upload
   - Binary file upload
   - Output file retrieval
   - Timestamp-based filtering

3. **test_03_session_management.py** (5 tests)
   - Session ID retrieval (`get_session()`)
   - Session reconnection (`set_session()`)
   - Sandbox pause/resume
   - Sandbox termination (`kill()`)
   - Multiple session switching

4. **test_04_workspace_modes.py** (6 tests)
   - Knowledge mode structure
   - Knowledge mode with custom prompts
   - SWE mode (minimal structure)
   - SWE mode with custom prompts
   - Context files in knowledge mode
   - Context files in SWE mode

5. **test_05_streaming_events.py** (5 tests)
   - Stdout event callbacks
   - Stderr event callbacks
   - Complete event callbacks
   - Content event callbacks (parsed streaming events)
   - Content priority over stdout (no duplication)

6. **test_06_mcp_servers.py** (2 tests)
   - DuckDuckGo MCP server (no API key required)
   - Brave Search MCP server (requires `BRAVE_API_KEY`)

## 🔧 Setup Details

### Directory
All commands run from: `packages/sdk-py/`

### Environment Variables
Create `.env` in workspace root (`evolve/`):

```bash
# Required for all tests
EVOLVE_API_KEY=sk_your_gateway_key            # Single key for all agents

# Optional overrides
# EVOLVE_GATEWAY_URL=http://localhost:4000    # Point at custom LiteLLM gateway
CODEX_MODEL=gpt-5-codex
CLAUDE_MODEL=claude-sonnet-4-5-20250929
GEMINI_MODEL=gemini-2.5-flash
QWEN_MODEL=qwen3-coder-plus

# Optional: MCP server testing
BRAVE_API_KEY=your_brave_api_key                # For Brave MCP tests
```

## 🚀 Running Tests

**All commands from `packages/sdk-py/` directory.**

### Basic Usage

```bash
# All tests with full output (RECOMMENDED - shows emoji logging)
pytest -s

# Verbose with output
pytest -sv

# Without output (clean summary only)
pytest

# Specific test file
pytest -s tests/integration/test_01_basic_methods.py

# Specific test function
pytest -s tests/integration/test_01_basic_methods.py::test_run_method
```

**Note:** Use `-s` flag to see detailed emoji-based test output! Without it, pytest captures output and only shows a clean summary.

### Different Agents

```bash
# Override agent type
TEST_AGENT_TYPE=codex pytest
TEST_AGENT_TYPE=claude pytest tests/integration/test_01_basic_methods.py
TEST_AGENT_TYPE=gemini pytest -v
```

### Supported Agent Types

- `codex` - GPT-5 Codex (default)
- `claude` - Claude Sonnet
- `gemini` - Gemini 2.5 Flash/Pro
- `qwen` - Qwen3 Coder Plus

## 🧪 Pytest Tips

```bash
# Show detailed output (emoji logging)
pytest -s

# Verbose + output (RECOMMENDED)
pytest -sv

# Stop on first failure
pytest -sx

# Run last failed tests
pytest --lf

# Parallel execution (requires pytest-xdist)
pytest -n auto
```

## 📊 Test Output

Tests use emoji-based logging for clear visual feedback:

```
🚀 Starting Basic SDK Method Tests
📋 Agent: Codex (codex)
🔑 Model: gpt-5-codex

======================================================================
🧪 Test 1: Basic run() method - Codex
======================================================================

ℹ️  Sending prompt: "Create a hello.txt file inside the output/ folder with content "Hello world!""
✅ run() executed successfully
✅ Exit code: 0
✅ Sandbox ID: sb_xxx
✅ Stdout length: 1234 chars
✅ Test completed successfully

======================================================================
✅ All basic method tests passed for Codex!
======================================================================
```

## 🐛 Debugging Tests

### Print Additional Debug Info

Modify test helpers to add more logging:

```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

### Inspect Failed Test Output

```bash
pytest --tb=long tests/integration/
```

### Keep Sandboxes Alive for Inspection

Comment out `await evolve.kill()` in failing tests to keep sandbox running.

## ⚙️ Advanced Configuration

### Custom Model Selection

Set model environment variables:

```bash
CODEX_MODEL=gpt-5-codex-mini TEST_AGENT_TYPE=codex python -m pytest tests/integration/
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929 TEST_AGENT_TYPE=claude python tests/integration/test_01_basic_methods.py
```

### Adjust Timeouts

Edit timeout values in individual tests:

```python
await evolve.run(
    prompt="...",
    timeout_ms=300000  # 5 minutes instead of 2
)
```

## 📦 Test Architecture

### Python-Specific Features

The Python SDK test suite includes patterns specific to Python:

1. **Async/Await**: All tests use `asyncio` and `async/await`
2. **Context Managers**: Tests use `async with Evolve(...)` for automatic cleanup
3. **Type Hints**: Test utilities use Python type hints
4. **Dataclasses**: Results use dataclasses

### Bridge Architecture

The Python SDK uses a JSON-RPC bridge to the TypeScript SDK:

- Bridge auto-builds on first run (requires Node.js 18+)
- Binary data is base64-encoded over JSON-RPC
- Event callbacks work via bridge event forwarding
- Fallback pattern: stdout events go to update listeners if no stdout listener registered

## 🔄 Continuous Integration

Example GitHub Actions workflow:

```yaml
name: Python SDK Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        agent: [codex, claude, gemini, qwen]
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-python@v4
        with:
          python-version: '3.11'
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: pip install -e packages/sdk-py
      - run: pip install pytest pytest-asyncio python-dotenv
      - run: TEST_AGENT_TYPE=${{ matrix.agent }} pytest packages/sdk-py/tests/integration/
        env:
          EVOLVE_API_KEY: ${{ secrets.EVOLVE_API_KEY }}
          BRAVE_API_KEY: ${{ secrets.BRAVE_API_KEY }}
```

## 📚 Additional Resources

- **TypeScript SDK Tests**: `packages/sdk-ts/tests/` - Reference implementation
- **Python SDK Docs**: `packages/sdk-py/README.md`
- **Agent Config**: `tests/utils/agent_config.py` - Agent configuration factory
- **Test Helpers**: `tests/utils/test_helpers.py` - Logging and assertion utilities

## 🤝 Contributing

When adding new tests:

1. Follow the existing test structure and naming conventions
2. Use descriptive test function names (`test_feature_description`)
3. Add appropriate logging with `log_section()`, `log_info()`, and `log_result()`
4. Clean up resources with `await evolve.kill()` or `async with`
5. Update this QUICKSTART.md if adding new test categories
