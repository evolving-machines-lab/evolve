# Evolve Python Quickstart

8 examples demonstrating Evolve SDK features.

## Setup

```bash
cd cookbooks/python/quickstart
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your API keys
```

## Examples

| # | Script | Description |
|---|--------|-------------|
| 01 | `01_hello_agent.py` | Sandboxed agent with optional web search |
| 02 | `02_streaming.py` | Real-time streaming with all event types |
| 03 | `03_mcp_chrome.py` | Browser automation via Chrome DevTools MCP |
| 04 | `04_multi_turn.py` | Multi-turn conversations with memory |
| 05 | `05_structured_output.py` | Pydantic schema validation |
| 06 | `06_map_verify.py` | Parallel map with LLM-as-judge verification |
| 07 | `07_map_bestof.py` | Map with N candidates, judge picks best |
| 08 | `08_map_filter_reduce.py` | Pipeline: map → filter → reduce |

## Run

```bash
python 01_hello_agent.py
python 02_streaming.py
# etc.
```
