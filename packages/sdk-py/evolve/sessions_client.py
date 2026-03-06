"""Standalone sessions() client for historical traces and past sessions."""

import asyncio
from typing import Any, Dict, List, Literal, Optional

from .results import SessionEvent, SessionInfo, SessionPage
from .utils import _filter_none, _require_session_info


class SessionsClient:
    """Client for listing historical sessions and downloading traces.

    Created via the standalone ``sessions()`` factory only.
    Wraps bridge JSON-RPC calls to the TypeScript SDK's sessions() client.

    Gateway-only: requires ``EVOLVE_API_KEY`` unless ``SessionsConfig(api_key=...)``
    is provided.

    Example::

        from evolve import sessions

        async with sessions() as client:
            page = await client.list(limit=20, state='ended')
            events = await client.events(page.items[0].id)
            path = await client.download(page.items[0].id, to='./traces')
    """

    def __init__(
        self,
        bridge: Any,
        sessions_config: Any = None,
        *,
        _owns_bridge: bool = False,
    ):
        self._bridge = bridge
        self._config = sessions_config
        self._owns_bridge = _owns_bridge
        self._started = False
        self._init_lock = asyncio.Lock()

    async def _ensure_ready(self) -> None:
        """Ensure the bridge is started and ready to handle RPC calls."""
        async with self._init_lock:
            if self._started:
                return
            await self._bridge.start()
            self._started = True

    def _build_params(self, **kwargs: Any) -> Dict[str, Any]:
        """Build RPC params, including standalone sessions config."""
        params: Dict[str, Any] = {}
        if self._config is not None:
            params['sessions'] = self._config.to_dict()
        params.update(_filter_none(kwargs))
        return params

    async def list(
        self,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        state: Optional[Literal['live', 'ended', 'all']] = None,
        agent: Optional[str] = None,
        tag_prefix: Optional[str] = None,
        sort: Optional[Literal['newest', 'oldest', 'cost']] = None,
    ) -> SessionPage:
        """List historical sessions with optional filtering and pagination."""
        await self._ensure_ready()
        params = self._build_params(
            limit=limit,
            cursor=cursor,
            state=state,
            agent=agent,
            tag_prefix=tag_prefix,
            sort=sort,
        )
        response = await self._bridge.call('sessions_list', params)
        return SessionPage(
            items=[_require_session_info(item) for item in response.get('items', [])],
            next_cursor=response.get('next_cursor'),
            has_more=bool(response.get('has_more', False)),
        )

    async def get(self, id: str) -> SessionInfo:
        """Get a single session's metadata by ID."""
        await self._ensure_ready()
        response = await self._bridge.call('sessions_get', self._build_params(id=id))
        return _require_session_info(response)

    async def events(
        self,
        id: str,
        *,
        since: Optional[int] = None,
    ) -> List[SessionEvent]:
        """Fetch parsed JSONL events for a historical session."""
        await self._ensure_ready()
        response = await self._bridge.call('sessions_events', self._build_params(id=id, since=since))
        return list(response.get('events', []))

    async def download(
        self,
        id: str,
        *,
        to: Optional[str] = None,
    ) -> str:
        """Download a session's raw JSONL trace file. Returns the local path."""
        await self._ensure_ready()
        response = await self._bridge.call('sessions_download', self._build_params(id=id, to=to))
        return response['path']

    async def close(self) -> None:
        """Close the sessions client and release resources."""
        if self._owns_bridge:
            await self._bridge.stop()

    async def __aenter__(self) -> 'SessionsClient':
        try:
            await self._ensure_ready()
            return self
        except Exception:
            await self.close()
            raise

    async def __aexit__(self, *args: Any) -> None:
        await self.close()
