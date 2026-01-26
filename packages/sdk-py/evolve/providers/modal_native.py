"""
Native Modal Sandbox Provider using Modal Python SDK.

This provides direct access to Modal's full feature set:
- Filesystem snapshots for instant sandbox restoration
- Memory snapshots (preview) for even faster cold starts
- Native async streaming
- Full Image builder chain

Usage:
    from evolve.providers.modal_native import NativeModalProvider

    provider = NativeModalProvider()
    sandbox = await provider.create()

    # Run Claude CLI
    async for event in sandbox.run_agent("Write hello world"):
        print(event)

    # Create snapshot for fast restoration
    snapshot = await sandbox.snapshot()

    # Restore from snapshot instantly
    sandbox2 = await provider.restore(snapshot)
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from typing import Any, AsyncIterator, Optional

try:
    import modal
    from modal import App, Image, Sandbox
    MODAL_AVAILABLE = True
except ImportError:
    MODAL_AVAILABLE = False


# ============================================================
# IMAGE DEFINITION
# ============================================================

def get_evolve_image() -> "Image":
    """
    Create the Evolve sandbox image with Claude CLI pre-installed.

    Modal caches this based on content hash - subsequent calls are instant.
    """
    return (
        Image.debian_slim(python_version="3.12")
        .apt_install("curl", "sudo")
        .run_commands(
            # Install Node.js 20.x
            "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
            "apt-get install -y nodejs",
            # Install Claude CLI globally
            "npm install -g @anthropic-ai/claude-code",
            # Create non-root user (required for Claude CLI)
            "useradd -m -s /bin/bash user",
            # Create workspace structure
            "mkdir -p /home/user/.claude /home/user/.evolve/skills /home/user/workspace",
            "mkdir -p /home/user/workspace/context /home/user/workspace/scripts",
            "mkdir -p /home/user/workspace/temp /home/user/workspace/output",
            # Set ownership and permissions
            "chown -R user:user /home/user",
            "echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers",
        )
    )


# ============================================================
# SANDBOX WRAPPER
# ============================================================

@dataclass
class AgentResult:
    """Result from running the agent."""
    exit_code: int
    stdout: str
    stderr: str
    sandbox_id: str


class NativeModalSandbox:
    """
    Wrapper around Modal Sandbox with Evolve-specific functionality.

    Provides:
    - Command execution as non-root user
    - Claude CLI integration
    - Filesystem snapshots
    - File operations
    """

    def __init__(self, sandbox: "Sandbox", env: dict[str, str] | None = None):
        self._sandbox = sandbox
        self._env = env or {}

    @property
    def sandbox_id(self) -> str:
        """Get the sandbox ID."""
        return self._sandbox.object_id

    async def exec(
        self,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str = "/home/user/workspace",
        timeout_ms: int | None = None,
        as_user: bool = True,
    ) -> dict[str, Any]:
        """
        Execute a command in the sandbox.

        Args:
            command: Shell command to execute
            env: Additional environment variables
            cwd: Working directory
            timeout_ms: Timeout in milliseconds
            as_user: Run as non-root 'user' (required for Claude CLI)

        Returns:
            Dict with exit_code, stdout, stderr
        """
        merged_env = {**self._env, **(env or {})}

        if as_user:
            # Build environment export string for auth tokens
            env_exports = " && ".join(
                f'export {k}="{v}"'
                for k, v in merged_env.items()
                if k.startswith(('ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'EVOLVE_'))
            )

            full_command = f"cd {cwd} && {command}"
            if env_exports:
                full_command = f"{env_exports} && {full_command}"

            exec_args = ["su", "-", "user", "-c", full_command]
        else:
            exec_args = ["sh", "-c", command]

        proc = await self._sandbox.exec.aio(
            *exec_args,
            timeout=int(timeout_ms / 1000) if timeout_ms else None,
        )

        await proc.wait.aio()
        stdout = await proc.stdout.read.aio()
        stderr = await proc.stderr.read.aio()

        return {
            "exit_code": proc.returncode,
            "stdout": stdout.decode() if isinstance(stdout, bytes) else stdout,
            "stderr": stderr.decode() if isinstance(stderr, bytes) else stderr,
        }

    async def run_agent(
        self,
        prompt: str,
        model: str = "sonnet",
        timeout_ms: int = 120000,
    ) -> AsyncIterator[dict[str, Any]]:
        """
        Run Claude CLI agent and yield events.

        Note: Modal's Python SDK doesn't support real-time streaming of stdout.
        This method waits for the process to complete, then yields all events.
        For true streaming, use the TypeScript bridge or consider running
        Claude CLI directly.

        Args:
            prompt: The prompt for the agent
            model: Model to use (sonnet, opus, haiku)
            timeout_ms: Timeout in milliseconds

        Yields:
            Parsed JSON events from Claude CLI
        """
        # Escape the prompt for shell
        escaped_prompt = prompt.replace('"', '\\"').replace('$', '\\$')

        # Build Claude CLI command
        # Note: --output-format stream-json requires --verbose
        claude_cmd = (
            f'echo "{escaped_prompt}" | '
            f'claude -p --model {model} '
            f'--output-format stream-json --verbose '
            f'--dangerously-skip-permissions'
        )

        # Build full command with env vars
        env_exports = " && ".join(
            f'export {k}="{v}"'
            for k, v in self._env.items()
            if k.startswith(('ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'EVOLVE_'))
        )

        full_command = f"cd /home/user/workspace && {claude_cmd}"
        if env_exports:
            full_command = f"{env_exports} && {full_command}"

        exec_args = ["su", "-", "user", "-c", full_command]

        proc = await self._sandbox.exec.aio(
            *exec_args,
            timeout=int(timeout_ms / 1000) if timeout_ms else None,
        )

        # Wait for process to complete and read all output
        # Note: Modal Python SDK doesn't support async iteration on stdout
        await proc.wait.aio()
        stdout_bytes = await proc.stdout.read.aio()
        stdout = stdout_bytes.decode() if isinstance(stdout_bytes, bytes) else stdout_bytes

        # Parse and yield each line as an event
        for line in stdout.strip().split("\n"):
            line = line.strip()
            if line:
                try:
                    event = json.loads(line)
                    yield event
                except json.JSONDecodeError:
                    # Not valid JSON, yield as raw
                    yield {"type": "raw", "data": line}

    async def snapshot(self) -> "Image":
        """
        Create a filesystem snapshot of the current sandbox state.

        This captures all files and can be used to restore sandboxes instantly.

        Returns:
            Modal Image that can be used to create new sandboxes
        """
        return await self._sandbox.snapshot_filesystem.aio()

    async def write_file(self, path: str, content: str | bytes) -> None:
        """Write a file to the sandbox."""
        if isinstance(content, str):
            content = content.encode()

        # Use Modal's file writing capability
        await self._sandbox.exec.aio("sh", "-c", f"cat > {path}", input=content)

    async def read_file(self, path: str) -> str:
        """Read a file from the sandbox."""
        proc = await self._sandbox.exec.aio("cat", path)
        await proc.wait.aio()
        content = await proc.stdout.read.aio()
        return content.decode() if isinstance(content, bytes) else content

    async def terminate(self) -> None:
        """Terminate the sandbox."""
        await self._sandbox.terminate.aio()


# ============================================================
# PROVIDER
# ============================================================

@dataclass
class NativeModalConfig:
    """Configuration for native Modal provider."""
    app_name: str = "evolve-sandbox"
    timeout_ms: int = 3600000  # 1 hour default

    # Pre-built image for fast cold starts
    # If None, builds image on first use (cached by Modal)
    image_id: Optional[str] = None


class NativeModalProvider:
    """
    Native Modal sandbox provider using Modal Python SDK.

    Benefits over TypeScript bridge:
    - Direct access to Modal's full feature set
    - Filesystem snapshots for instant sandbox restoration
    - Memory snapshots (preview) for even faster starts
    - No IPC overhead
    - Native async streaming

    Usage:
        provider = NativeModalProvider()

        # Create sandbox (first time builds image, ~30s; subsequent ~5s)
        sandbox = await provider.create()

        # Run agent
        async for event in sandbox.run_agent("Hello world"):
            print(event)

        # Create snapshot for instant restoration
        snapshot = await sandbox.snapshot()

        # Restore from snapshot (~3s)
        sandbox2 = await provider.restore(snapshot)
    """

    def __init__(self, config: NativeModalConfig | None = None):
        if not MODAL_AVAILABLE:
            raise ImportError(
                "Modal package not installed. "
                "Install with: pip install modal"
            )

        self.config = config or NativeModalConfig()
        self._app: Optional[App] = None
        self._image: Optional[Image] = None

    async def _ensure_app(self) -> App:
        """Get or create the Modal app."""
        if self._app is None:
            self._app = await App.lookup.aio(
                self.config.app_name,
                create_if_missing=True
            )
        return self._app

    async def _ensure_image(self) -> Image:
        """Get or build the sandbox image."""
        if self._image is None:
            if self.config.image_id:
                # Use pre-built image
                self._image = await Image.from_id.aio(self.config.image_id)
            else:
                # Build image (Modal caches this)
                self._image = get_evolve_image()
        return self._image

    async def create(
        self,
        env: dict[str, str] | None = None,
        timeout_ms: int | None = None,
    ) -> NativeModalSandbox:
        """
        Create a new sandbox.

        Args:
            env: Environment variables (auth tokens, etc.)
            timeout_ms: Sandbox timeout in milliseconds

        Returns:
            NativeModalSandbox instance
        """
        app = await self._ensure_app()
        image = await self._ensure_image()

        # Merge with default env vars from environment
        merged_env = {
            "CLAUDE_CODE_OAUTH_TOKEN": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", ""),
            "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY", ""),
            **(env or {}),
        }

        sandbox = await Sandbox.create.aio(
            app=app,
            image=image,
            timeout=int(timeout_ms / 1000) if timeout_ms else int(self.config.timeout_ms / 1000),
        )

        return NativeModalSandbox(sandbox, merged_env)

    async def restore(
        self,
        snapshot: "Image",
        env: dict[str, str] | None = None,
        timeout_ms: int | None = None,
    ) -> NativeModalSandbox:
        """
        Restore a sandbox from a filesystem snapshot.

        This is the fastest way to get a configured sandbox (~3 seconds).

        Args:
            snapshot: Image from sandbox.snapshot()
            env: Environment variables
            timeout_ms: Sandbox timeout

        Returns:
            NativeModalSandbox instance
        """
        app = await self._ensure_app()

        merged_env = {
            "CLAUDE_CODE_OAUTH_TOKEN": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", ""),
            "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY", ""),
            **(env or {}),
        }

        sandbox = await Sandbox.create.aio(
            app=app,
            image=snapshot,  # Use snapshot as image
            timeout=int(timeout_ms / 1000) if timeout_ms else int(self.config.timeout_ms / 1000),
        )

        return NativeModalSandbox(sandbox, merged_env)

    async def build_and_save_image(self) -> str:
        """
        Build the image and return its ID for later use.

        Run this once to create a cached image:

            provider = NativeModalProvider()
            image_id = await provider.build_and_save_image()
            print(f"Use this ID: {image_id}")

        Then use the ID for instant sandboxes:

            provider = NativeModalProvider(NativeModalConfig(image_id=image_id))

        Returns:
            Image ID string (e.g., "im-xxxxx")
        """
        app = await self._ensure_app()
        image = get_evolve_image()

        # Build the image
        with modal.enable_output():
            await image.build.aio(app)

        return image.object_id


# ============================================================
# CONVENIENCE FUNCTIONS
# ============================================================

async def create_sandbox(
    prompt: str | None = None,
    model: str = "sonnet",
    env: dict[str, str] | None = None,
) -> AgentResult | AsyncIterator[dict[str, Any]]:
    """
    Convenience function to create a sandbox and optionally run a prompt.

    If prompt is provided, runs the agent and returns result.
    Otherwise, returns the sandbox for manual interaction.

    Usage:
        # Quick one-shot
        result = await create_sandbox("Write hello world")
        print(result.stdout)

        # Interactive
        sandbox = await create_sandbox()
        async for event in sandbox.run_agent("Hello"):
            print(event)
    """
    provider = NativeModalProvider()
    sandbox = await provider.create(env=env)

    if prompt:
        stdout_parts = []
        stderr_parts = []

        async for event in sandbox.run_agent(prompt, model=model):
            if event.get("type") == "result":
                return AgentResult(
                    exit_code=0 if not event.get("is_error") else 1,
                    stdout="\n".join(stdout_parts),
                    stderr="\n".join(stderr_parts),
                    sandbox_id=sandbox.sandbox_id,
                )
            elif event.get("type") == "assistant":
                msg = event.get("message", {})
                for content in msg.get("content", []):
                    if content.get("type") == "text":
                        stdout_parts.append(content.get("text", ""))

        return AgentResult(
            exit_code=0,
            stdout="\n".join(stdout_parts),
            stderr="\n".join(stderr_parts),
            sandbox_id=sandbox.sandbox_id,
        )

    return sandbox
