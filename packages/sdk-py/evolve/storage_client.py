"""StorageClient for browsing and downloading checkpoints."""

from typing import Any, Awaitable, Callable, Dict, List, Optional, Union

from .results import CheckpointInfo
from .utils import _decode_files_from_transport, _filter_none, _parse_checkpoint, _require_checkpoint


class StorageClient:
    """Client for browsing and downloading checkpoints.

    Created via the standalone ``storage()`` factory or ``Evolve.storage()`` accessor.
    Wraps bridge JSON-RPC calls to the TypeScript SDK's StorageClient.

    Two creation modes:

    - **Standalone** (``storage(config)``): Owns its own bridge subprocess.
      Use as an async context manager to ensure cleanup.
    - **Bound** (``evolve.storage()``): Reuses the Evolve instance's bridge.
      No cleanup needed — the Evolve instance manages the bridge.

    Example (standalone)::

        from evolve import storage, StorageConfig

        async with storage(StorageConfig(url='s3://my-bucket/')) as store:
            checkpoints = await store.list_checkpoints(limit=5)
            files = await store.download_files(checkpoints[0].id)

    Example (bound)::

        async with Evolve(storage=StorageConfig(url='s3://bucket/')) as evolve:
            store = evolve.storage()
            info = await store.get_checkpoint('ckpt_abc123')
    """

    def __init__(
        self,
        bridge: Any,
        storage_config: Any = None,
        *,
        _owns_bridge: bool = False,
        _init_fn: Optional[Callable[[], Awaitable[None]]] = None,
    ):
        self._bridge = bridge
        self._config = storage_config  # None = use Evolve's initialized config
        self._owns_bridge = _owns_bridge
        # Readiness callback — in bound mode this triggers Evolve._ensure_initialized
        # so the bridge adapter has a live Evolve instance to delegate to.
        self._init_fn = _init_fn
        self._started = False

    async def _ensure_ready(self) -> None:
        """Ensure the bridge is started and ready to handle RPC calls."""
        if not self._started:
            if self._init_fn is not None:
                await self._init_fn()
            else:
                await self._bridge.start()
            self._started = True

    def _build_params(self, **kwargs: Any) -> Dict[str, Any]:
        """Build RPC params, including storage config if in standalone mode."""
        params: Dict[str, Any] = {}
        if self._config is not None:
            params['storage'] = self._config.to_dict()
        params.update(_filter_none(kwargs))
        return params

    async def list_checkpoints(
        self,
        limit: Optional[int] = None,
        tag: Optional[str] = None,
    ) -> List[CheckpointInfo]:
        """List checkpoints sorted by newest first.

        Args:
            limit: Maximum number of checkpoints to return (default: 100, max: 500)
            tag: Filter by session tag

        Returns:
            List of CheckpointInfo sorted by newest first
        """
        await self._ensure_ready()
        params = self._build_params(limit=limit, tag=tag)
        response = await self._bridge.call('storage_list_checkpoints', params)
        return [_require_checkpoint(cp) for cp in response]

    async def get_checkpoint(self, id: str) -> CheckpointInfo:
        """Get checkpoint metadata by ID.

        Args:
            id: Checkpoint ID

        Returns:
            CheckpointInfo with full metadata

        Raises:
            Exception: If checkpoint not found
        """
        await self._ensure_ready()
        params = self._build_params(id=id)
        response = await self._bridge.call('storage_get_checkpoint', params)
        return _require_checkpoint(response)

    async def download_checkpoint(
        self,
        id: str,
        *,
        to: Optional[str] = None,
        extract: bool = True,
    ) -> str:
        """Download a checkpoint archive.

        Args:
            id: Checkpoint ID or ``"latest"``
            to: Target directory (default: system temp dir)
            extract: Extract the tar.gz archive (default: True).
                     If False, saves the raw .tar.gz file.

        Returns:
            Path to the extracted directory or saved archive file
        """
        await self._ensure_ready()
        # Only pass extract when False (True is the default on the bridge side)
        params = self._build_params(id=id, to=to, extract=False if not extract else None)
        response = await self._bridge.call('storage_download_checkpoint', params)
        return response['path']

    async def download_files(
        self,
        id: str,
        *,
        files: Optional[List[str]] = None,
        glob: Optional[List[str]] = None,
        to: Optional[str] = None,
    ) -> Dict[str, Union[str, bytes]]:
        """Download specific files from a checkpoint.

        For large checkpoints, prefer :meth:`download_checkpoint` which streams
        the archive to disk instead of loading all files into memory.

        Args:
            id: Checkpoint ID or ``"latest"``
            files: Exact file paths to extract (e.g., ``["workspace/data.txt"]``)
            glob: Glob patterns to match (e.g., ``["workspace/*.txt"]``)
            to: Write files to this directory instead of returning in-memory

        Returns:
            Dict mapping file path to content (str for text, bytes for binary)
        """
        await self._ensure_ready()
        params = self._build_params(id=id, files=files, glob=glob, to=to)
        response = await self._bridge.call('storage_download_files', params)
        return _decode_files_from_transport(response.get('files', {}))

    async def close(self) -> None:
        """Close the storage client and release resources.

        Only needed for standalone clients (created via ``storage()``).
        Bound clients (from ``Evolve.storage()``) are managed by the Evolve instance.
        """
        if self._owns_bridge:
            await self._bridge.stop()

    async def __aenter__(self) -> 'StorageClient':
        try:
            await self._ensure_ready()
            return self
        except Exception:
            await self.close()
            raise

    async def __aexit__(self, *args: Any) -> None:
        await self.close()
