"""Prompt for browser-use cookbook."""

import json
from typing import Any


def visit_post_prompt(files: dict[str, Any], _: int) -> str:
    cfg = json.loads(files["config.json"])
    rank = int(cfg["rank"])
    page = int(cfg["page"])
    pos = int(cfg["position_on_page"])
    rank_str = f"{rank:03d}"

    return f"""\
Use the MCP server "browser-use" to browse Hacker News and visit ONE post.

Timing note:
- browser-use calls an LLM and performs networked browser actions, so it can be slow.
- Expect each post to sometimes take **2–3 minutes**. Be patient and wait for actions to complete;
  do not assume failure just because a step is taking time.

Tooling constraint:
- Do NOT use Playwright (or any other browser automation tooling) separately.
- Use ONLY the "browser-use" MCP tools for all browsing, clicking, scrolling, and screenshots.

Input:
- Read `context/config.json` (JSON) for `rank`, `page`, `position_on_page`.

Task (do all of these, in order):
1) Navigate to `https://news.ycombinator.com/news?p={page}`.
2) From the HN listing row for rank {rank}, extract:
   - title
   - HN item id (if present)
   - points (if present)
   - comments count (if present)
   - outbound URL (the title link href)
3) Click on the post to open it and record `final_url` as the URL after navigation/redirects.
4) Capture 2-3 key screenshots that best represent the post content:
   - `output/screenshots/post_{rank_str}/01_main.png` - Main content/hero section
   - `output/screenshots/post_{rank_str}/02_key_visual.png` - Most important visual element (chart, diagram, image, etc.)
   - `output/screenshots/post_{rank_str}/03_additional.png` - Additional relevant content (optional)
5) Generate a multimodal markdown summary of the post:
   - Read and analyze the content from the opened page
   - Write a 2-3 paragraph summary in markdown format
   - Embed the captured screenshots in the markdown using relative paths: `![caption](screenshots/post_{rank_str}/filename.png)`
   - Include the most relevant/interesting aspects of the content
   - Make the summary visually informative with embedded images from the post/website
   - Save as `output/summary_{rank_str}.md`

Output: Write `output/result.json` matching the provided schema.

Notes:
- Rank {rank} is the overall rank across pages. It should appear as "{rank}." on the page.
- If the outbound link opens in a new tab/window, that's fine—still capture screenshots and final_url.
- Capture as many relevant visual elements as possible (images, charts, code snippets, etc.) for the summary.
- The markdown summary should be self-contained and visually informative with embedded screenshots.
"""
