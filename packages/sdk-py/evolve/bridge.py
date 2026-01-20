"""Node.js bridge subprocess manager for JSON-RPC communication."""

import asyncio
import atexit
import json
import logging
import os
import signal
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


logger = logging.getLogger(__name__)

# Global registry of bridge process PIDs for atexit cleanup
# We store PIDs instead of process objects because asyncio.subprocess.Process
# doesn't have sync wait() - we use os.kill/os.waitpid for cleanup
_bridge_pids: List[int] = []


def _atexit_cleanup():
    """Kill all bridge processes on Python exit."""
    for pid in _bridge_pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            pass  # Process already dead
        try:
            # Non-blocking wait to reap zombie
            os.waitpid(pid, os.WNOHANG)
        except (OSError, ChildProcessError):
            pass
    _bridge_pids.clear()


atexit.register(_atexit_cleanup)


class SandboxNotFoundError(Exception):
    """Raised when sandbox is not found (expired or killed)."""
    pass


class BridgeConnectionError(Exception):
    """Raised when bridge process fails to start or dies unexpectedly."""
    pass


class BridgeBuildError(Exception):
    """Raised when bridge build (npm install/build) fails."""
    pass


class BridgeManager:
    """Manages Node.js subprocess running the JSON-RPC bridge.

    Uses asyncio.create_subprocess_exec for native async I/O.
    This allows proper cancellation and clean shutdown without blocking threads.
    """

    def __init__(self):
        self.process: Optional[asyncio.subprocess.Process] = None
        self.request_id = 0
        self.pending_requests: Dict[int, asyncio.Future] = {}
        # Serialize writes to stdin to avoid interleaved JSON-RPC requests
        self._write_lock = asyncio.Lock()
        # Default RPC timeout to prevent hangs (overridden per-call for long runs)
        self.default_call_timeout_s: float = 120.0
        self.stderr_task: Optional[asyncio.Task] = None
        # Buffers for chunked stdout/stderr events from the bridge.
        # The Node bridge may emit {seq, done} chunks for oversized streams.
        self._stream_buffers: Dict[str, List[str]] = {"stdout": [], "stderr": []}
        self.event_callbacks: Dict[str, List[Callable]] = {
            'stdout': [],     # str data
            'stderr': [],     # str data
            'content': [],    # dict params
        }
        self.reader_task: Optional[asyncio.Task] = None
        self._pid: Optional[int] = None

    async def start(self):
        """Start the Node.js bridge process."""
        if self.process is not None:
            return

        # Find bridge script (bundled version for distribution)
        bridge_dir = Path(__file__).parent.parent / 'bridge'
        bridge_script = bridge_dir / 'dist' / 'bridge.bundle.cjs'

        # Fallback to unbundled version for development
        if not bridge_script.exists():
            bridge_script = bridge_dir / 'dist' / 'bridge.js'

        # Auto-build bridge if missing (turnkey experience)
        if not bridge_script.exists():
            await self._build_bridge(bridge_dir)

        # Start Node.js process with native asyncio subprocess
        self.process = await asyncio.create_subprocess_exec(
            'node', str(bridge_script),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._pid = self.process.pid

        # Register PID for atexit cleanup
        _bridge_pids.append(self._pid)

        # Start reading responses (native async - no blocking threads)
        self.reader_task = asyncio.create_task(self._read_responses())
        # Drain stderr to avoid pipe backpressure
        if self.process.stderr is not None:
            self.stderr_task = asyncio.create_task(self._drain_stderr())

    async def _build_bridge(self, bridge_dir: Path):
        """Build the bridge if missing (first run experience)."""
        import shutil
        import subprocess

        # Check if Node.js and npm are installed
        if not shutil.which('node'):
            raise BridgeBuildError(
                "Bridge build failed: Node.js not found in PATH.\n"
                "Evolve requires Node.js 18+ to run the TypeScript bridge.\n"
                "Install from https://nodejs.org/ or run 'make build-dev' manually from packages/sdk-py/."
            )

        if not shutil.which('npm'):
            raise BridgeBuildError(
                "Bridge build failed: npm not found in PATH.\n"
                "npm is usually installed with Node.js - check your Node.js installation.\n"
                "Alternatively, run 'make build-dev' manually from packages/sdk-py/."
            )

        logger.info("First run: building Node.js bridge...")
        try:
            # Run npm install/build in executor to avoid blocking event loop
            loop = asyncio.get_running_loop()

            # Install dependencies
            await loop.run_in_executor(
                None,
                lambda: subprocess.run(
                    ['npm', 'install'],
                    cwd=bridge_dir,
                    check=True,
                    capture_output=True,
                    text=True
                )
            )

            # Build bridge (dev mode for readable debugging)
            await loop.run_in_executor(
                None,
                lambda: subprocess.run(
                    ['npm', 'run', 'build:dev'],
                    cwd=bridge_dir,
                    check=True,
                    capture_output=True,
                    text=True
                )
            )
            logger.info("Bridge built successfully")
        except subprocess.CalledProcessError as e:
            raise BridgeBuildError(
                f"Bridge build failed during npm execution.\n"
                f"Error: {e.stderr}\n"
                f"Try running 'make build-dev' or 'make build-prod' manually from packages/sdk-py/ to see the full error."
            ) from e

    async def stop(self):
        """Stop the Node.js bridge process."""
        if self.process is None:
            return

        # Note: We intentionally do NOT clear event_callbacks here
        # User-registered callbacks should persist across bridge restarts

        # Remove from atexit registry
        if self._pid and self._pid in _bridge_pids:
            _bridge_pids.remove(self._pid)

        # Cancel reader tasks first (they will exit cleanly now that process is terminating)
        if self.reader_task:
            self.reader_task.cancel()
            try:
                await self.reader_task
            except asyncio.CancelledError:
                pass

        if self.stderr_task:
            self.stderr_task.cancel()
            try:
                await self.stderr_task
            except asyncio.CancelledError:
                pass
            self.stderr_task = None

        # Terminate process
        try:
            self.process.terminate()
            await asyncio.wait_for(self.process.wait(), timeout=5)
        except asyncio.TimeoutError:
            self.process.kill()
            await self.process.wait()

        self.process = None
        self.reader_task = None
        self._pid = None

    def on(self, event_type: str, callback: Callable):
        """Register event callback."""
        if event_type in self.event_callbacks:
            self.event_callbacks[event_type].append(callback)

    async def call(
        self,
        method: str,
        params: Optional[Dict[str, Any]] = None,
        timeout_s: Optional[float] = None,
    ) -> Any:
        """Call a JSON-RPC method and wait for response.

        Args:
            method: JSON-RPC method name
            params: JSON-RPC params dict
            timeout_s: Optional timeout in seconds. If None, uses default_call_timeout_s.
        """
        if self.process is None or self.process.stdin is None:
            raise BridgeConnectionError("Bridge not started. Call start() first.")

        async with self._write_lock:
            self.request_id += 1
            request_id = self.request_id

            request = {
                'jsonrpc': '2.0',
                'method': method,
                'params': params or {},
                'id': request_id,
            }

            # Create future for response
            future: asyncio.Future = asyncio.Future()
            self.pending_requests[request_id] = future

            # Send request (native async write)
            payload = json.dumps(request).encode('utf-8')
            frame = len(payload).to_bytes(4, byteorder='big') + payload
            self.process.stdin.write(frame)
            await self.process.stdin.drain()

        # Wait for response (error handling done in _handle_response)
        timeout = timeout_s if timeout_s is not None else self.default_call_timeout_s
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as e:
            # Drop pending request to avoid leaks; late response will be ignored.
            self.pending_requests.pop(request_id, None)
            raise BridgeConnectionError(
                f"Bridge call timed out after {timeout:.1f}s: {method}"
            ) from e

    async def _read_responses(self):
        """Read framed JSON-RPC messages from bridge stdout.

        Uses native asyncio reads - fully cancellable, no blocking threads.
        """
        if self.process is None or self.process.stdout is None:
            return

        # 50MB cap on incoming frames. This applies to ALL bridge responses including
        # RPC results (run().stdout, get_output_files(), etc.). If a response exceeds
        # 50MB, the bridge connection fails. This is stricter than the TS SDK which
        # has no response size limit. For very large outputs, consider streaming via
        # stdout/stderr events or fetching files individually.
        max_frame_bytes = 50 * 1024 * 1024

        try:
            async def read_exact(n: int) -> Optional[bytes]:
                """Read exactly n bytes from stdout."""
                chunks: List[bytes] = []
                remaining = n
                while remaining > 0:
                    chunk = await self.process.stdout.read(remaining)
                    if not chunk:
                        return None
                    chunks.append(chunk)
                    remaining -= len(chunk)
                return b"".join(chunks)

            while True:
                header = await read_exact(4)
                if not header:
                    break
                length = int.from_bytes(header, byteorder='big')
                if length <= 0 or length > max_frame_bytes:
                    logger.error(f"Invalid frame length from bridge: {length}")
                    break

                payload = await read_exact(length)
                if payload is None:
                    break

                try:
                    text = payload.decode('utf-8')
                    message = json.loads(text)
                except Exception:
                    logger.exception("Failed to parse bridge frame")
                    continue

                if isinstance(message, dict) and message.get('method') == 'event':
                    self._handle_event(message.get('params') or {})
                elif isinstance(message, dict) and 'id' in message:
                    self._handle_response(message)

        except asyncio.CancelledError:
            # Clean cancellation - expected during stop()
            raise
        except Exception as e:
            logger.error(f"Bridge reader died: {e}")
        finally:
            # Fail all pending requests so callers don't hang
            error = BridgeConnectionError("Bridge process terminated unexpectedly")
            for request_id, future in list(self.pending_requests.items()):
                if not future.done():
                    future.set_exception(error)
            self.pending_requests.clear()

    async def _drain_stderr(self):
        """Drain bridge stderr to prevent blocking.

        Uses native asyncio reads - fully cancellable.
        """
        if self.process is None or self.process.stderr is None:
            return
        try:
            while True:
                line = await self.process.stderr.readline()
                if not line:
                    break
                try:
                    text = line.decode("utf-8", errors="ignore").rstrip()
                except Exception:
                    text = str(line).rstrip()
                if text:
                    logger.debug(f"[bridge stderr] {text}")
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.debug(f"Bridge stderr drain died: {e}")

    def _handle_event(self, params: Dict[str, Any]):
        """Handle event notification from bridge."""
        event_type = params.get('type')
        callbacks = self.event_callbacks.get(event_type, [])

        if event_type in ('stdout', 'stderr'):
            data = params.get('data', '')
            seq = params.get('seq')
            done = params.get('done')

            # If chunk metadata is present, reassemble to preserve "NDJSON line" semantics.
            if seq is not None or done is not None:
                buf = self._stream_buffers.setdefault(event_type, [])
                if seq == 0 and buf:
                    # Best-effort flush of previous incomplete sequence.
                    prev = "".join(buf)
                    buf.clear()
                    for callback in callbacks:
                        try:
                            callback(prev)
                        except Exception:
                            logger.exception("Error in %s callback", event_type)

                buf.append(data)
                if done:
                    full = "".join(buf)
                    buf.clear()
                    for callback in callbacks:
                        try:
                            callback(full)
                        except Exception:
                            logger.exception("Error in %s callback", event_type)
                return

            # No chunk metadata → emit directly.
            for callback in callbacks:
                try:
                    callback(data)
                except Exception:
                    logger.exception("Error in %s callback", event_type)
        elif event_type == 'content':
            for callback in callbacks:
                try:
                    callback(params)
                except Exception:
                    logger.exception("Error in content callback")

    def _handle_response(self, message: Dict[str, Any]):
        """Handle JSON-RPC response."""
        request_id = message.get('id')
        if request_id is None or request_id not in self.pending_requests:
            return

        future = self.pending_requests.pop(request_id)

        if 'error' in message:
            error = message['error']
            error_code = error.get('code', -32603)
            error_message = error.get('message', 'Unknown error')

            # Check for NotFoundError (code -32001 or message pattern)
            if error_code == -32001 or 'not found' in error_message.lower():
                future.set_exception(SandboxNotFoundError(error_message))
            else:
                future.set_exception(Exception(error_message))
        else:
            future.set_result(message.get('result'))

    # =========================================================================
    # MULTI-INSTANCE METHODS (for Swarm)
    # =========================================================================

    async def create_instance(
        self,
        instance_id: str,
        params: Dict[str, Any],
        timeout_s: Optional[float] = None,
    ) -> Any:
        """Create a new Evolve instance in the bridge."""
        return await self.call(
            'create_instance',
            {'instance_id': instance_id, **params},
            timeout_s=timeout_s,
        )

    async def run_on_instance(
        self,
        instance_id: str,
        prompt: str,
        timeout_ms: Optional[int] = None,
        call_timeout_s: Optional[float] = None,
    ) -> Any:
        """Run prompt on a specific Evolve instance."""
        params = {'instance_id': instance_id, 'prompt': prompt}
        if timeout_ms is not None:
            params['timeout_ms'] = timeout_ms
        return await self.call('run_on_instance', params, timeout_s=call_timeout_s)

    async def get_output_on_instance(
        self,
        instance_id: str,
        recursive: bool = False,
        timeout_s: Optional[float] = None,
    ) -> Any:
        """Get output files from a specific Evolve instance."""
        return await self.call(
            'get_output_on_instance',
            {'instance_id': instance_id, 'recursive': recursive},
            timeout_s=timeout_s,
        )

    async def kill_instance(
        self,
        instance_id: str,
        timeout_s: Optional[float] = None,
    ) -> Any:
        """Kill and remove a specific Evolve instance."""
        return await self.call(
            'kill_instance',
            {'instance_id': instance_id},
            timeout_s=timeout_s,
        )
