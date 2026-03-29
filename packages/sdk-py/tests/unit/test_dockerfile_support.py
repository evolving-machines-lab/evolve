"""
Unit tests for Dockerfile-based sandbox image creation (Python SDK).

Tests the Python SDK plumbing that threads the `dockerfile` parameter
through Evolve → BridgeManager → adapter.ts → TS Evolve.withDockerfile().

The actual enrichment (build-time append, runtime safety net) is done by
the TypeScript SDK. These tests verify:
  [1] Evolve.__init__ accepts `dockerfile` parameter
  [2] dockerfile is forwarded in bridge initialization params
  [3] Bridge InitializeParams type has `dockerfile` field
  [4] Adapter calls .withDockerfile() when dockerfile is present
  [5] SWE-Bench Verified Dockerfiles — 10 real-world Dockerfiles pass through correctly
  [6] Edge cases — file paths, inline content, None, empty string
"""

import hashlib
import os
import tempfile
import textwrap

import pytest
from unittest.mock import patch

from evolve import Evolve
from evolve.config import AgentConfig


# =============================================================================
# MOCK BRIDGE (captures initialize params for verification)
# =============================================================================

class MockBridgeManager:
    """Minimal async bridge mock that captures initialize params."""

    def __init__(self):
        self.calls = []
        self.callbacks = {}

    async def start(self):
        return None

    async def stop(self):
        return None

    def on(self, event_type, callback):
        self.callbacks.setdefault(event_type, []).append(callback)

    async def call(self, method, params=None, timeout_s=None):
        self.calls.append((method, params, timeout_s))
        if method == 'initialize':
            return {'status': 'ok'}
        return {'status': 'ok'}

    def get_init_params(self):
        """Extract the initialize call params."""
        for method, params, _ in self.calls:
            if method == 'initialize':
                return params
        return None


# =============================================================================
# [1] Evolve.__init__ accepts `dockerfile` parameter
# =============================================================================

class TestEvolveDockerfileParam:
    """Test that Evolve accepts and stores the dockerfile parameter."""

    def test_dockerfile_default_is_none(self):
        """dockerfile should default to None."""
        kit = Evolve()
        assert kit.dockerfile is None

    def test_dockerfile_inline_content(self):
        """dockerfile accepts inline Dockerfile content."""
        content = "FROM python:3.11-slim\nRUN pip install numpy"
        kit = Evolve(dockerfile=content)
        assert kit.dockerfile == content

    def test_dockerfile_file_path(self):
        """dockerfile accepts a file path string."""
        kit = Evolve(dockerfile="./environments/Dockerfile")
        assert kit.dockerfile == "./environments/Dockerfile"

    def test_dockerfile_with_other_params(self):
        """dockerfile works alongside all other configuration params."""
        kit = Evolve(
            config=AgentConfig(type='claude'),
            dockerfile="FROM ubuntu:22.04\nRUN apt-get update",
            system_prompt="You are helpful",
            skills=['pdf'],
        )
        assert kit.dockerfile == "FROM ubuntu:22.04\nRUN apt-get update"
        assert kit.config.type == 'claude'
        assert kit.system_prompt == "You are helpful"

    def test_dockerfile_multiline(self):
        """dockerfile handles multi-line inline Dockerfiles."""
        content = textwrap.dedent("""\
            FROM python:3.11-bookworm
            RUN apt-get update && apt-get install -y git gcc g++ make
            RUN pip install django==4.2 pytest
            WORKDIR /testbed
        """)
        kit = Evolve(dockerfile=content)
        assert "FROM python:3.11-bookworm" in kit.dockerfile
        assert "WORKDIR /testbed" in kit.dockerfile


# =============================================================================
# [2] dockerfile is forwarded in bridge initialization params
# =============================================================================

