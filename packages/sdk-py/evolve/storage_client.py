"""StorageClient for browsing and downloading checkpoints."""

import base64
from typing import Any, Dict, List, Optional, Union

from .results import CheckpointInfo


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

        async with await storage(StorageConfig(url='s3://my-bucket/')) as store:
            checkpoints = await store.list_checkpoints(limit=5)
            files = await store.download_files(checkpoints[0].id)

    Example (bound)::

        async with Evolve(storage=StorageConfig(url='s3://bucket/')) as evolve:
            store = evolve.storage()
            info = await store.get_checkpoint('ckpt_abc123')
    """

    def __init__(self, bridge: Any, storage_config: Any = None, *, _owns_bridge: bool = False):
        self._bridge = bridge
        self._config = storage_config  # None = use Evolve's initialized config
        self._owns_bridge = _owns_bridge
        self._started = False

    async def _ensure_bridge(self) -> None:
        if not self._started:
            await self._bridge.start()
            self._started = True

    def _build_params(self, **kwargs: Any) -> Dict[str, Any]:
        """Build RPC params, including storage config if in standalone mode."""
        params: Dict[str, Any] = {}
        if self._config is not None:
            params['storage'] = self._config.to_dict()
        for k, v in kwargs.items():
            if v is not None:
                params[k] = v
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
        await self._ensure_bridge()
        params = self._build_params(limit=limit, tag=tag)
        response = await self._bridge.call('storage_list_checkpoints', params)
        return [_parse_checkpoint(cp) for cp in response]

    async def get_checkpoint(self, id: str) -> CheckpointInfo:
        """Get checkpoint metadata by ID.

        Args:
            id: Checkpoint ID

        Returns:
            CheckpointInfo with full metadata

        Raises:
            Exception: If checkpoint not found
        """
        await self._ensure_bridge()
        params = self._build_params(id=id)
        response = await self._bridge.call('storage_get_checkpoint', params)
        return _parse_checkpoint(response)  # type: ignore[return-value]

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
        await self._ensure_bridge()
        params = self._build_params(id=id, to=to)
        if not extract:
            params['extract'] = False
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

        Args:
            id: Checkpoint ID or ``"latest"``
            files: Exact file paths to extract (e.g., ``["workspace/data.txt"]``)
            glob: Glob patterns to match (e.g., ``["workspace/*.txt"]``)
            to: Write files to this directory instead of returning in-memory

        Returns:
            Dict mapping file path to content (str for text, bytes for binary)
        """
        await self._ensure_bridge()
        params = self._build_params(id=id, files=files, glob=glob, to=to)
        response = await self._bridge.call('storage_download_files', params)
        return _decode_file_map(response.get('files', {}))

    async def close(self) -> None:
        """Close the storage client and release resources.

        Only needed for standalone clients (created via ``storage()``).
        Bound clients (from ``Evolve.storage()``) are managed by the Evolve instance.
        """
        if self._owns_bridge:
            await self._bridge.stop()

    async def __aenter__(self) -> 'StorageClient':
        await self._ensure_bridge()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()


def _parse_checkpoint(data: Dict[str, Any]) -> CheckpointInfo:
    """Parse checkpoint dict from bridge response into CheckpointInfo."""
    return CheckpointInfo(
        id=data['id'],
        hash=data['hash'],
        tag=data['tag'],
        timestamp=data['timestamp'],
        size_bytes=data.get('size_bytes'),
        agent_type=data.get('agent_type'),
        model=data.get('model'),
        workspace_mode=data.get('workspace_mode'),
        parent_id=data.get('parent_id'),
        comment=data.get('comment'),
    )


def _decode_file_map(encoded: Dict[str, Any]) -> Dict[str, Union[str, bytes]]:
    """Decode base64/text encoded files from bridge transport."""
    decoded: Dict[str, Union[str, bytes]] = {}
    for name, file_data in encoded.items():
        content = file_data['content']
        encoding = file_data.get('encoding')
        if encoding == 'base64':
            decoded[name] = base64.b64decode(content)
        else:
            decoded[name] = content
    return decoded
