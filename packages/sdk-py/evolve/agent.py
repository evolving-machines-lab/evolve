"""Main Evolve class for Python SDK."""

import asyncio
import base64
import json
from typing import Any, Callable, Dict, List, Literal, Optional, Type, Union

from .bridge import BridgeManager, SandboxNotFoundError
from .config import AgentConfig, ComposioSetup, SandboxProvider, SchemaOptions, StorageConfig, WorkspaceMode
from .results import AgentResponse, CheckpointInfo, ExecuteResult, OutputResult, SessionStatus
from . import composio as composio_helpers
from .schema import is_pydantic_model, is_dataclass, to_json_schema, validate_and_parse
from .utils import _encode_files_for_transport, _filter_none


class Evolve:
    """Evolve agent orchestrator.

    Provides a Pythonic interface to the TypeScript Evolve SDK via JSON-RPC bridge.

    Example:
        >>> from evolve import Evolve
        >>>
        >>> # Minimal usage - uses EVOLVE_API_KEY and E2B_API_KEY env vars
        >>> async with Evolve() as evolve:
        ...     result = await evolve.run(prompt='Analyze data.csv')
        ...     output = await evolve.get_output_files()
        ...     for name, content in output.files.items():
        ...         print(f'{name}: {len(content)} bytes')
        >>>
        >>> # Or with explicit config (E2B)
        >>> from evolve import AgentConfig, E2BProvider
        >>> evolve = Evolve(
        ...     config=AgentConfig(type='codex', api_key='sk-...'),
        ...     sandbox=E2BProvider(api_key='...')
        ... )
        >>>
        >>> # Or with Daytona
        >>> from evolve import DaytonaProvider
        >>> evolve = Evolve(sandbox=DaytonaProvider(api_key='...'))
        >>> # Or with Modal
        >>> from evolve import ModalProvider
        >>> evolve = Evolve(sandbox=ModalProvider())
    """

    # Static helpers for Composio pre-auth flows (no instance required)
    composio = composio_helpers

    def __init__(
        self,
        config: Optional[AgentConfig] = None,
        sandbox: Optional[SandboxProvider] = None,
        working_directory: str = '/home/user/workspace',
        workspace_mode: WorkspaceMode = 'knowledge',
        system_prompt: Optional[str] = None,
        context: Optional[Dict[str, Union[str, bytes]]] = None,
        files: Optional[Dict[str, Union[str, bytes]]] = None,
        mcp_servers: Optional[Dict[str, Any]] = None,
        skills: Optional[List[str]] = None,
        secrets: Optional[Dict[str, str]] = None,
        sandbox_id: Optional[str] = None,
        session_tag_prefix: Optional[str] = None,
        schema: Optional[Union[Type, Dict[str, Any]]] = None,
        schema_options: Optional[SchemaOptions] = None,
        composio: Optional[ComposioSetup] = None,
        storage: Optional[StorageConfig] = None,
    ):
        """Initialize Evolve.

        Args:
            config: Agent configuration (optional - defaults to EVOLVE_API_KEY env var with 'claude' type)
            sandbox: Sandbox provider (optional - auto-resolves from env vars:
                     E2B_API_KEY → E2B direct, DAYTONA_API_KEY → Daytona direct,
                     MODAL_TOKEN_ID+MODAL_TOKEN_SECRET → Modal direct,
                     EVOLVE_API_KEY → E2B via gateway. User sandbox keys take priority.)
            working_directory: Working directory in sandbox (default: /home/user/workspace)
            workspace_mode: Workspace setup mode - 'knowledge' (creates output/context/scripts/temp folders + default prompt)
                          or 'swe' (clean workspace for cloned repos) (default: 'knowledge')
            system_prompt: Custom system prompt (appended to default in 'knowledge' mode, sole prompt in 'swe' mode)
            context: Files to upload to context/ folder on first run - { "filename.txt": "content" }
            files: Files to upload to working directory on first run - { "scripts/run.sh": "content" }
            mcp_servers: MCP server configurations
            skills: Skills to enable (e.g., ['pdf', 'dev-browser'])
            secrets: Environment variables for sandbox
            sandbox_id: Existing sandbox ID to reconnect to
            session_tag_prefix: Optional semantic label for observability log files (e.g., 'experiment-7')
            schema: Schema for structured output - Pydantic model, dataclass, or JSON Schema dict
            schema_options: Validation options (mode: 'strict' or 'loose', default: 'loose')
            composio: Composio Tool Router setup for 500+ external service integrations
            storage: Storage configuration for checkpoint persistence (BYOK S3 or gateway mode)
        """
        self.config = config
        self.sandbox = sandbox
        self.working_directory = working_directory
        self.workspace_mode = workspace_mode
        self.system_prompt = system_prompt
        self.context = context
        self.files = files
        self.mcp_servers = mcp_servers
        self.skills = skills
        self.secrets = secrets
        self.sandbox_id = sandbox_id
        self.session_tag_prefix = session_tag_prefix
        self.schema_options = schema_options or SchemaOptions()
        self._composio = composio
        self.storage = storage

        # Schema handling: store original + convert to JSON Schema
        self._schema = schema
        self._schema_json = to_json_schema(schema)

        self.bridge = BridgeManager()
        self._initialized = False
        self._init_lock = asyncio.Lock()

    async def _ensure_initialized(self):
        """Ensure bridge is started and agent is initialized."""
        async with self._init_lock:
            if self._initialized:
                return

            await self.bridge.start()

            # Build params with _filter_none to exclude None values
            # TS SDK resolves defaults from env vars when not provided
            params = _filter_none({
                # Agent config (optional - TS SDK resolves from env vars)
                'agent_type': self.config.type if self.config else None,
                'api_key': self.config.api_key if self.config else None,
                'provider_api_key': self.config.provider_api_key if self.config else None,
                'oauth_token': self.config.oauth_token if self.config else None,
                'provider_base_url': self.config.provider_base_url if self.config else None,
                'model': self.config.model if self.config else None,
                'reasoning_effort': self.config.reasoning_effort if self.config else None,
                # Sandbox (optional - TS SDK auto-resolves from EVOLVE_API_KEY/E2B_API_KEY/DAYTONA_API_KEY)
                'sandbox_provider': {'type': self.sandbox.type, 'config': self.sandbox.config} if self.sandbox else None,
                # Other settings
                'working_directory': self.working_directory,
                'workspace_mode': self.workspace_mode,
                'system_prompt': self.system_prompt,
                'context': _encode_files_for_transport(self.context) if self.context else None,
                'files': _encode_files_for_transport(self.files) if self.files else None,
                'mcp_servers': self.mcp_servers,
                'skills': self.skills,
                'secrets': self.secrets,
                'sandbox_id': self.sandbox_id,
                'session_tag_prefix': self.session_tag_prefix,
                'schema': self._schema_json,
                'schema_options': {'mode': self.schema_options.mode} if self._schema_json else None,
                # Composio Tool Router
                'composio': self._composio.to_dict() if self._composio else None,
                # Storage / Checkpointing
                'storage': self.storage.to_dict() if self.storage else None,
                # Always forward events
                'forward_stdout': True,
                'forward_stderr': True,
                'forward_content': True,
                'forward_lifecycle': True,
            })

            await self.bridge.call('initialize', params, timeout_s=self._get_rpc_timeout_s(None))
            self._initialized = True

    def on(
        self,
        event_type: Literal['stdout', 'stderr', 'content', 'lifecycle'],
        callback: Callable[[Any], None]
    ):
        """Register event callback.

        Args:
            event_type: Event type ('stdout' | 'stderr' | 'content' | 'lifecycle')
            callback: Callback function invoked with the event payload
                      (str for stdout/stderr, dict for content/lifecycle)

        Example:
            >>> evolve.on('stdout', lambda data: print(data, end=''))
            >>> evolve.on('stderr', lambda data: print(f'[ERR] {data}', end=''))
            >>> evolve.on('content', lambda event: print(event['update']['sessionUpdate']))
            >>> evolve.on('lifecycle', lambda event: print(event['reason']))
        """
        self.bridge.on(event_type, callback)

    def _get_rpc_timeout_s(self, timeout_ms: Optional[int]) -> float:
        """Compute an RPC timeout aligned with sandbox execution timeout."""
        if timeout_ms is None:
            timeout_ms = getattr(self.sandbox, "timeout_ms", 3600000) if self.sandbox else 3600000
        # Add small grace to allow bridge/agent cleanup after sandbox timeout.
        return timeout_ms / 1000.0 + 30.0

    async def run(
        self,
        prompt: str,
        timeout_ms: Optional[int] = None,
        background: bool = False,
        from_checkpoint: Optional[str] = None,
        checkpoint_comment: Optional[str] = None,
    ) -> AgentResponse:
        """Run AI-assisted task (agent decides and acts).

        Args:
            prompt: Task description
            timeout_ms: Optional timeout in milliseconds (default: 1 hour)
            background: Run in background (default: False). If True, returns
                       immediately with a handshake response (`exit_code=0`).
                       Final completion is delivered asynchronously via
                       lifecycle events or status polling.
            from_checkpoint: Restore from checkpoint ID before running (requires storage).
                           Use 'latest' to restore the most recent checkpoint.
            checkpoint_comment: Optional label for the auto-checkpoint after this run

        Returns:
            AgentResponse with sandbox_id, exit_code, stdout, stderr, checkpoint

        Example:
            >>> result = await evolve.run(prompt='Analyze data and create report', timeout_ms=600000)
            >>> # Background execution
            >>> result = await evolve.run(prompt='Long task', background=True)
            >>> # Restore from checkpoint
            >>> result = await evolve.run(prompt='Continue work', from_checkpoint='latest')
        """
        await self._ensure_initialized()

        params: Dict[str, Any] = {
            'prompt': prompt,
        }
        if timeout_ms is not None:
            params['timeout_ms'] = timeout_ms
        if background:
            params['background'] = background
        if from_checkpoint is not None:
            params['from'] = from_checkpoint
        if checkpoint_comment is not None:
            params['checkpoint_comment'] = checkpoint_comment

        response = await self.bridge.call(
            'run',
            params,
            timeout_s=self._get_rpc_timeout_s(timeout_ms),
        )

        return AgentResponse(
            sandbox_id=response['sandbox_id'],
            exit_code=response['exit_code'],
            stdout=response['stdout'],
            stderr=response['stderr'],
            checkpoint=self._parse_checkpoint(response.get('checkpoint')),
        )

    async def execute_command(
        self,
        command: str,
        timeout_ms: Optional[int] = None,
        background: bool = False,
        cwd: Optional[str] = None,
        envs: Optional[Dict[str, str]] = None,
        user: Optional[str] = None,
    ) -> AgentResponse:
        """Execute direct shell command.

        Args:
            command: Shell command to execute
            timeout_ms: Optional timeout in milliseconds (default: 1 hour)
            background: Run in background (default: False). If True, returns
                       immediately with a handshake response (`exit_code=0`).
                       Final completion is delivered via lifecycle events.
            cwd: Working directory for the command (default: working_directory from init)
            envs: Environment variables to set for this command
            user: User to run the command as (e.g., 'root')

        Returns:
            AgentResponse with sandbox_id, exit_code, stdout, stderr

        Example:
            >>> result = await evolve.execute_command(command='python script.py')
            >>> result = await evolve.execute_command('ls', cwd='/tmp', user='root')
            >>> result = await evolve.execute_command('echo $MY_VAR', envs={'MY_VAR': 'hello'})
        """
        await self._ensure_initialized()

        params: Dict[str, Any] = {
            'command': command,
            'timeout_ms': timeout_ms,
            'background': background,
        }
        if cwd is not None:
            params['cwd'] = cwd
        if envs is not None:
            params['envs'] = envs
        if user is not None:
            params['user'] = user

        response = await self.bridge.call(
            'execute_command',
            params,
            timeout_s=self._get_rpc_timeout_s(timeout_ms),
        )

        return AgentResponse(
            sandbox_id=response['sandbox_id'],
            exit_code=response['exit_code'],
            stdout=response['stdout'],
            stderr=response['stderr'],
        )

    async def upload_context(
        self,
        files: Dict[str, Union[str, bytes]],
    ):
        """Upload files to context/ folder (runtime - immediate upload).

        Args:
            files: Dict mapping filename to content - { "filename.txt": "content", "data.json": jsonStr }

        Example:
            >>> await evolve.upload_context({
            ...     'spec.json': json.dumps(spec),
            ...     'readme.txt': 'Project documentation...',
            ... })
        """
        await self._ensure_initialized()
        await self.bridge.call('upload_context', {
            'files': _encode_files_for_transport(files),
        }, timeout_s=self._get_rpc_timeout_s(None))

    async def upload_files(
        self,
        files: Dict[str, Union[str, bytes]],
    ):
        """Upload files to working directory (runtime - immediate upload).

        Args:
            files: Dict mapping path to content - { "scripts/run.sh": "#!/bin/bash...", "data/input.csv": csvData }

        Example:
            >>> await evolve.upload_files({
            ...     'scripts/setup.sh': '#!/bin/bash\\necho hello',
            ...     'temp/cache.json': json.dumps(cache),
            ... })
        """
        await self._ensure_initialized()
        await self.bridge.call('upload_files', {
            'files': _encode_files_for_transport(files),
        }, timeout_s=self._get_rpc_timeout_s(None))

    async def upload_dir(
        self,
        local_path: str,
        remote_path: Optional[str] = None,
        recursive: bool = True,
    ):
        """Upload a local directory to the sandbox.

        Reads all files from a local directory and uploads them to the sandbox.
        Supports both relative (to working_directory) and absolute remote paths.

        Args:
            local_path: Local directory path to upload
            remote_path: Remote directory path (default: working_directory).
                        Use absolute path (e.g., '/tests') for exact placement.
            recursive: Include subdirectories (default: True)

        Example:
            >>> await evolve.upload_dir('./my-tests', '/tests')
            >>> await evolve.upload_dir('./data', 'data/')  # relative to working_directory
        """
        from .utils import read_local_dir
        local_files = read_local_dir(local_path, recursive=recursive)

        # Map local relative paths to remote absolute/relative paths
        files_to_upload: Dict[str, Union[str, bytes]] = {}
        for rel_path, content in local_files.items():
            if remote_path:
                if remote_path.startswith('/'):
                    files_to_upload[f"{remote_path}/{rel_path}"] = content
                else:
                    files_to_upload[f"{remote_path}/{rel_path}"] = content
            else:
                files_to_upload[rel_path] = content

        if files_to_upload:
            await self.upload_files(files_to_upload)

    async def download_dir(
        self,
        remote_path: str,
        local_path: str,
        recursive: bool = True,
    ):
        """Download a directory from the sandbox to a local path.

        Args:
            remote_path: Absolute path in sandbox to download
            local_path: Local directory to save files to
            recursive: Include subdirectories (default: True)

        Example:
            >>> await evolve.download_dir('/app/output', './results')
        """
        await self._ensure_initialized()

        response = await self.bridge.call('download_dir', {
            'path': remote_path,
            'recursive': recursive,
        }, timeout_s=self._get_rpc_timeout_s(None))

        # Decode files from transport encoding
        files: Dict[str, Union[str, bytes]] = {}
        for name, file_data in response.get('files', {}).items():
            content = file_data['content']
            encoding = file_data.get('encoding')
            if encoding == 'base64':
                content = base64.b64decode(content)
            files[name] = content

        # Save to local directory
        from .utils import save_local_dir
        save_local_dir(local_path, files)

    async def read_file(self, path: str) -> bytes:
        """Read a single file from the sandbox.

        Args:
            path: Absolute path in sandbox

        Returns:
            File content as bytes

        Example:
            >>> content = await evolve.read_file('/app/output/result.json')
            >>> data = json.loads(content)
        """
        await self._ensure_initialized()

        response = await self.bridge.call('read_file', {
            'path': path,
        }, timeout_s=self._get_rpc_timeout_s(None))

        content = response['content']
        if response.get('encoding') == 'base64':
            return base64.b64decode(content)
        return content.encode('utf-8') if isinstance(content, str) else content

    async def get_output_files(self, recursive: bool = False) -> OutputResult:
        """Get output files with optional schema validation result.

        Returns files modified after the last run() call, along with schema
        validation results if a schema was configured.

        Matches TypeScript SDK's getOutputFiles() for exact parity.
        Evidence: sdk-ts/src/types.ts OutputResult<T> interface

        Args:
            recursive: Include files in subdirectories (default: False)

        Returns:
            OutputResult containing:
                - files: Dict mapping filename/path to content (str for text, bytes for binary)
                - data: Parsed and validated result.json data (None if no schema or validation failed)
                - error: Validation or parse error message, if any
                - raw_data: Raw result.json string when parse or validation failed

        Example:
            >>> output = await evolve.get_output_files()
            >>> for name, content in output.files.items():
            ...     with open(f'./downloads/{name}', 'wb') as f:
            ...         f.write(content if isinstance(content, bytes) else content.encode())
            >>> if output.data:
            ...     print(f"Validated data: {output.data}")
            >>> if output.error:
            ...     print(f"Validation error: {output.error}")
        """
        await self._ensure_initialized()

        response = await self.bridge.call('get_output_files', {'recursive': recursive}, timeout_s=self._get_rpc_timeout_s(None))

        # Decode files from transport encoding
        files: Dict[str, Union[str, bytes]] = {}
        for name, file_data in response.get('files', {}).items():
            content = file_data['content']
            encoding = file_data.get('encoding')
            if encoding == 'base64':
                content = base64.b64decode(content)
            files[name] = content

        data = None
        error = None
        raw_data = None

        # CASE 1: Pydantic model or dataclass → Native Python validation
        if is_pydantic_model(self._schema) or is_dataclass(self._schema):
            raw_json = files.get('result.json')
            if raw_json is None:
                error = "Schema provided but agent did not create output/result.json"
            else:
                if isinstance(raw_json, bytes):
                    raw_json = raw_json.decode('utf-8')

                try:
                    strict = self.schema_options.mode == 'strict'
                    data = validate_and_parse(raw_json, self._schema, strict=strict)
                except Exception as e:
                    error = f"Schema validation failed: {e}"
                    raw_data = raw_json

        # CASE 2: JSON Schema dict → Use TS validation (backward compatible)
        elif self._schema_json is not None:
            data = response.get('data')
            error = response.get('error')
            raw_data = response.get('raw_data')

        # CASE 3: No schema → Just return files (data stays None)

        return OutputResult(
            files=files,
            data=data,
            error=error,
            raw_data=raw_data,
        )

    # =========================================================================
    # STORAGE / CHECKPOINTING
    # =========================================================================

    async def checkpoint(self, comment: Optional[str] = None) -> CheckpointInfo:
        """Create an explicit checkpoint of the current sandbox state.

        Requires a prior run() call (needs an active sandbox to snapshot).

        Args:
            comment: Optional label for this checkpoint

        Returns:
            CheckpointInfo with id, hash, tag, timestamp, etc.

        Example:
            >>> info = await evolve.checkpoint(comment='before refactor')
            >>> print(f'Checkpoint: {info.id}')
        """
        await self._ensure_initialized()
        params: Dict[str, Any] = {}
        if comment is not None:
            params['comment'] = comment
        response = await self.bridge.call('checkpoint', params, timeout_s=self._get_rpc_timeout_s(None))
        return self._parse_checkpoint(response)  # type: ignore[return-value]

    async def list_checkpoints(
        self,
        limit: Optional[int] = None,
        tag: Optional[str] = None,
    ) -> List[CheckpointInfo]:
        """List checkpoints (requires storage configuration).

        Does not require a running sandbox — only storage configuration.

        Args:
            limit: Maximum number of checkpoints to return
            tag: Filter by session tag

        Returns:
            List of CheckpointInfo sorted by newest first

        Example:
            >>> checkpoints = await evolve.list_checkpoints(limit=5)
            >>> for cp in checkpoints:
            ...     print(f'{cp.id} ({cp.comment})')
        """
        await self._ensure_initialized()
        params: Dict[str, Any] = {}
        if limit is not None:
            params['limit'] = limit
        if tag is not None:
            params['tag'] = tag
        response = await self.bridge.call('list_checkpoints', params, timeout_s=self._get_rpc_timeout_s(None))
        return [self._parse_checkpoint(cp) for cp in response]  # type: ignore[misc]

    @staticmethod
    def _parse_checkpoint(data: Optional[Dict[str, Any]]) -> Optional[CheckpointInfo]:
        """Parse checkpoint dict from bridge response into CheckpointInfo."""
        if not data:
            return None
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

    async def get_session(self) -> Optional[str]:
        """Get sandbox ID for reuse.

        Returns:
            Sandbox ID or None if not initialized

        Example:
            >>> sandbox_id = await evolve.get_session()
            >>> print(f'Sandbox ID: {sandbox_id}')
        """
        await self._ensure_initialized()
        return await self.bridge.call('get_session')

    async def set_session(self, session_id: str):
        """Change sandbox session.

        Args:
            session_id: New sandbox ID to connect to

        Example:
            >>> await evolve.set_session('existing-sandbox-id')
        """
        await self._ensure_initialized()
        await self.bridge.call('set_session', {
            'session_id': session_id,
        })

    async def pause(self):
        """Pause sandbox to save costs while preserving state.

        Example:
            >>> await evolve.pause()
        """
        await self._ensure_initialized()
        await self.bridge.call('pause')

    async def interrupt(self) -> bool:
        """Interrupt active process without killing the sandbox.

        Returns:
            True if an active process was interrupted; False otherwise.
        """
        await self._ensure_initialized()
        interrupted = await self.bridge.call('interrupt')
        return bool(interrupted)

    async def status(self) -> SessionStatus:
        """Get runtime status snapshot for sandbox and agent."""
        await self._ensure_initialized()
        response = await self.bridge.call('status')
        return SessionStatus(
            sandbox_id=response.get('sandbox_id'),
            sandbox=response.get('sandbox', 'stopped'),
            agent=response.get('agent', 'idle'),
            active_process_id=response.get('active_process_id'),
            has_run=bool(response.get('has_run', False)),
            timestamp=response.get('timestamp', ''),
        )

    async def resume(self):
        """Resume paused sandbox.

        Example:
            >>> await evolve.resume()
        """
        await self._ensure_initialized()
        await self.bridge.call('resume')

    async def kill(self):
        """Terminate sandbox and release all resources.

        Example:
            >>> await evolve.kill()
        """
        await self._ensure_initialized()
        try:
            await self.bridge.call('kill')
        finally:
            # Always stop bridge even if RPC fails (e.g., sandbox already gone)
            await self.bridge.stop()
            self._initialized = False

    async def get_host(self, port: int) -> str:
        """Get public URL for sandbox port.

        Args:
            port: Port number to expose

        Returns:
            Public URL for the port

        Example:
            >>> url = await evolve.get_host(8000)
            >>> print(f'Server available at: {url}')
        """
        await self._ensure_initialized()
        response = await self.bridge.call('get_host', {
            'port': port,
        })
        return response['url']

    async def get_session_tag(self) -> Optional[str]:
        """Get the observability session tag.

        Returns the generated tag (e.g., 'my-prefix-a3f8b2c1') used for the
        log file in ~/.evolve/observability/sessions/

        Returns:
            Session tag or None if not initialized

        Example:
            >>> tag = await evolve.get_session_tag()
            >>> print(f'Log file tag: {tag}')
            'experiment-7-a3f8b2c1'
        """
        await self._ensure_initialized()
        return await self.bridge.call('get_session_tag')

    async def get_session_timestamp(self) -> Optional[str]:
        """Get the session start timestamp (ISO format).

        Returns:
            ISO timestamp when session was created or None if not initialized

        Example:
            >>> timestamp = await evolve.get_session_timestamp()
            >>> print(f'Session started: {timestamp}')
            '2025-01-15T10:30:45.123Z'
        """
        await self._ensure_initialized()
        return await self.bridge.call('get_session_timestamp')

    async def __aenter__(self):
        """Context manager entry."""
        try:
            await self._ensure_initialized()
            return self
        except Exception:
            # Cleanup bridge process if initialization fails
            await self.bridge.stop()
            raise

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - cleanup resources."""
        try:
            await self.kill()
        except Exception as e:
            import warnings
            warnings.warn(f"Error during cleanup: {e}", RuntimeWarning)
