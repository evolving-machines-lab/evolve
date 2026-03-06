"""
Integration tests for standalone sessions() client.

Tests all 4 methods against the live dashboard:
  1. list()      — paginated listing with filters
  2. get()       — single session metadata
  3. events()    — parsed JSONL events + delta fetch
  4. download()  — raw trace file to disk

Requires EVOLVE_API_KEY in environment.
"""

import asyncio
import os
import sys
import tempfile

# Add sdk-py to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from evolve import sessions, SessionsConfig, SessionInfo, SessionPage


async def main():
    api_key = os.environ.get('EVOLVE_API_KEY')
    if not api_key:
        print('SKIP: EVOLVE_API_KEY not set')
        return

    print('=== Python SDK sessions() Integration Test ===\n')

    async with sessions() as client:

        # ─── 1. list() — basic ───
        print('[1] list(limit=5, state="ended", sort="newest")')
        page = await client.list(limit=5, state='ended', sort='newest')
        assert isinstance(page, SessionPage), f'Expected SessionPage, got {type(page)}'
        assert isinstance(page.items, list)
        assert isinstance(page.has_more, bool)
        print(f'    items: {len(page.items)}, has_more: {page.has_more}, next_cursor: {page.next_cursor}')
        for item in page.items:
            assert isinstance(item, SessionInfo), f'Expected SessionInfo, got {type(item)}'
            print(f'    - {item.id[:20]}  tag={item.tag}  agent={item.agent}  state={item.state}  cost={item.cost}')
        print('    PASS\n')

        if not page.items:
            print('SKIP: No sessions found — cannot test get/events/download')
            return

        session = page.items[0]

        # ─── 2. list() — filter by agent ───
        print(f'[2] list(agent="{session.agent}", limit=3)')
        filtered = await client.list(agent=session.agent, limit=3)
        for item in filtered.items:
            assert item.agent == session.agent, f'Expected agent={session.agent}, got {item.agent}'
        print(f'    {len(filtered.items)} items, all agent={session.agent}')
        print('    PASS\n')

        # ─── 3. list() — filter by tag_prefix ───
        # Use first 4 chars of first session's tag as prefix
        prefix = session.tag[:4] if len(session.tag) >= 4 else session.tag
        print(f'[3] list(tag_prefix="{prefix}", limit=3)')
        tagged = await client.list(tag_prefix=prefix, limit=3)
        for item in tagged.items:
            assert item.tag.startswith(prefix), f'Expected tag starting with {prefix}, got {item.tag}'
        print(f'    {len(tagged.items)} items, all tags start with "{prefix}"')
        print('    PASS\n')

        # ─── 4. list() — pagination ───
        print('[4] Pagination: list(limit=2) then list(limit=2, cursor=next_cursor)')
        p1 = await client.list(limit=2, state='ended')
        if p1.next_cursor:
            p2 = await client.list(limit=2, state='ended', cursor=p1.next_cursor)
            assert isinstance(p2, SessionPage)
            # Pages should not overlap
            p1_ids = {i.id for i in p1.items}
            p2_ids = {i.id for i in p2.items}
            assert not p1_ids & p2_ids, f'Pages overlap: {p1_ids & p2_ids}'
            print(f'    Page 1: {len(p1.items)} items, Page 2: {len(p2.items)} items, no overlap')
        else:
            print(f'    Only {len(p1.items)} total sessions, no second page')
        print('    PASS\n')

        # ─── 5. list() — sort by cost ───
        print('[5] list(sort="cost", limit=5, state="ended")')
        cost_sorted = await client.list(sort='cost', limit=5, state='ended')
        costs = [i.cost for i in cost_sorted.items if i.cost is not None]
        if len(costs) >= 2:
            assert costs == sorted(costs, reverse=True), f'Not sorted desc: {costs}'
            print(f'    Costs (desc): {costs}')
        else:
            print(f'    Not enough costed sessions to verify sort ({len(costs)})')
        print('    PASS\n')

        # ─── 6. get() — single session metadata ───
        print(f'[6] get("{session.id[:20]}...")')
        info = await client.get(session.id)
        assert isinstance(info, SessionInfo)
        assert info.id == session.id
        assert info.tag == session.tag
        assert info.agent == session.agent
        assert info.state in ('live', 'ended')
        assert info.runtime_status in ('alive', 'dead', 'unknown')
        assert isinstance(info.step_count, int)
        assert isinstance(info.created_at, str)
        print(f'    id={info.id[:20]}  tag={info.tag}  model={info.model}')
        print(f'    state={info.state}  runtime_status={info.runtime_status}')
        print(f'    cost={info.cost}  step_count={info.step_count}')
        print(f'    sandbox_id={info.sandbox_id}  provider={info.provider}')
        print(f'    created_at={info.created_at}  ended_at={info.ended_at}')
        print(f'    tool_stats={info.tool_stats}')
        print('    PASS\n')

        # ─── 7. events() — full fetch ───
        print(f'[7] events("{session.id[:20]}...")')
        events = await client.events(session.id)
        assert isinstance(events, list)
        print(f'    {len(events)} events')
        if events:
            print(f'    First event keys: {list(events[0].keys())[:5]}')
        print('    PASS\n')

        # ─── 8. events() — delta fetch with since=0 ───
        print(f'[8] events("{session.id[:20]}...", since=0)')
        events_since_0 = await client.events(session.id, since=0)
        assert isinstance(events_since_0, list)
        # since=0 should return same as full fetch
        assert len(events_since_0) == len(events), \
            f'since=0 returned {len(events_since_0)}, full returned {len(events)}'
        print(f'    {len(events_since_0)} events (same as full fetch)')
        print('    PASS\n')

        # ─── 9. events() — delta fetch with since=N ───
        if len(events) > 2:
            since_n = len(events) - 2
            print(f'[9] events("{session.id[:20]}...", since={since_n})')
            delta = await client.events(session.id, since=since_n)
            assert isinstance(delta, list)
            assert len(delta) <= len(events), \
                f'Delta ({len(delta)}) > full ({len(events)})'
            print(f'    {len(delta)} events (delta from {since_n})')
            print('    PASS\n')
        else:
            print('[9] SKIP: Not enough events for delta test\n')

        # ─── 10. download() — to temp dir ───
        with tempfile.TemporaryDirectory() as tmpdir:
            print(f'[10] download("{session.id[:20]}...", to="{tmpdir}")')
            path = await client.download(session.id, to=tmpdir)
            assert isinstance(path, str)
            assert os.path.isfile(path), f'File not found: {path}'
            size = os.path.getsize(path)
            assert size > 0, f'Downloaded file is empty: {path}'
            print(f'    path={path}')
            print(f'    size={size} bytes')
            # Verify it's valid JSONL
            with open(path, 'r') as f:
                first_line = f.readline().strip()
            assert first_line.startswith('{'), f'Not JSONL: {first_line[:80]}'
            print(f'    First line starts with "{{" — valid JSONL')
            print('    PASS\n')

    print('=== All 10 tests passed ===')


if __name__ == '__main__':
    asyncio.run(main())
