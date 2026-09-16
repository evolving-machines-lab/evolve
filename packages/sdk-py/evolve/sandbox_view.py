"""Read-only view of a running sandbox — files, changes and resource usage.

The Python mirror of the TypeScript provider surface (`provider.inspect()`,
`files.list / stat / readRange / watchDir`, `metrics()`), reached through
the bridge by a handle. Meaning is equal to the TypeScript side: the same
entry shape, the same four event kinds, the same typed refusals.
"""

import base64
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Literal, Optional

from .bridge import BridgeManager


@dataclass
class FileInfo:
    """One filesystem entry, the same shape on every provider.

    Matches the TypeScript SDK's FileInfo (packages/sdk-ts/src/types.ts).

    Attributes:
        name: Entry name
        path: Absolute path
        type: 'file', 'dir', 'symlink' or 'other' (sockets, devices, pipes)
        size: Size in bytes
        mtime: Last modification time, ISO 8601
        mode: Permission bits as four octal digits, e.g. '0644'
        owner: Owner as the sandbox reports it (a name, or a numeric id)
        group: Group as the sandbox reports it
        target: The link's target, only on type 'symlink'
    """
    name: str
    path: str
    type: Literal['file', 'dir', 'symlink', 'other']
    size: int
    mtime: str
    mode: str
    owner: str
    group: str
    target: Optional[str] = None


@dataclass
class FilesystemEvent:
    """One change under a watched directory: an absolute path and one of four kinds."""
    path: str
    type: Literal['create', 'write', 'remove', 'rename']


@dataclass
class SandboxMetrics:
    """One resource-usage sample of a running sandbox.

    Memory and disk are in MiB; `source` names the provider call the numbers
    came from and `sampled_at` is the sample's own timestamp. `disk_used_mb`
    is None where the provider reports no disk figure.
    """
    cpu_pct: float
    mem_used_mb: float
    mem_total_mb: float
    sampled_at: str
    source: str
    disk_used_mb: Optional[float] = None


def _parse_file_info(data: Dict[str, Any]) -> FileInfo:
    return FileInfo(
        name=data['name'],
        path=data['path'],
        type=data['type'],
        size=data['size'],
        mtime=data['mtime'],
        mode=data['mode'],
        owner=data['owner'],
        group=data['group'],
        target=data.get('target'),
    )


class WatchHandle:
    """Stops a directory watch started by `SandboxFiles.watch_dir()`."""

    def __init__(self, bridge: BridgeManager, watch_id: str, on_stop: Callable[[], None]):
        self._bridge = bridge
        self._watch_id = watch_id
        self._on_stop = on_stop
        self._stopped = False

    @property
    def watch_id(self) -> str:
        return self._watch_id

    @property
    def stopped(self) -> bool:
        return self._stopped

    async def stop(self) -> None:
        """Stop delivering events for this watch."""
        if self._stopped:
            return
        self._stopped = True
        self._on_stop()
        await self._bridge.call('sandbox_watch_stop', {'watch_id': self._watch_id})


class SandboxFiles:
    """File observation on a sandbox view: list, stat, byte ranges, changes."""

    def __init__(self, bridge: BridgeManager, handle: str):
        self._bridge = bridge
        self._handle = handle
        # One 'fs' dispatcher per view, registered on first use; active watches
        # are looked up by id, and a stopped one is simply no longer there.
        self._watch_callbacks: Dict[str, Callable[[FilesystemEvent], None]] = {}
        self._dispatching = False

    def _dispatch(self, params: Dict[str, Any]) -> None:
        on_event = self._watch_callbacks.get(params.get('watch_id', ''))
        if on_event is not None:
            on_event(FilesystemEvent(path=params['path'], type=params['event']))

    async def list(self, path: str) -> List[FileInfo]:
        """The entries of a directory (not recursive), each a FileInfo.

        Raises:
            SandboxPathNotFoundError: the directory does not exist
        """
        response = await self._bridge.call('sandbox_files_list', {'handle': self._handle, 'path': path})
        return [_parse_file_info(entry) for entry in response['entries']]

    async def stat(self, path: str) -> FileInfo:
        """The entry at `path` itself; a symlink is reported as a symlink, never followed.

        Raises:
            SandboxPathNotFoundError: the path does not exist
        """
        response = await self._bridge.call('sandbox_files_stat', {'handle': self._handle, 'path': path})
        return _parse_file_info(response['entry'])

    async def read_range(self, path: str, offset: int, length: int) -> bytes:
        """Exactly `length` bytes of a file from `offset`, byte for byte.

        A range that meets the end of the file returns fewer bytes (or none).

        Raises:
            SandboxPathNotFoundError: the file does not exist
        """
        response = await self._bridge.call(
            'sandbox_files_read_range',
            {'handle': self._handle, 'path': path, 'offset': offset, 'length': length},
        )
        return base64.b64decode(response['data_base64'])

    async def watch_dir(
        self,
        path: str,
        on_event: Callable[[FilesystemEvent], None],
        recursive: bool = False,
    ) -> WatchHandle:
        """Report changes under `path` to `on_event` until the handle is stopped.

        Raises:
            SandboxFeatureUnsupportedError: the provider has no watcher (Daytona);
                poll `list()` on the directories you have open instead
        """
        response = await self._bridge.call(
            'sandbox_watch_dir',
            {'handle': self._handle, 'path': path, 'recursive': recursive},
        )
        watch_id = response['watch_id']
        self._watch_callbacks[watch_id] = on_event
        if not self._dispatching:
            self._bridge.on('fs', self._dispatch)
            self._dispatching = True
        return WatchHandle(self._bridge, watch_id, lambda: self._watch_callbacks.pop(watch_id, None))


class SandboxView:
    """A running sandbox, attached for reads only.

    Obtained from `Evolve.inspect_sandbox()`. Attaching never starts a stopped
    sandbox, never resumes a paused one and never extends its lifetime.
    """

    def __init__(self, bridge: BridgeManager, handle: str, sandbox_id: str):
        self._bridge = bridge
        self._handle = handle
        self._sandbox_id = sandbox_id
        self.files = SandboxFiles(bridge, handle)

    @property
    def sandbox_id(self) -> str:
        return self._sandbox_id

    async def metrics(self) -> Optional[SandboxMetrics]:
        """The newest resource-usage sample, or None while the provider has none yet.

        Raises:
            SandboxFeatureUnsupportedError: the provider gives no honest figures (Modal)
        """
        response = await self._bridge.call('sandbox_metrics', {'handle': self._handle})
        data = response.get('metrics')
        if data is None:
            return None
        return SandboxMetrics(
            cpu_pct=data['cpu_pct'],
            mem_used_mb=data['mem_used_mb'],
            mem_total_mb=data['mem_total_mb'],
            sampled_at=data['sampled_at'],
            source=data['source'],
            disk_used_mb=data.get('disk_used_mb'),
        )

    async def close(self) -> None:
        """Release the view: every watch it started stops. The sandbox is untouched."""
        await self._bridge.call('sandbox_release', {'handle': self._handle})

    async def __aenter__(self) -> 'SandboxView':
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.close()