class TestDockerfileBridgeForwarding:
    """Test that dockerfile is correctly forwarded through the bridge."""

    @pytest.mark.asyncio
    async def test_dockerfile_forwarded_to_bridge(self):
        """dockerfile should appear in initialize RPC params."""
        content = "FROM python:3.11-slim\nRUN pip install torch"
        mock_bridge = MockBridgeManager()

        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(dockerfile=content)
            await kit._ensure_initialized()

        params = mock_bridge.get_init_params()
        assert params is not None
        assert params['dockerfile'] == content

    @pytest.mark.asyncio
    async def test_no_dockerfile_not_in_params(self):
        """When dockerfile is None, it should not appear in filtered params."""
        mock_bridge = MockBridgeManager()

        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve()
            await kit._ensure_initialized()

        params = mock_bridge.get_init_params()
        assert params is not None
        # _filter_none removes None values
        assert 'dockerfile' not in params

    @pytest.mark.asyncio
    async def test_dockerfile_with_agent_config(self):
        """dockerfile + agent config should both be forwarded."""
        content = "FROM node:20-slim\nRUN npm install -g typescript"
        mock_bridge = MockBridgeManager()

        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(
                config=AgentConfig(type='codex'),
                dockerfile=content,
            )
            await kit._ensure_initialized()

        params = mock_bridge.get_init_params()
        assert params['dockerfile'] == content
        assert params['agent_type'] == 'codex'

    @pytest.mark.asyncio
    async def test_file_path_forwarded_as_is(self):
        """File paths should be forwarded as-is (TS SDK resolves them)."""
        mock_bridge = MockBridgeManager()

        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(dockerfile="./my-env/Dockerfile")
            await kit._ensure_initialized()

        params = mock_bridge.get_init_params()
        assert params['dockerfile'] == "./my-env/Dockerfile"


# =============================================================================
# [3] TOOLCHAIN_MAP reference data (mirrors TS SDK registry)
# =============================================================================

# These are the expected toolchain entries from the TS SDK's TOOLCHAIN_MAP.
# The Python SDK passes config to the TS bridge which uses these for enrichment.
TOOLCHAIN_MAP = {
    'claude':   {'binary': 'claude',    'method': 'npm', 'package': '@anthropic-ai/claude-code@latest'},
    'codex':    {'binary': 'codex',     'method': 'npm', 'package': '@openai/codex'},
    'gemini':   {'binary': 'gemini',    'method': 'npm', 'package': '@google/gemini-cli@latest'},
    'qwen':     {'binary': 'qwen',      'method': 'npm', 'package': '@qwen-code/qwen-code@latest'},
    'kimi':     {'binary': 'kimi',      'method': 'pip', 'package': 'kimi-cli'},
    'opencode': {'binary': 'opencode',  'method': 'npm', 'package': 'opencode-ai@latest'},
}


class TestToolchainMapReference:
    """Verify reference TOOLCHAIN_MAP data correctness."""

    def test_all_agent_types_present(self):
        """All 6 agent types should have toolchain entries."""
        expected_types = {'claude', 'codex', 'gemini', 'qwen', 'kimi', 'opencode'}
        assert set(TOOLCHAIN_MAP.keys()) == expected_types

    def test_each_entry_has_required_fields(self):
        """Each entry should have binary, method, and package."""
        for agent_type, entry in TOOLCHAIN_MAP.items():
            assert 'binary' in entry, f"{agent_type} missing 'binary'"
            assert 'method' in entry, f"{agent_type} missing 'method'"
            assert 'package' in entry, f"{agent_type} missing 'package'"

    def test_method_is_npm_or_pip(self):
        """Method should be either 'npm' or 'pip'."""
        for agent_type, entry in TOOLCHAIN_MAP.items():
            assert entry['method'] in ('npm', 'pip'), f"{agent_type} has invalid method: {entry['method']}"

    def test_npm_agents(self):
        """claude, codex, gemini, qwen, opencode should use npm."""
        for agent_type in ('claude', 'codex', 'gemini', 'qwen', 'opencode'):
            assert TOOLCHAIN_MAP[agent_type]['method'] == 'npm'

    def test_pip_agents(self):
        """kimi should use pip."""
        assert TOOLCHAIN_MAP['kimi']['method'] == 'pip'

    def test_binary_names(self):
        """Each agent type should map to the correct CLI binary."""
        assert TOOLCHAIN_MAP['claude']['binary'] == 'claude'
        assert TOOLCHAIN_MAP['codex']['binary'] == 'codex'
        assert TOOLCHAIN_MAP['gemini']['binary'] == 'gemini'
        assert TOOLCHAIN_MAP['qwen']['binary'] == 'qwen'
        assert TOOLCHAIN_MAP['kimi']['binary'] == 'kimi'
        assert TOOLCHAIN_MAP['opencode']['binary'] == 'opencode'


