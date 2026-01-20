"""Prompts for Hacker News Time Capsule analysis."""

import json


def FETCH(files, idx):
    config = json.loads(files["config.json"])
    rank = config["rank"]
    date = config["date"]
    return f"""Fetch Hacker News article rank {rank} from {date}.

Source: news.ycombinator.com/front?day={date}
Comments API: hn.algolia.com/api/v1/items/{{item_id}}

Write code to download and parse.

Save the following 3 filesto output/ (and nothing else):
- meta.json: rank, title, url, hn_url, points, author, comment_count
- article.txt: article content (text only, HTML stripped, truncate to 15k chars at sentence boundary)
- comments.json: comment thread (strip HTML from text)"""

ANALYZE = """Analyze this Hacker News article from 10 years ago.

Files in context/:
- meta.json: article metadata
- article.txt: article content
- comments.json: discussion thread

With 10 years of hindsight:
1. Summarize the article and discussion
2. Research what actually happened
3. Find the most prescient and most wrong comments
4. Note any fun or notable aspects
5. Grade commenters
6. Rate how interesting this retrospective is

Save a single output/result.json following the provided schema."""

RENDER = """Create a beautiful HTML dashboard from all analyses.

Files: context/item_*/data.json (schema provided)

Write a script to:
1. Load all data.json files
2. Aggregate grades per user (keep users with 3+ grades)
3. Calculate GPA (A=4, B=3, C=2, D=1, F=0, ±0.3)
4. Generate a single-page HTML app:
   - Left sidebar (250px): article list ranked by score, clickable
   - Center panel: full analysis for selected article
   - Right sidebar (200px): Hall of Fame leaderboard (top commenters by GPA)
   - Header: title and date
   - Style: light theme, warm grays, generous whitespace

Design: minimalist, Apple-like, intuitive. Simplicity as ultimate sophistication.
Functional and a pleasure to use. Do not make it look LLM-generated or vibe-coded.
Make it look done by a professional human designer with superior taste for beauty. 

Run script and save to output/index.html"""
