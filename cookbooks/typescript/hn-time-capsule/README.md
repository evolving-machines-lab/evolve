# Hacker News Time Capsule

Recreating [Karpathy's HN Time Capsule](https://github.com/karpathy/hn-time-capsule) (1,486 lines) in ~50 lines with Evolve.

Analyzes Hacker News frontpage articles from 10 years ago with hindsight, grades commenters on prediction accuracy, and generates an interactive HTML dashboard.

## Setup

```bash
cd cookbooks/typescript/hn-time-capsule
npm install
cp .env.example .env
# Edit .env with your API key
```

## Run

```bash
npm start
```

Output saved to `./output/index.html`

## How it works

1. **Fetch** (MAP) — Agent fetches Hacker News frontpage, article content, and comments
2. **Analyze** (MAP) — Agent analyzes each article with 10 years of hindsight
3. **Render** (REDUCE) — All analyses aggregated into interactive HTML dashboard

## Output structure

```
intermediate/
├── fetch/item_[i]/      # meta.json, article.txt, comments.json
└── analyze/item_[i]/    # data.json (structured analysis)
output/
└── index.html           # final dashboard
```