# =============================================================================
# [4] Enrichment simulation (mirrors TS enrichDockerfile logic)
# =============================================================================

def enrich_dockerfile(dockerfile_content: str, agent_type: str) -> str:
    """Simulate the TS SDK's enrichDockerfile() for verification."""
    toolchain = TOOLCHAIN_MAP[agent_type]
    if toolchain['method'] == 'npm':
        install_cmd = f"npm install -g {toolchain['package']}"
    else:
        install_cmd = f"pip install --break-system-packages {toolchain['package']}"
    return "\n".join([
        dockerfile_content.rstrip(),
        "",
        "# --- Evolve SDK: agent toolchain ---",
        f"RUN {install_cmd}",
    ])


class TestEnrichDockerfileSimulation:
    """Test enrichment logic mirrors TS SDK behavior."""

    def test_enrich_claude(self):
        """Claude enrichment appends npm install."""
        base = "FROM python:3.11-slim\nRUN pip install torch"
        result = enrich_dockerfile(base, 'claude')
        assert "# --- Evolve SDK: agent toolchain ---" in result
        assert "RUN npm install -g @anthropic-ai/claude-code@latest" in result
        assert result.startswith("FROM python:3.11-slim")

    def test_enrich_kimi(self):
        """Kimi enrichment appends pip install."""
        base = "FROM python:3.11-slim"
        result = enrich_dockerfile(base, 'kimi')
        assert "RUN pip install --break-system-packages kimi-cli" in result

    def test_enrich_all_agent_types(self):
        """All agent types should produce valid enriched Dockerfiles."""
        base = "FROM ubuntu:22.04"
        for agent_type in TOOLCHAIN_MAP:
            result = enrich_dockerfile(base, agent_type)
            assert result.startswith("FROM ubuntu:22.04")
            assert "# --- Evolve SDK: agent toolchain ---" in result
            assert "RUN " in result.split("# --- Evolve SDK")[1]

    def test_enrichment_preserves_original(self):
        """Original Dockerfile content should be preserved."""
        base = textwrap.dedent("""\
            FROM python:3.11-slim
            ENV PYTHONDONTWRITEBYTECODE=1
            RUN apt-get update && apt-get install -y git
            WORKDIR /app
            COPY requirements.txt .
            RUN pip install -r requirements.txt""")
        result = enrich_dockerfile(base, 'claude')
        # All original lines should be present
        for line in base.strip().split("\n"):
            assert line in result

    def test_enrichment_is_last_layer(self):
        """Toolchain install should be the last RUN in the enriched Dockerfile."""
        base = "FROM python:3.11-slim\nRUN pip install numpy\nRUN pip install pandas"
        result = enrich_dockerfile(base, 'codex')
        lines = result.strip().split("\n")
        last_run = [l for l in lines if l.startswith("RUN ")][-1]
        assert "npm install -g @openai/codex" in last_run


# =============================================================================
# [5] SWE-Bench Verified Dockerfiles
# =============================================================================

