# Browser-Use Cookbook

Scrape Hacker News posts using browser-use cloud API with Evolve.

## What it does

1. Visits the top 3 Hacker News posts in parallel
2. Extracts metadata (title, points, comments, URLs)
3. Captures screenshots of each post
4. Generates a markdown summary with embedded images
5. Saves everything locally

## Setup

```bash
cd cookbooks/python/browser-use
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your API keys (EVOLVE_API_KEY, BROWSER_USE_API_KEY)
```

Get a browser-use API key from https://browser-use.com

## Run

```bash
python browser.py
```

## Output

Results are saved to `output_browser_use/hn_top_3_multimodal_<timestamp>/`:

```
output_browser_use/
└── hn_top_3_multimodal_20250109_120000/
    ├── run_config.json
    ├── index.json
    └── posts/
        ├── 001/
        │   ├── data.json
        │   ├── summary.md
        │   └── screenshots/...
        ├── 002/
        └── 003/
```

## Files

| File | Purpose |
|------|---------|
| `browser.py` | Main script with pipeline configuration |
| `prompt.py` | Prompt template for the agent |
| `schema.py` | Pydantic schema for structured output |
| `items.py` | Helper functions for items and result saving |