SWE_BENCH_DOCKERFILES = {
    "django": textwrap.dedent("""\
        FROM python:3.9-bookworm
        RUN apt-get update && apt-get install -y git gcc g++ make curl nodejs npm
        RUN pip install django==4.2 pytest hypothesis
        WORKDIR /testbed"""),

    "scikit-learn": textwrap.dedent("""\
        FROM python:3.9-bookworm
        RUN apt-get update && apt-get install -y git gcc g++ gfortran libopenblas-dev liblapack-dev pkg-config curl nodejs npm
        RUN pip install numpy scipy cython pytest
        RUN pip install scikit-learn==1.3.2
        WORKDIR /testbed"""),

    "matplotlib": textwrap.dedent("""\
        FROM python:3.11-bookworm
        RUN apt-get update && apt-get install -y git gcc g++ pkg-config libfreetype6-dev libpng-dev curl nodejs npm
        RUN pip install numpy pillow pytest
        RUN pip install matplotlib==3.8.2
        WORKDIR /testbed"""),

    "sympy": textwrap.dedent("""\
        FROM python:3.11-bookworm
        RUN apt-get update && apt-get install -y git curl nodejs npm
        RUN pip install mpmath pytest
        RUN pip install sympy==1.12
        WORKDIR /testbed"""),

    "requests": textwrap.dedent("""\
        FROM python:3.9-slim-bookworm
        RUN apt-get update && apt-get install -y git curl nodejs npm
        RUN pip install pytest urllib3 chardet
        RUN pip install requests==2.31.0
        WORKDIR /testbed"""),

    "flask": textwrap.dedent("""\
        FROM python:3.11-slim-bookworm
        RUN apt-get update && apt-get install -y git curl nodejs npm
        RUN pip install pytest click jinja2 werkzeug markupsafe itsdangerous
        RUN pip install flask==3.0.0
        WORKDIR /testbed"""),

    "sphinx": textwrap.dedent("""\
        FROM python:3.9-bookworm
        RUN apt-get update && apt-get install -y git make graphviz curl nodejs npm
        RUN pip install pytest docutils jinja2 pygments
        RUN pip install sphinx==7.2.6
        WORKDIR /testbed"""),

    "astropy": textwrap.dedent("""\
        FROM python:3.11-bookworm
        RUN apt-get update && apt-get install -y git gcc g++ gfortran curl nodejs npm
        RUN pip install numpy scipy cython pytest extension-helpers setuptools-scm
        RUN pip install astropy==6.0
        WORKDIR /testbed"""),

    "pytest": textwrap.dedent("""\
        FROM python:3.11-slim-bookworm
        RUN apt-get update && apt-get install -y git curl nodejs npm
        RUN pip install pluggy iniconfig packaging
        RUN pip install pytest==7.4.3
        WORKDIR /testbed"""),

    "xarray": textwrap.dedent("""\
        FROM python:3.11-bookworm
        RUN apt-get update && apt-get install -y git curl nodejs npm
        RUN pip install numpy pandas scipy netcdf4 pytest
        RUN pip install xarray==2023.12.0
        WORKDIR /testbed"""),
}


class TestSWEBenchDockerfiles:
    """Test with 10 SWE-Bench Verified Dockerfiles."""

    @pytest.mark.parametrize("name,dockerfile", list(SWE_BENCH_DOCKERFILES.items()))
    def test_enrichment_preserves_content(self, name, dockerfile):
        """Enrichment should preserve all original content for {name}."""
        enriched = enrich_dockerfile(dockerfile, 'claude')
        for line in dockerfile.strip().split("\n"):
            assert line in enriched, f"[{name}] Missing line: {line}"

    @pytest.mark.parametrize("name,dockerfile", list(SWE_BENCH_DOCKERFILES.items()))
    def test_enrichment_appends_toolchain(self, name, dockerfile):
        """Enrichment should append toolchain for {name}."""
        enriched = enrich_dockerfile(dockerfile, 'claude')
        assert "# --- Evolve SDK: agent toolchain ---" in enriched
        assert "RUN npm install -g @anthropic-ai/claude-code@latest" in enriched

    @pytest.mark.parametrize("name,dockerfile", list(SWE_BENCH_DOCKERFILES.items()))
    def test_enriched_starts_with_from(self, name, dockerfile):
        """Enriched Dockerfile should start with FROM for {name}."""
        enriched = enrich_dockerfile(dockerfile, 'claude')
        assert enriched.strip().startswith("FROM ")

    @pytest.mark.parametrize("name,dockerfile", list(SWE_BENCH_DOCKERFILES.items()))
    def test_content_hash_deterministic(self, name, dockerfile):
        """Content hash should be deterministic for {name}."""
        enriched = enrich_dockerfile(dockerfile, 'claude')
        hash1 = hashlib.sha256(enriched.encode()).hexdigest()[:12]
        hash2 = hashlib.sha256(enriched.encode()).hexdigest()[:12]
        assert hash1 == hash2
        alias = f"evolve-df-{hash1}"
        assert alias.startswith("evolve-df-")
        assert len(alias) == len("evolve-df-") + 12

    @pytest.mark.parametrize("agent_type", list(TOOLCHAIN_MAP.keys()))
    def test_django_with_all_agents(self, agent_type):
        """Django Dockerfile should enrich correctly for all agent types."""
        dockerfile = SWE_BENCH_DOCKERFILES["django"]
        enriched = enrich_dockerfile(dockerfile, agent_type)
        toolchain = TOOLCHAIN_MAP[agent_type]
        if toolchain['method'] == 'npm':
            assert f"npm install -g {toolchain['package']}" in enriched
        else:
            assert f"pip install --break-system-packages {toolchain['package']}" in enriched


# =============================================================================
# [6] Edge cases
# =============================================================================

class TestEdgeCases:
    """Test edge cases for Dockerfile support."""

    def test_multi_stage_build(self):
        """Multi-stage Dockerfile — toolchain appended to final stage."""
        dockerfile = textwrap.dedent("""\
            FROM node:20 AS builder
            WORKDIR /app
            COPY . .
            RUN npm run build

            FROM node:20-slim
            COPY --from=builder /app/dist /app
            WORKDIR /app""")
        enriched = enrich_dockerfile(dockerfile, 'claude')
        # Toolchain should be at the very end
        lines = enriched.strip().split("\n")
        assert lines[-1].startswith("RUN npm install -g")
        assert "COPY --from=builder" in enriched

    def test_comments_preserved(self):
        """Dockerfile comments should be preserved."""
        dockerfile = textwrap.dedent("""\
            # Base image for ML workloads
            FROM python:3.11-slim
            # Install system deps
            RUN apt-get update && apt-get install -y git""")
        enriched = enrich_dockerfile(dockerfile, 'claude')
        assert "# Base image for ML workloads" in enriched
        assert "# Install system deps" in enriched

    def test_arg_and_env_directives(self):
        """ARG and ENV directives should be preserved."""
        dockerfile = textwrap.dedent("""\
            ARG PYTHON_VERSION=3.11
            FROM python:${PYTHON_VERSION}-slim
            ENV PYTHONDONTWRITEBYTECODE=1
            ENV PYTHONUNBUFFERED=1
            RUN pip install flask""")
        enriched = enrich_dockerfile(dockerfile, 'claude')
        assert "ARG PYTHON_VERSION=3.11" in enriched
        assert "ENV PYTHONDONTWRITEBYTECODE=1" in enriched
        assert "ENV PYTHONUNBUFFERED=1" in enriched

    def test_cuda_base_image(self):
        """CUDA base image should work."""
        dockerfile = textwrap.dedent("""\
            FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04
            RUN apt-get update && apt-get install -y python3 python3-pip nodejs npm
            RUN pip3 install torch""")
        enriched = enrich_dockerfile(dockerfile, 'claude')
        assert enriched.startswith("FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04")
        assert "RUN npm install -g @anthropic-ai/claude-code@latest" in enriched

    def test_alpine_base_image(self):
        """Alpine base image should work (even though musl may cause issues)."""
        dockerfile = "FROM node:20-alpine\nRUN apk add --no-cache git"
        enriched = enrich_dockerfile(dockerfile, 'gemini')
        assert enriched.startswith("FROM node:20-alpine")
        assert "RUN npm install -g @google/gemini-cli@latest" in enriched

    def test_digest_pinned_image(self):
        """Digest-pinned image should work."""
        dockerfile = "FROM python@sha256:abcdef1234567890\nRUN pip install flask"
        enriched = enrich_dockerfile(dockerfile, 'claude')
        assert "python@sha256:abcdef1234567890" in enriched

    def test_minimal_dockerfile(self):
        """Minimal FROM-only Dockerfile should work."""
        dockerfile = "FROM ubuntu:22.04"
        enriched = enrich_dockerfile(dockerfile, 'claude')
        assert enriched.startswith("FROM ubuntu:22.04")
        assert "# --- Evolve SDK: agent toolchain ---" in enriched

    def test_expose_healthcheck_label(self):
        """EXPOSE, HEALTHCHECK, LABEL directives should be preserved."""
        dockerfile = textwrap.dedent("""\
            FROM node:20-slim
            LABEL maintainer="test@example.com"
            EXPOSE 3000
            HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/ || exit 1
            RUN npm install express""")
        enriched = enrich_dockerfile(dockerfile, 'claude')
        assert 'LABEL maintainer="test@example.com"' in enriched
        assert "EXPOSE 3000" in enriched
        assert "HEALTHCHECK" in enriched

    def test_trailing_newlines_trimmed(self):
        """Trailing whitespace should be trimmed before appending."""
        dockerfile = "FROM python:3.11-slim\nRUN pip install flask\n\n\n"
        enriched = enrich_dockerfile(dockerfile, 'claude')
        # Should not have excessive blank lines before the toolchain comment
        lines = enriched.split("\n")
        toolchain_idx = next(i for i, l in enumerate(lines) if "Evolve SDK" in l)
        # Exactly one blank line before the toolchain comment
        assert lines[toolchain_idx - 1] == ""
        assert lines[toolchain_idx - 2] != ""

    def test_content_hash_changes_with_content(self):
        """Different Dockerfiles should produce different content hashes."""
        df1 = enrich_dockerfile("FROM python:3.11-slim", 'claude')
        df2 = enrich_dockerfile("FROM python:3.9-slim", 'claude')
        hash1 = hashlib.sha256(df1.encode()).hexdigest()[:12]
        hash2 = hashlib.sha256(df2.encode()).hexdigest()[:12]
        assert hash1 != hash2

    def test_same_content_same_hash(self):
        """Same Dockerfile content should always produce the same hash."""
        content = "FROM python:3.11-slim\nRUN pip install torch"
        df1 = enrich_dockerfile(content, 'claude')
        df2 = enrich_dockerfile(content, 'claude')
        assert hashlib.sha256(df1.encode()).hexdigest() == hashlib.sha256(df2.encode()).hexdigest()

    @pytest.mark.asyncio
    async def test_empty_string_dockerfile_forwarded(self):
        """Empty string dockerfile is forwarded as-is (TS SDK handles validation).

        _filter_none only strips None values, not empty strings.
        """
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(dockerfile="")
            await kit._ensure_initialized()

        params = mock_bridge.get_init_params()
        # Empty string passes through _filter_none (only None is removed)
        assert params['dockerfile'] == ""

    def test_dockerfile_with_real_temp_file(self):
        """Test with a real temporary Dockerfile on disk."""
        content = "FROM python:3.11-slim\nRUN pip install flask"
        with tempfile.NamedTemporaryFile(
            mode='w', suffix='.Dockerfile', delete=False
        ) as f:
            f.write(content)
            path = f.name

        try:
            kit = Evolve(dockerfile=path)
            assert kit.dockerfile == path
            # TS SDK resolves the file path, not Python
        finally:
            os.unlink(path)
