"""Swarm - Functional programming abstractions for AI agents.

Provides map, filter, reduce, and bestOf operations for parallel AI agent execution.

Example:
    ```python
    from evolve import Swarm

    # Minimal usage - uses EVOLVE_API_KEY (or E2B_API_KEY/DAYTONA_API_KEY/MODAL_TOKEN_*) env vars
    swarm = Swarm()

    # Or with explicit config (E2B)
    from evolve import SwarmConfig, AgentConfig, E2BProvider
    swarm = Swarm(SwarmConfig(
        agent=AgentConfig(type="claude", api_key="..."),
        sandbox=E2BProvider(api_key="..."),
    ))

    # Or with Daytona
    from evolve import DaytonaProvider
    swarm = Swarm(SwarmConfig(sandbox=DaytonaProvider(api_key="...")))

    # Or with Modal
    from evolve import ModalProvider
    swarm = Swarm(SwarmConfig(sandbox=ModalProvider()))

    # Map: apply agent to each item
    results = await swarm.map(
        items=[{"doc.txt": "content1"}, {"doc.txt": "content2"}],
        prompt="Analyze this document",
    )

    # Filter: evaluate and filter items
    critical = await swarm.filter(
        items=results.success,
        prompt="Evaluate severity",
        schema=SeveritySchema,
        condition=lambda x: x.severity == "critical",
    )

    # Reduce: synthesize many into one
    report = await swarm.reduce(
        items=critical.success,
        prompt="Create summary report",
    )
    ```
"""

import asyncio
import json
import secrets
import warnings
from typing import Any, Callable, Dict, List, Optional, Type, Union

from ..bridge import BridgeManager
from ..schema import is_pydantic_model, is_dataclass, to_json_schema, validate_and_parse
from ..config import AgentConfig, ComposioSetup
from ..utils import _encode_files_for_transport, _decode_files_from_transport, _filter_none
from ..prompts import JUDGE_PROMPT, JUDGE_USER_PROMPT, VERIFY_PROMPT, VERIFY_USER_PROMPT, REDUCE_PROMPT, RETRY_FEEDBACK_PROMPT, apply_template, build_file_tree
from ..retry import RetryConfig, execute_with_retry
from .types import (
    FileMap,
    SwarmConfig,
    BestOfConfig,
    VerifyConfig,
    IndexedMeta,
    ReduceMeta,
    JudgeMeta,
    VerifyMeta,
    Prompt,
    ItemInput,
    SchemaType,
    PipelineContext,
)
from .results import (
    SwarmResult,
    SwarmResultList,
    ReduceResult,
    BestOfResult,
    BestOfInfo,
    VerifyInfo,
    is_swarm_result,
)


# =============================================================================
# CONSTANTS
# =============================================================================

MAX_CONCURRENCY = 100  # Cap to prevent resource exhaustion


# =============================================================================
# SWARM CLASS
# =============================================================================

class Swarm:
    """Functional programming abstractions for AI agents.

    Provides map, filter, reduce, and bestOf operations for parallel AI agent execution.
    Uses a shared bridge process with multiple Evolve instances for efficiency.
    """

    def __init__(self, config: Optional[SwarmConfig] = None):
        """Initialize Swarm with configuration.

        Args:
            config: SwarmConfig with agent, sandbox, concurrency settings
                   (optional - defaults to EVOLVE_API_KEY and E2B_API_KEY env vars)

        Raises:
            ValueError: If concurrency exceeds MAX_CONCURRENCY
        """
        config = config or SwarmConfig()
        if config.concurrency > MAX_CONCURRENCY:
            raise ValueError(
                f"concurrency={config.concurrency} exceeds max {MAX_CONCURRENCY}. "
                f"For higher parallelism, scale horizontally with multiple processes."
            )

        self.config = config
        self.semaphore = asyncio.Semaphore(config.concurrency)
        self.bridge = BridgeManager()
        self._bridge_started = False

    async def _ensure_bridge(self):
        """Ensure bridge is started."""
        if not self._bridge_started:
            await self.bridge.start()
            self._bridge_started = True

    # =========================================================================
    # PUBLIC API
    # =========================================================================

    async def map(
        self,
        items: List[ItemInput],
        prompt: Prompt,
        system_prompt: Optional[str] = None,
        schema: Optional[SchemaType] = None,
        schema_options: Optional[Dict[str, Any]] = None,
        agent: Optional[AgentConfig] = None,
        mcp_servers: Optional[Dict[str, Any]] = None,
        skills: Optional[List[str]] = None,
        composio: Optional[ComposioSetup] = None,
        best_of: Optional[BestOfConfig] = None,
        verify: Optional[VerifyConfig] = None,
        retry: Optional[RetryConfig] = None,
        timeout_ms: Optional[int] = None,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> SwarmResultList:
        """Apply an agent to each item in parallel.

        Args:
            items: List of items (FileMaps or SwarmResults from previous operation)
            prompt: Task prompt (string or function(files, index) -> string)
            system_prompt: Optional system prompt
            schema: Optional Pydantic model or JSON Schema for structured output
            schema_options: Optional validation options
            agent: Optional agent override
            mcp_servers: Optional MCP servers override (replaces swarm default)
            skills: Optional skills override (replaces swarm default)
            composio: Optional Composio override (replaces swarm default)
            best_of: Optional bestOf configuration for N candidates + judge per item (mutually exclusive with verify)
            verify: Optional verify configuration for LLM-as-judge quality verification with retry (mutually exclusive with best_of)
            retry: Optional retry configuration for failed items
            timeout_ms: Optional timeout in ms
            name: Optional operation name for observability
            _pipeline_context: Internal - pipeline context for observability (passed by Pipeline)

        Returns:
            SwarmResultList with results for each item
        """
        await self._ensure_bridge()
        operation_id = self._generate_operation_id()
        timeout = timeout_ms or self.config.timeout_ms
        retry = retry or self.config.retry
        resolved_mcp_servers = mcp_servers if mcp_servers is not None else self.config.mcp_servers
        resolved_skills = skills if skills is not None else self.config.skills
        resolved_composio = composio if composio is not None else self.config.composio

        # best_of and verify are mutually exclusive
        if best_of and verify:
            raise ValueError("map() cannot use both best_of and verify options simultaneously")

        async def process_item(item: ItemInput, index: int) -> SwarmResult:
            # bestOf has internal per-candidate and judge retry - don't double-wrap
            if best_of:
                return await self._execute_map_item_with_best_of(
                    item, prompt, index, operation_id, system_prompt, schema,
                    schema_options, agent, resolved_mcp_servers, resolved_skills, resolved_composio, best_of, retry, timeout,
                    name, _pipeline_context
                )

            # verify has internal retry loop with feedback - don't double-wrap with retry
            if verify:
                return await self._execute_map_item_with_verify(
                    item, prompt, index, operation_id, system_prompt, schema,
                    schema_options, agent, resolved_mcp_servers, resolved_skills, resolved_composio, verify, timeout, retry,
                    name, _pipeline_context
                )

            # Wrap with retry if configured (simple map only)
            if retry:
                return await execute_with_retry(
                    lambda attempt: self._execute_map_item(
                        item, prompt, index, operation_id, system_prompt, schema,
                        schema_options, agent, resolved_mcp_servers, resolved_skills, resolved_composio, timeout, attempt,
                        name, _pipeline_context
                    ),
                    retry,
                    item_index=index,
                )
            return await self._execute_map_item(
                item, prompt, index, operation_id, system_prompt, schema,
                schema_options, agent, resolved_mcp_servers, resolved_skills, resolved_composio, timeout, 1,
                name, _pipeline_context
            )

        results = await asyncio.gather(*[
            process_item(item, i) for i, item in enumerate(items)
        ])

        return SwarmResultList.from_results(list(results))

    async def filter(
        self,
        items: List[ItemInput],
        prompt: str,
        schema: SchemaType,
        condition: Callable[[Any], bool],
        schema_options: Optional[Dict[str, Any]] = None,
        system_prompt: Optional[str] = None,
        agent: Optional[AgentConfig] = None,
        mcp_servers: Optional[Dict[str, Any]] = None,
        skills: Optional[List[str]] = None,
        composio: Optional[ComposioSetup] = None,
        verify: Optional[VerifyConfig] = None,
        retry: Optional[RetryConfig] = None,
        timeout_ms: Optional[int] = None,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> SwarmResultList:
        """Two-step evaluation: agent assesses each item, then local condition applies threshold.

        1. Agent sees context files, evaluates per prompt, outputs result.json matching schema
        2. Condition function receives parsed data, returns true (success) or false (filtered)

        Returns ALL items with status:
        - "success": passed condition
        - "filtered": evaluated but didn't pass condition
        - "error": agent error

        Use `.success` for passing items, `.filtered` for non-passing.

        Args:
            items: List of items to filter
            prompt: Evaluation prompt
            schema: Pydantic model or JSON Schema (required for filter)
            condition: Function(data) -> bool to determine pass/fail
            schema_options: Optional validation options
            system_prompt: Optional system prompt
            agent: Optional agent override
            mcp_servers: Optional MCP servers override (replaces swarm default)
            skills: Optional skills override (replaces swarm default)
            composio: Optional Composio override (replaces swarm default)
            verify: Optional verify configuration for LLM-as-judge quality verification with retry
            retry: Optional retry configuration for failed items
            timeout_ms: Optional timeout in ms
            name: Optional operation name for observability
            _pipeline_context: Internal - pipeline context for observability (passed by Pipeline)

        Returns:
            SwarmResultList with all items (success, filtered, or error status)
        """
        await self._ensure_bridge()
        operation_id = self._generate_operation_id()
        timeout = timeout_ms or self.config.timeout_ms
        retry = retry or self.config.retry
        resolved_mcp_servers = mcp_servers if mcp_servers is not None else self.config.mcp_servers
        resolved_skills = skills if skills is not None else self.config.skills
        resolved_composio = composio if composio is not None else self.config.composio

        async def process_item(item: ItemInput, index: int) -> SwarmResult:
            # verify has internal retry loop with feedback - don't double-wrap with retry
            if verify:
                return await self._execute_filter_item_with_verify(
                    item, prompt, index, operation_id, system_prompt, schema,
                    schema_options, agent, resolved_mcp_servers, resolved_skills, resolved_composio, verify, timeout, retry,
                    name, _pipeline_context
                )

            # Wrap with retry if configured
            if retry:
                return await execute_with_retry(
                    lambda attempt: self._execute_filter_item(
                        item, prompt, index, operation_id, system_prompt, schema,
                        schema_options, agent, resolved_mcp_servers, resolved_skills, resolved_composio, timeout, attempt,
                        name, _pipeline_context
                    ),
                    retry,
                    item_index=index,
                )
            return await self._execute_filter_item(
                item, prompt, index, operation_id, system_prompt, schema,
                schema_options, agent, resolved_mcp_servers, resolved_skills, resolved_composio, timeout, 1,
                name, _pipeline_context
            )

        evaluated = await asyncio.gather(*[
            process_item(item, i) for i, item in enumerate(items)
        ])

        # Apply condition and set status accordingly
        results: List[SwarmResult] = []
        for r in evaluated:
            if r.status == "error":
                results.append(r)
            elif r.data is not None:
                try:
                    if condition(r.data):
                        results.append(r)  # success
                    else:
                        # Didn't pass condition → filtered
                        results.append(SwarmResult(
                            status="filtered",
                            data=r.data,
                            files=r.files,
                            meta=r.meta,
                            verify=r.verify,
                        ))
                except Exception as e:
                    # Condition threw → error (preserve raw_data if present)
                    results.append(SwarmResult(
                        status="error",
                        data=None,
                        files=r.files,
                        meta=r.meta,
                        error=f"Condition function threw: {e}",
                        raw_data=getattr(r, 'raw_data', None),
                    ))
            else:
                results.append(r)

        return SwarmResultList.from_results(results)

    async def reduce(
        self,
        items: List[ItemInput],
        prompt: str,
        system_prompt: Optional[str] = None,
        schema: Optional[SchemaType] = None,
        schema_options: Optional[Dict[str, Any]] = None,
        agent: Optional[AgentConfig] = None,
        mcp_servers: Optional[Dict[str, Any]] = None,
        skills: Optional[List[str]] = None,
        composio: Optional[ComposioSetup] = None,
        verify: Optional[VerifyConfig] = None,
        retry: Optional[RetryConfig] = None,
        timeout_ms: Optional[int] = None,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> ReduceResult:
        """Synthesize many items into one.

        Args:
            items: List of items to reduce
            prompt: Synthesis prompt
            system_prompt: Optional system prompt
            schema: Optional Pydantic model or JSON Schema
            schema_options: Optional validation options
            agent: Optional agent override
            mcp_servers: Optional MCP servers override (replaces swarm default)
            skills: Optional skills override (replaces swarm default)
            composio: Optional Composio override (replaces swarm default)
            verify: Optional verify configuration for LLM-as-judge quality verification with retry
            retry: Optional retry configuration
            timeout_ms: Optional timeout in ms
            name: Optional operation name for observability
            _pipeline_context: Internal - pipeline context for observability (passed by Pipeline)

        Returns:
            ReduceResult with synthesized output
        """
        await self._ensure_bridge()
        operation_id = self._generate_operation_id()
        timeout = timeout_ms or self.config.timeout_ms
        retry = retry or self.config.retry
        resolved_mcp_servers = mcp_servers if mcp_servers is not None else self.config.mcp_servers
        resolved_skills = skills if skills is not None else self.config.skills
        resolved_composio = composio if composio is not None else self.config.composio

        # Collect files and track original indices
        all_files: List[FileMap] = []
        indices: List[int] = []

        for i, item in enumerate(items):
            all_files.append(self._get_files(item))
            indices.append(self._get_index(item, i))

        # Build context: item_0/, item_1/, etc.
        context: FileMap = {}
        for i, files in enumerate(all_files):
            for file_name, content in files.items():
                context[f"item_{indices[i]}/{file_name}"] = content

        # Build reduce system prompt (context structure + user's system_prompt)
        file_tree = build_file_tree(context)
        reduce_context_prompt = apply_template(REDUCE_PROMPT, {"fileTree": file_tree})
        final_system_prompt = (
            f"{reduce_context_prompt}\n\n{system_prompt}"
            if system_prompt
            else reduce_context_prompt
        )

        # Build meta (sandboxId/tag updated after execution)
        def build_meta(result: Dict[str, Any], error_retry: Optional[int] = None, verify_retry: Optional[int] = None) -> ReduceMeta:
            return ReduceMeta(
                operation_id=operation_id,
                operation="reduce",
                tag=result["tag"],
                sandbox_id=result["sandbox_id"],
                swarm_name=self.config.tag,
                operation_name=name,
                error_retry=error_retry,
                verify_retry=verify_retry,
                input_count=len(items),
                input_indices=indices,
                **self._pipeline_context_to_meta(_pipeline_context),
            )

        # Shared execution logic
        async def execute_once(prompt_to_use: str, tag_prefix: str, error_retry: Optional[int] = None, attempt_index: Optional[int] = None) -> ReduceResult:
            # Calculate verify_retry from attempt_index (matches TS SDK pattern)
            verify_retry = attempt_index - 1 if attempt_index and attempt_index > 1 else None

            # Build observability for JSONL
            observability = _filter_none({
                'swarm_name': self.config.tag,
                'operation_name': name,
                'operation_id': operation_id,
                'operation': 'reduce',
                'role': 'worker',
                'error_retry': error_retry,
                'verify_retry': verify_retry,
                **self._pipeline_context_to_observability(_pipeline_context),
            })

            async with self.semaphore:
                result = await self._execute(
                    context=context,
                    prompt=prompt_to_use,
                    system_prompt=final_system_prompt,
                    schema=schema,
                    schema_options=schema_options,
                    agent=agent,
                    mcp_servers=resolved_mcp_servers,
                    skills=resolved_skills,
                    composio=resolved_composio,
                    tag_prefix=tag_prefix,
                    timeout=timeout,
                    observability=observability,
                )

            meta = build_meta(result, error_retry, verify_retry)

            if result.get("error"):
                return ReduceResult(
                    status="error",
                    data=None,
                    files=result["files"],
                    meta=meta,
                    error=result["error"],
                    raw_data=result.get("raw_data"),
                )

            return ReduceResult(
                status="success",
                data=result["data"],
                files=result["files"],
                meta=meta,
            )

        base_tag = f"{self.config.tag}-reduce"

        # verify has internal retry loop with feedback - don't double-wrap with retry
        if verify:
            return await self._run_with_verification(
                worker_fn=lambda current_prompt, tag_prefix, attempt_index=None: execute_once(
                    current_prompt, tag_prefix, None, attempt_index  # Pass attempt_index for verify_retry
                ),
                original_prompt=prompt,
                input_files=context,
                verify_config=verify,
                mcp_servers=resolved_mcp_servers,
                skills=resolved_skills,
                composio=resolved_composio,
                timeout=timeout,
                system_prompt=final_system_prompt,
                schema=schema,
                operation_id=operation_id,
                base_tag=base_tag,
                retry=retry,
                name=name,
                _pipeline_context=_pipeline_context,
            )

        # Wrap with retry if configured
        if retry:
            async def execute_fn(attempt: int = 1) -> ReduceResult:
                tag_prefix = f"{base_tag}-er{attempt - 1}" if attempt > 1 else base_tag
                error_retry = attempt - 1 if attempt > 1 else None
                return await execute_once(prompt, tag_prefix, error_retry)
            return await execute_with_retry(execute_fn, retry)

        return await execute_once(prompt, base_tag)

    async def best_of(
        self,
        item: ItemInput,
        prompt: str,
        config: BestOfConfig,
        system_prompt: Optional[str] = None,
        schema: Optional[SchemaType] = None,
        schema_options: Optional[Dict[str, Any]] = None,
        retry: Optional[RetryConfig] = None,
        timeout_ms: Optional[int] = None,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> BestOfResult:
        """Run N candidates on the same task, judge picks the best.

        Args:
            item: Single item to process
            prompt: Task prompt
            config: BestOf configuration (n, judge_criteria, mcp_servers, etc.)
            system_prompt: Optional system prompt
            schema: Optional Pydantic model or JSON Schema
            schema_options: Optional validation options
            retry: Optional retry configuration for candidates and judge
            timeout_ms: Optional timeout in ms
            name: Optional operation name for observability
            _pipeline_context: Internal - pipeline context for observability (passed by Pipeline)

        Returns:
            BestOfResult with winner, candidates, and judge info
        """
        await self._ensure_bridge()
        retry = retry or self.config.retry

        # Resolve n
        n = config.n or (len(config.task_agents) if config.task_agents else None)
        if n is None:
            raise ValueError("bestOf requires n or task_agents")
        if n < 2:
            raise ValueError("bestOf requires n >= 2")

        operation_id = self._generate_operation_id()
        timeout = timeout_ms or self.config.timeout_ms
        input_files = self._get_files(item)

        # Resolve MCP servers, skills, and composio for candidates and judge
        candidate_mcp_servers = config.mcp_servers if config.mcp_servers is not None else self.config.mcp_servers
        judge_mcp_servers = config.judge_mcp_servers if config.judge_mcp_servers is not None else config.mcp_servers if config.mcp_servers is not None else self.config.mcp_servers
        candidate_skills = config.skills if config.skills is not None else self.config.skills
        judge_skills = config.judge_skills if config.judge_skills is not None else config.skills if config.skills is not None else self.config.skills
        candidate_composio = config.composio if config.composio is not None else self.config.composio
        judge_composio = config.judge_composio if config.judge_composio is not None else config.composio if config.composio is not None else self.config.composio

        # Run candidates (semaphore acquired inside _execute_best_of_candidate)
        async def run_candidate(candidate_index: int) -> SwarmResult:
            if retry:
                result = await execute_with_retry(
                    lambda attempt: self._execute_best_of_candidate(
                        input_files=input_files,
                        prompt=prompt,
                        candidate_index=candidate_index,
                        operation_id=operation_id,
                        config=config,
                        mcp_servers=candidate_mcp_servers,
                        skills=candidate_skills,
                        composio=candidate_composio,
                        system_prompt=system_prompt,
                        schema=schema,
                        schema_options=schema_options,
                        timeout=timeout,
                        attempt=attempt,
                        name=name,
                        _pipeline_context=_pipeline_context,
                    ),
                    retry,
                    item_index=0,  # standalone bestOf uses item_index=0
                )
            else:
                result = await self._execute_best_of_candidate(
                    input_files=input_files,
                    prompt=prompt,
                    candidate_index=candidate_index,
                    operation_id=operation_id,
                    config=config,
                    mcp_servers=candidate_mcp_servers,
                    skills=candidate_skills,
                    composio=candidate_composio,
                    system_prompt=system_prompt,
                    schema=schema,
                    schema_options=schema_options,
                    timeout=timeout,
                    name=name,
                    _pipeline_context=_pipeline_context,
                )
            # Call callback after candidate completes
            if config.on_candidate_complete:
                config.on_candidate_complete(0, candidate_index, result.status if result.status != "filtered" else "success")
            return result

        candidates = await asyncio.gather(*[
            run_candidate(i) for i in range(n)
        ])
        candidates = list(candidates)

        # Run judge (semaphore acquired inside _execute_best_of_judge)
        # Judge uses default retry (status === "error"), not custom retry_on
        if retry:
            # Create a copy of retry config without custom retry_on for judge
            judge_retry = RetryConfig(
                max_attempts=retry.max_attempts,
                backoff_ms=retry.backoff_ms,
                backoff_multiplier=retry.backoff_multiplier,
                retry_on=None,  # Use default (status == "error")
            )
            judge = await execute_with_retry(
                lambda attempt: self._execute_best_of_judge(
                    input_files=input_files,
                    task_prompt=prompt,
                    candidates=candidates,
                    config=config,
                    mcp_servers=judge_mcp_servers,
                    skills=judge_skills,
                    composio=judge_composio,
                    timeout=timeout,
                    system_prompt=system_prompt,
                    schema=schema,
                    operation_id=operation_id,
                    attempt=attempt,
                    name=name,
                    _pipeline_context=_pipeline_context,
                ),
                judge_retry
            )
        else:
            judge = await self._execute_best_of_judge(
                input_files=input_files,
                task_prompt=prompt,
                candidates=candidates,
                config=config,
                mcp_servers=judge_mcp_servers,
                skills=judge_skills,
                composio=judge_composio,
                timeout=timeout,
                system_prompt=system_prompt,
                schema=schema,
                operation_id=operation_id,
                name=name,
                _pipeline_context=_pipeline_context,
            )

        first_success = next((i for i, c in enumerate(candidates) if c.status == "success"), -1)
        winner_index = judge["winner"] if judge["winner"] is not None else (first_success if first_success >= 0 else 0)

        # Call judge callback
        if config.on_judge_complete:
            config.on_judge_complete(0, winner_index, judge.get("reasoning", ""))

        judge_meta = JudgeMeta(
            operation_id=operation_id,
            operation="bestof-judge",
            tag=judge["tag"],
            sandbox_id=judge["sandbox_id"],
            swarm_name=self.config.tag,
            operation_name=name,
            candidate_count=n,
            **self._pipeline_context_to_meta(_pipeline_context),
        )

        return BestOfResult(
            winner=candidates[winner_index] if winner_index < len(candidates) else candidates[0],
            winner_index=winner_index,
            judge_reasoning=judge.get("reasoning", "Judge failed to provide reasoning"),
            judge_meta=judge_meta,
            candidates=candidates,
        )

    async def close(self):
        """Close the bridge connection."""
        if self._bridge_started:
            await self.bridge.stop()
            self._bridge_started = False

    async def __aenter__(self):
        """Async context manager entry - ensures bridge is started."""
        await self._ensure_bridge()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit - closes the bridge."""
        await self.close()
        return False

    # =========================================================================
    # PRIVATE: EXECUTION
    # =========================================================================

    async def _execute(
        self,
        context: FileMap,
        prompt: str,
        system_prompt: Optional[str],
        schema: Optional[SchemaType],
        schema_options: Optional[Dict[str, Any]],
        agent: Optional[AgentConfig],
        mcp_servers: Optional[Dict[str, Any]],
        skills: Optional[List[str]],
        composio: Optional[ComposioSetup],
        tag_prefix: str,
        timeout: int,
        observability: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute a single agent task."""
        instance_id = f"{tag_prefix}-{secrets.token_hex(4)}"

        # Build agent config (merges override with base config)
        agent_config = self._build_agent_config(agent)

        # Convert schema to JSON Schema
        json_schema = to_json_schema(schema)

        # Build init params with _filter_none to exclude None values
        # TS SDK resolves defaults from env vars when not provided
        init_params = _filter_none({
            # Agent config (optional - TS SDK resolves from env vars)
            'agent_type': agent_config.type if agent_config else None,
            'api_key': agent_config.api_key if agent_config else None,
            'provider_api_key': agent_config.provider_api_key if agent_config else None,
            'oauth_token': agent_config.oauth_token if agent_config else None,
            'provider_base_url': agent_config.provider_base_url if agent_config else None,
            'model': agent_config.model if agent_config else None,
            'reasoning_effort': agent_config.reasoning_effort if agent_config else None,
            # Sandbox (optional - TS SDK auto-resolves from EVOLVE_API_KEY/E2B_API_KEY/DAYTONA_API_KEY)
            'sandbox_provider': {'type': self.config.sandbox.type, 'config': self.config.sandbox.config} if self.config.sandbox else None,
            # Other settings
            'workspace_mode': self.config.workspace_mode,
            'session_tag_prefix': tag_prefix,
            'system_prompt': system_prompt,
            'schema': json_schema,
            'schema_options': schema_options,
            'context': _encode_files_for_transport(context) if context else None,
            'mcp_servers': mcp_servers,
            'skills': skills,
            'composio': composio.to_dict() if composio else None,
            'observability': observability,
        })

        files: FileMap = {}
        data: Any = None
        error: Optional[str] = None
        raw_data: Optional[str] = None
        sandbox_id = ""
        tag = tag_prefix

        try:
            # Create instance
            await self.bridge.create_instance(instance_id, init_params)

            # Run prompt
            run_result = await self.bridge.run_on_instance(
                instance_id,
                prompt,
                timeout_ms=timeout,
                call_timeout_s=(timeout / 1000) + 60,  # Add buffer for RPC overhead
            )
            sandbox_id = run_result.get('sandbox_id', '')

            # Get output
            output = await self.bridge.get_output_on_instance(instance_id, recursive=True)
            files = _decode_files_from_transport(output.get('files', {}))

            if run_result.get('exit_code', 0) != 0:
                error = f"Agent exited with code {run_result.get('exit_code')}"
            elif json_schema:
                # Validate result.json against schema
                raw_json = files.get('result.json')
                if raw_json is not None:
                    if isinstance(raw_json, bytes):
                        raw_json = raw_json.decode('utf-8')

                    if is_pydantic_model(schema) or is_dataclass(schema):
                        # Pydantic model or dataclass - validate and return instance
                        try:
                            strict = schema_options.get('mode') == 'strict' if schema_options else False
                            data = validate_and_parse(raw_json, schema, strict=strict)
                        except Exception as e:
                            error = f"Schema validation failed: {e}"
                            raw_data = raw_json
                    else:
                        # JSON Schema dict - use TS validation result
                        data = output.get('data')
                        if output.get('error'):
                            error = output['error']
                        if output.get('raw_data'):
                            raw_data = output['raw_data']
                else:
                    error = "Schema provided but agent did not create output/result.json"
            else:
                data = files

        except Exception as e:
            error = str(e)
            # Try to capture partial output even on failure (e.g., timeout)
            try:
                output = await self.bridge.get_output_on_instance(instance_id, recursive=True)
                files = _decode_files_from_transport(output.get('files', {}))
            except Exception:
                pass  # Sandbox may already be gone
        finally:
            # Always cleanup
            try:
                await self.bridge.kill_instance(instance_id)
            except Exception:
                pass

        return {
            "files": files,
            "data": data,
            "tag": tag,
            "sandbox_id": sandbox_id,
            "error": error,
            "raw_data": raw_data,
        }

    # =========================================================================
    # PRIVATE: MAP
    # =========================================================================

    async def _execute_map_item(
        self,
        item: ItemInput,
        prompt: Prompt,
        index: int,
        operation_id: str,
        system_prompt: Optional[str],
        schema: Optional[SchemaType],
        schema_options: Optional[Dict[str, Any]],
        agent: Optional[AgentConfig],
        mcp_servers: Optional[Dict[str, Any]],
        skills: Optional[List[str]],
        composio: Optional[ComposioSetup],
        timeout: int,
        attempt: int = 1,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> SwarmResult:
        """Execute a single map item."""
        files = self._get_files(item)
        error_retry = attempt - 1 if attempt > 1 else None
        tag_prefix = (
            f"{self.config.tag}-map-{index}-er{error_retry}"
            if error_retry
            else f"{self.config.tag}-map-{index}"
        )

        try:
            prompt_str = self._resolve_prompt(prompt, files, index)
        except Exception as e:
            return self._build_error_result(
                f"Prompt function threw: {e}",
                IndexedMeta(
                    operation_id=operation_id, operation="map", tag=tag_prefix,
                    sandbox_id="", swarm_name=self.config.tag, operation_name=name,
                    item_index=index, **self._pipeline_context_to_meta(_pipeline_context)
                )
            )

        # Build observability for JSONL
        observability = _filter_none({
            'swarm_name': self.config.tag,
            'operation_name': name,
            'operation_id': operation_id,
            'operation': 'map',
            'item_index': index,
            'role': 'worker',
            'error_retry': error_retry,
            **self._pipeline_context_to_observability(_pipeline_context),
        })

        async with self.semaphore:
            result = await self._execute(
                context=files,
                prompt=prompt_str,
                system_prompt=system_prompt,
                schema=schema,
                schema_options=schema_options,
                agent=agent,
                mcp_servers=mcp_servers,
                skills=skills,
                composio=composio,
                tag_prefix=tag_prefix,
                timeout=timeout,
                observability=observability,
            )

        meta = IndexedMeta(
            operation_id=operation_id,
            operation="map",
            tag=result["tag"],
            sandbox_id=result["sandbox_id"],
            swarm_name=self.config.tag,
            operation_name=name,
            error_retry=error_retry,
            item_index=index,
            **self._pipeline_context_to_meta(_pipeline_context),
        )

        return self._build_result(result, meta)

    async def _execute_map_item_with_best_of(
        self,
        item: ItemInput,
        prompt: Prompt,
        index: int,
        operation_id: str,
        system_prompt: Optional[str],
        schema: Optional[SchemaType],
        schema_options: Optional[Dict[str, Any]],
        agent: Optional[AgentConfig],
        mcp_servers: Optional[Dict[str, Any]],
        skills: Optional[List[str]],
        composio: Optional[ComposioSetup],
        best_of_config: BestOfConfig,
        retry: Optional[RetryConfig],
        timeout: int,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> SwarmResult:
        """Execute a single map item with bestOf."""
        files = self._get_files(item)
        tag_prefix = f"{self.config.tag}-map-{index}"

        try:
            prompt_str = self._resolve_prompt(prompt, files, index)
        except Exception as e:
            return self._build_error_result(
                f"Prompt function threw: {e}",
                IndexedMeta(
                    operation_id=operation_id, operation="map", tag=tag_prefix,
                    sandbox_id="", swarm_name=self.config.tag, operation_name=name,
                    item_index=index, **self._pipeline_context_to_meta(_pipeline_context)
                )
            )

        n = best_of_config.n or (len(best_of_config.task_agents) if best_of_config.task_agents else None)
        if n is None or n < 2:
            return self._build_error_result(
                "bestOf requires n >= 2 or task_agents with at least 2 elements",
                IndexedMeta(
                    operation_id=operation_id, operation="map", tag=tag_prefix,
                    sandbox_id="", swarm_name=self.config.tag, operation_name=name,
                    item_index=index, **self._pipeline_context_to_meta(_pipeline_context)
                )
            )

        # Resolve MCP servers, skills, and composio: bestOf config overrides operation-level
        candidate_mcp_servers = best_of_config.mcp_servers if best_of_config.mcp_servers is not None else mcp_servers
        judge_mcp_servers = best_of_config.judge_mcp_servers if best_of_config.judge_mcp_servers is not None else best_of_config.mcp_servers if best_of_config.mcp_servers is not None else mcp_servers
        candidate_skills = best_of_config.skills if best_of_config.skills is not None else skills
        judge_skills = best_of_config.judge_skills if best_of_config.judge_skills is not None else best_of_config.skills if best_of_config.skills is not None else skills
        candidate_composio = best_of_config.composio if best_of_config.composio is not None else composio
        judge_composio = best_of_config.judge_composio if best_of_config.judge_composio is not None else best_of_config.composio if best_of_config.composio is not None else composio

        # Run candidates in parallel (semaphore acquired inside _execute_best_of_candidate)
        async def run_candidate(candidate_index: int) -> SwarmResult:
            if retry:
                result = await execute_with_retry(
                    lambda attempt: self._execute_best_of_candidate(
                        input_files=files,
                        prompt=prompt_str,
                        candidate_index=candidate_index,
                        operation_id=operation_id,
                        config=best_of_config,
                        mcp_servers=candidate_mcp_servers,
                        skills=candidate_skills,
                        composio=candidate_composio,
                        system_prompt=system_prompt,
                        schema=schema,
                        schema_options=schema_options,
                        timeout=timeout,
                        parent_index=index,
                        attempt=attempt,
                        name=name,
                        _pipeline_context=_pipeline_context,
                    ),
                    retry,
                    item_index=index,  # map item index
                )
            else:
                result = await self._execute_best_of_candidate(
                    input_files=files,
                    prompt=prompt_str,
                    candidate_index=candidate_index,
                    operation_id=operation_id,
                    config=best_of_config,
                    mcp_servers=candidate_mcp_servers,
                    skills=candidate_skills,
                    composio=candidate_composio,
                    system_prompt=system_prompt,
                    schema=schema,
                    schema_options=schema_options,
                    timeout=timeout,
                    parent_index=index,
                    name=name,
                    _pipeline_context=_pipeline_context,
                )
            # Call callback after candidate completes
            if best_of_config.on_candidate_complete:
                best_of_config.on_candidate_complete(index, candidate_index, result.status if result.status != "filtered" else "success")
            return result

        candidates = list(await asyncio.gather(*[
            run_candidate(i) for i in range(n)
        ]))

        # Run judge (semaphore acquired inside _execute_best_of_judge)
        # Judge uses default retry (status === "error"), not custom retry_on
        if retry:
            judge_retry = RetryConfig(
                max_attempts=retry.max_attempts,
                backoff_ms=retry.backoff_ms,
                backoff_multiplier=retry.backoff_multiplier,
                retry_on=None,
            )
            judge = await execute_with_retry(
                lambda attempt: self._execute_best_of_judge(
                    input_files=files,
                    task_prompt=prompt_str,
                    candidates=candidates,
                    config=best_of_config,
                    mcp_servers=judge_mcp_servers,
                    skills=judge_skills,
                    composio=judge_composio,
                    timeout=timeout,
                    system_prompt=system_prompt,
                    schema=schema,
                    operation_id=operation_id,
                    parent_index=index,
                    attempt=attempt,
                    name=name,
                    _pipeline_context=_pipeline_context,
                ),
                judge_retry
            )
        else:
            judge = await self._execute_best_of_judge(
                input_files=files,
                task_prompt=prompt_str,
                candidates=candidates,
                config=best_of_config,
                mcp_servers=judge_mcp_servers,
                skills=judge_skills,
                composio=judge_composio,
                timeout=timeout,
                system_prompt=system_prompt,
                schema=schema,
                operation_id=operation_id,
                parent_index=index,
                name=name,
                _pipeline_context=_pipeline_context,
            )

        first_success = next((i for i, c in enumerate(candidates) if c.status == "success"), -1)
        winner_index = judge["winner"] if judge["winner"] is not None else (first_success if first_success >= 0 else 0)
        winner = candidates[winner_index] if winner_index < len(candidates) else candidates[0]

        # Call judge callback with map item index
        if best_of_config.on_judge_complete:
            best_of_config.on_judge_complete(index, winner_index, judge.get("reasoning", ""))

        judge_meta = JudgeMeta(
            operation_id=operation_id,
            operation="bestof-judge",
            tag=judge["tag"],
            sandbox_id=judge["sandbox_id"],
            swarm_name=self.config.tag,
            operation_name=name,
            candidate_count=n,
            **self._pipeline_context_to_meta(_pipeline_context),
        )

        # Return winner with bestOf info
        return SwarmResult(
            status=winner.status,
            data=winner.data,
            files=winner.files,
            meta=IndexedMeta(
                operation_id=operation_id,
                operation="map",
                tag=winner.meta.tag,
                sandbox_id=winner.meta.sandbox_id,
                swarm_name=self.config.tag,
                operation_name=name,
                item_index=index,
                **self._pipeline_context_to_meta(_pipeline_context),
            ),
            error=winner.error,
            raw_data=winner.raw_data,
            best_of=BestOfInfo(
                winner_index=winner_index,
                judge_reasoning=judge.get("reasoning", "Judge failed to provide reasoning"),
                judge_meta=judge_meta,
                candidates=candidates,
            ),
        )

    async def _execute_map_item_with_verify(
        self,
        item: ItemInput,
        prompt: Prompt,
        index: int,
        operation_id: str,
        system_prompt: Optional[str],
        schema: Optional[SchemaType],
        schema_options: Optional[Dict[str, Any]],
        agent: Optional[AgentConfig],
        mcp_servers: Optional[Dict[str, Any]],
        skills: Optional[List[str]],
        composio: Optional[ComposioSetup],
        verify_config: VerifyConfig,
        timeout: int,
        retry: Optional[RetryConfig] = None,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> SwarmResult:
        """Execute a single map item with verification."""
        files = self._get_files(item)
        base_tag = f"{self.config.tag}-map-{index}"

        try:
            prompt_str = self._resolve_prompt(prompt, files, index)
        except Exception as e:
            return self._build_error_result(
                f"Prompt function threw: {e}",
                IndexedMeta(
                    operation_id=operation_id, operation="map", tag=base_tag,
                    sandbox_id="", swarm_name=self.config.tag, operation_name=name,
                    item_index=index, **self._pipeline_context_to_meta(_pipeline_context)
                )
            )

        # Worker function that executes map item (tag_prefix managed by _run_with_verification)
        async def worker_fn(current_prompt: str, tag_prefix: str, attempt_index: Optional[int] = None) -> SwarmResult:
            verify_retry = attempt_index - 1 if attempt_index and attempt_index > 1 else None

            # Build observability for JSONL
            observability = _filter_none({
                'swarm_name': self.config.tag,
                'operation_name': name,
                'operation_id': operation_id,
                'operation': 'map',
                'item_index': index,
                'role': 'worker',
                'verify_retry': verify_retry,
                **self._pipeline_context_to_observability(_pipeline_context),
            })

            async with self.semaphore:
                result = await self._execute(
                    context=files,
                    prompt=current_prompt,
                    system_prompt=system_prompt,
                    schema=schema,
                    schema_options=schema_options,
                    agent=agent,
                    mcp_servers=mcp_servers,
                    skills=skills,
                    composio=composio,
                    tag_prefix=tag_prefix,
                    timeout=timeout,
                    observability=observability,
                )

            meta = IndexedMeta(
                operation_id=operation_id,
                operation="map",
                tag=result["tag"],
                sandbox_id=result["sandbox_id"],
                swarm_name=self.config.tag,
                operation_name=name,
                verify_retry=verify_retry,
                item_index=index,
                **self._pipeline_context_to_meta(_pipeline_context),
            )

            return self._build_result(result, meta)

        # Run with verification loop
        return await self._run_with_verification(
            worker_fn=worker_fn,
            original_prompt=prompt_str,
            input_files=files,
            verify_config=verify_config,
            mcp_servers=mcp_servers,
            skills=skills,
            composio=composio,
            timeout=timeout,
            system_prompt=system_prompt,
            schema=schema,
            operation_id=operation_id,
            base_tag=base_tag,
            retry=retry,
            item_index=index,
            name=name,
            _pipeline_context=_pipeline_context,
        )

    # =========================================================================
    # PRIVATE: FILTER
    # =========================================================================

    async def _execute_filter_item(
        self,
        item: ItemInput,
        prompt: str,
        index: int,
        operation_id: str,
        system_prompt: Optional[str],
        schema: SchemaType,
        schema_options: Optional[Dict[str, Any]],
        agent: Optional[AgentConfig],
        mcp_servers: Optional[Dict[str, Any]],
        skills: Optional[List[str]],
        composio: Optional[ComposioSetup],
        timeout: int,
        attempt: int = 1,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> SwarmResult:
        """Execute a single filter item."""
        original_files = self._get_files(item)
        error_retry = attempt - 1 if attempt > 1 else None
        tag_prefix = (
            f"{self.config.tag}-filter-{index}-er{error_retry}"
            if error_retry
            else f"{self.config.tag}-filter-{index}"
        )

        # Build observability for JSONL
        observability = _filter_none({
            'swarm_name': self.config.tag,
            'operation_name': name,
            'operation_id': operation_id,
            'operation': 'filter',
            'item_index': index,
            'role': 'worker',
            'error_retry': error_retry,
            **self._pipeline_context_to_observability(_pipeline_context),
        })

        async with self.semaphore:
            result = await self._execute(
                context=original_files,
                prompt=prompt,
                system_prompt=system_prompt,
                schema=schema,
                schema_options=schema_options,
                agent=agent,
                mcp_servers=mcp_servers,
                skills=skills,
                composio=composio,
                tag_prefix=tag_prefix,
                timeout=timeout,
                observability=observability,
            )

        meta = IndexedMeta(
            operation_id=operation_id,
            operation="filter",
            tag=result["tag"],
            sandbox_id=result["sandbox_id"],
            swarm_name=self.config.tag,
            operation_name=name,
            error_retry=error_retry,
            item_index=index,
            **self._pipeline_context_to_meta(_pipeline_context),
        )

        # Filter passes through ORIGINAL files, not output
        return self._build_result(result, meta, files_override=original_files)

    async def _execute_filter_item_with_verify(
        self,
        item: ItemInput,
        prompt: str,
        index: int,
        operation_id: str,
        system_prompt: Optional[str],
        schema: SchemaType,
        schema_options: Optional[Dict[str, Any]],
        agent: Optional[AgentConfig],
        mcp_servers: Optional[Dict[str, Any]],
        skills: Optional[List[str]],
        composio: Optional[ComposioSetup],
        verify_config: VerifyConfig,
        timeout: int,
        retry: Optional[RetryConfig] = None,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> SwarmResult:
        """Execute a single filter item with verification."""
        original_files = self._get_files(item)
        base_tag = f"{self.config.tag}-filter-{index}"

        # Worker function that executes filter item (tag_prefix managed by _run_with_verification)
        async def worker_fn(current_prompt: str, tag_prefix: str, attempt_index: Optional[int] = None) -> SwarmResult:
            verify_retry = attempt_index - 1 if attempt_index and attempt_index > 1 else None

            # Build observability for JSONL
            observability = _filter_none({
                'swarm_name': self.config.tag,
                'operation_name': name,
                'operation_id': operation_id,
                'operation': 'filter',
                'item_index': index,
                'role': 'worker',
                'verify_retry': verify_retry,
                **self._pipeline_context_to_observability(_pipeline_context),
            })

            async with self.semaphore:
                result = await self._execute(
                    context=original_files,
                    prompt=current_prompt,
                    system_prompt=system_prompt,
                    schema=schema,
                    schema_options=schema_options,
                    agent=agent,
                    mcp_servers=mcp_servers,
                    skills=skills,
                    composio=composio,
                    tag_prefix=tag_prefix,
                    timeout=timeout,
                    observability=observability,
                )

            meta = IndexedMeta(
                operation_id=operation_id,
                operation="filter",
                tag=result["tag"],
                sandbox_id=result["sandbox_id"],
                swarm_name=self.config.tag,
                operation_name=name,
                verify_retry=verify_retry,
                item_index=index,
                **self._pipeline_context_to_meta(_pipeline_context),
            )

            # Filter passes through ORIGINAL files, not output
            return self._build_result(result, meta, files_override=original_files)

        # Run with verification loop
        return await self._run_with_verification(
            worker_fn=worker_fn,
            original_prompt=prompt,
            input_files=original_files,
            verify_config=verify_config,
            mcp_servers=mcp_servers,
            skills=skills,
            composio=composio,
            timeout=timeout,
            system_prompt=system_prompt,
            schema=schema,
            operation_id=operation_id,
            base_tag=base_tag,
            retry=retry,
            item_index=index,
            name=name,
            _pipeline_context=_pipeline_context,
        )

    # =========================================================================
    # PRIVATE: VERIFY
    # =========================================================================

    async def _run_with_verification(
        self,
        worker_fn: Callable[[str, str, Optional[int]], Any],  # async function(prompt, tag_prefix, attempt_index) -> result
        original_prompt: str,
        input_files: FileMap,
        verify_config: VerifyConfig,
        mcp_servers: Optional[Dict[str, Any]],
        skills: Optional[List[str]],
        composio: Optional[ComposioSetup],
        timeout: int,
        system_prompt: Optional[str],
        schema: Optional[SchemaType],
        operation_id: str,
        base_tag: str,
        retry: Optional[RetryConfig] = None,
        item_index: int = 0,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> Any:
        """Shared verification loop for map, filter, and reduce.

        Runs worker function, verifies output, retries with feedback if needed.

        Args:
            worker_fn: Async function that executes the worker with (prompt, tag_prefix, attempt_index)
            original_prompt: The original user prompt
            input_files: Input files for the worker
            verify_config: Verification configuration
            mcp_servers: MCP servers for verifier (resolved from operation or swarm)
            timeout: Timeout in ms
            system_prompt: Optional system prompt
            schema: Optional schema
            operation_id: Operation ID for metadata
            base_tag: Base tag for worker/verifier
            retry: Optional retry config for verifier error retry
            item_index: Item index for callbacks (default: 0 for reduce)
            name: Operation name for observability
            _pipeline_context: Pipeline context for observability

        Returns:
            Result with verify info attached
        """
        # Resolve verifier MCP servers, skills, and composio
        verifier_mcp_servers = verify_config.verifier_mcp_servers if verify_config.verifier_mcp_servers is not None else mcp_servers
        verifier_skills = verify_config.verifier_skills if verify_config.verifier_skills is not None else skills
        verifier_composio = verify_config.verifier_composio if verify_config.verifier_composio is not None else composio
        max_attempts = verify_config.max_attempts

        current_prompt = original_prompt
        last_result = None
        verify_attempts = 0

        while verify_attempts < max_attempts:
            verify_attempts += 1

            # Build worker tag: base_tag, base_tag-vr1, base_tag-vr2, etc. (vr = verify retry)
            worker_tag = f"{base_tag}-vr{verify_attempts - 1}" if verify_attempts > 1 else base_tag

            # Run worker (with error retry if configured)
            # Worker keeps retry_on (user-specified condition) and gets -er{n} tag suffix for error retries
            if retry:
                async def worker_with_retry(retry_attempt: int = 1):
                    tag = f"{worker_tag}-er{retry_attempt - 1}" if retry_attempt > 1 else worker_tag
                    return await worker_fn(current_prompt, tag, verify_attempts)
                worker_result = await execute_with_retry(worker_with_retry, retry)
            else:
                worker_result = await worker_fn(current_prompt, worker_tag, verify_attempts)

            # If worker failed even after retries, return immediately
            if worker_result.status == "error":
                # Call worker callback with error status
                if verify_config.on_worker_complete:
                    verify_config.on_worker_complete(item_index, verify_attempts, "error")
                return worker_result

            # Call worker callback with success status
            if verify_config.on_worker_complete:
                verify_config.on_worker_complete(item_index, verify_attempts, "success")

            last_result = worker_result

            # Run verification (verifier tag = worker_tag-verify, with error retry like judge)
            if retry:
                async def verify_with_retry(retry_attempt: int = 1):
                    return await self._execute_verify(
                        input_files=input_files,
                        output_files=worker_result.files,
                        task_prompt=current_prompt,
                        config=verify_config,
                        mcp_servers=verifier_mcp_servers,
                        skills=verifier_skills,
                        composio=verifier_composio,
                        timeout=timeout,
                        system_prompt=system_prompt,
                        schema=schema,
                        operation_id=operation_id,
                        worker_tag=worker_tag,
                        retry_attempt=retry_attempt,
                        name=name,
                        _pipeline_context=_pipeline_context,
                    )
                # Use retry but ignore custom retry_on (like judge)
                retry_config = RetryConfig(
                    max_attempts=retry.max_attempts,
                    backoff_ms=retry.backoff_ms,
                    backoff_multiplier=retry.backoff_multiplier,
                )
                verification = await execute_with_retry(verify_with_retry, retry_config)
            else:
                verification = await self._execute_verify(
                    input_files=input_files,
                    output_files=worker_result.files,
                    task_prompt=current_prompt,
                    config=verify_config,
                    mcp_servers=verifier_mcp_servers,
                    skills=verifier_skills,
                    composio=verifier_composio,
                    timeout=timeout,
                    system_prompt=system_prompt,
                    schema=schema,
                    operation_id=operation_id,
                    worker_tag=worker_tag,
                    name=name,
                    _pipeline_context=_pipeline_context,
                )

            # Call verifier callback
            if verify_config.on_verifier_complete:
                verify_config.on_verifier_complete(
                    item_index,
                    verify_attempts,
                    bool(verification.get("passed")),
                    verification.get("feedback"),
                )

            # Build verify meta
            verify_meta = VerifyMeta(
                operation_id=operation_id,
                operation="verify",
                tag=verification["tag"],
                sandbox_id=verification["sandbox_id"],
                swarm_name=self.config.tag,
                operation_name=name,
                attempts=verify_attempts,
                **self._pipeline_context_to_meta(_pipeline_context),
            )

            # If verification passed, return result with verify info
            if verification.get("passed"):
                # Create a new result with verify info attached
                return self._attach_verify_info(
                    worker_result,
                    VerifyInfo(
                        passed=True,
                        reasoning=verification.get("reasoning", ""),
                        verify_meta=verify_meta,
                        attempts=verify_attempts,
                    )
                )

            # If verification failed and we have attempts left, rebuild prompt with feedback
            if verify_attempts < max_attempts:
                feedback = verification.get("feedback") or verification.get("reasoning") or "Output did not meet criteria"
                current_prompt = self._build_retry_prompt_with_feedback(original_prompt, feedback)

        # Max retries exceeded - return last result with error status and verify info
        # Use last worker tag for consistency
        last_worker_tag = f"{base_tag}-vr{verify_attempts - 1}" if verify_attempts > 1 else base_tag
        verify_meta = VerifyMeta(
            operation_id=operation_id,
            operation="verify",
            tag=f"{last_worker_tag}-verifier",
            sandbox_id="",
            swarm_name=self.config.tag,
            operation_name=name,
            attempts=verify_attempts,
            **self._pipeline_context_to_meta(_pipeline_context),
        )

        return self._attach_verify_info(
            last_result,
            VerifyInfo(
                passed=False,
                reasoning="Max verification retries exceeded",
                verify_meta=verify_meta,
                attempts=verify_attempts,
            ),
            force_error=True
        )

    async def _execute_verify(
        self,
        input_files: FileMap,
        output_files: FileMap,
        task_prompt: str,
        config: VerifyConfig,
        mcp_servers: Optional[Dict[str, Any]],
        skills: Optional[List[str]],
        composio: Optional[ComposioSetup],
        timeout: int,
        system_prompt: Optional[str],
        schema: Optional[SchemaType],
        operation_id: str,
        worker_tag: str,
        retry_attempt: int = 1,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> Dict[str, Any]:
        """Execute verifier to check if output meets criteria."""
        # Verifier tag = worker_tag-verifier, with -er{n} suffix for error retries
        error_retry = retry_attempt - 1 if retry_attempt > 1 else None
        tag_prefix = (
            f"{worker_tag}-verifier-er{error_retry}"
            if error_retry
            else f"{worker_tag}-verifier"
        )

        # Build verify context
        context = self._build_verify_context(
            input_files=input_files,
            task_prompt=task_prompt,
            output_files=output_files,
            system_prompt=system_prompt,
            schema=schema,
        )

        # Build verify system prompt
        file_tree = build_file_tree(context)
        verify_system_prompt = apply_template(VERIFY_PROMPT, {
            "criteria": config.criteria,
            "fileTree": file_tree,
        })

        # Verify schema (always JSON Schema dict for simplicity)
        verify_schema = {
            "type": "object",
            "properties": {
                "passed": {"type": "boolean"},
                "reasoning": {"type": "string"},
                "feedback": {"type": "string"},
            },
            "required": ["passed", "reasoning"],
        }

        # Build observability for JSONL
        observability = _filter_none({
            'swarm_name': self.config.tag,
            'operation_name': name,
            'operation_id': operation_id,
            'operation': 'verify',
            'role': 'verifier',
            'error_retry': error_retry,
            **self._pipeline_context_to_observability(_pipeline_context),
        })

        async with self.semaphore:
            result = await self._execute(
                context=context,
                prompt=VERIFY_USER_PROMPT,
                system_prompt=verify_system_prompt,
                schema=verify_schema,
                schema_options=None,
                agent=config.verifier_agent,
                mcp_servers=mcp_servers,
                skills=skills,
                composio=composio,
                tag_prefix=tag_prefix,
                timeout=timeout,
                observability=observability,
            )

        passed = None
        reasoning = "Verification completed"
        feedback = None

        if result.get("data") and not result.get("error"):
            data = result["data"]
            if isinstance(data, dict):
                passed = data.get("passed")
                reasoning = data.get("reasoning", reasoning)
                feedback = data.get("feedback")
        elif result.get("raw_data"):
            # Validation failed but we have raw data - try to extract
            try:
                raw = json.loads(result["raw_data"])
                passed = bool(raw.get("passed"))
                reasoning = raw.get("reasoning", reasoning)
                feedback = raw.get("feedback")
            except Exception:
                warnings.warn(
                    f"Verify validation failed: {result.get('error')}",
                    stacklevel=2
                )

        return {
            "status": "success" if passed is not None else "error",
            "passed": passed,
            "reasoning": reasoning,
            "feedback": feedback,
            "tag": result["tag"],
            "sandbox_id": result["sandbox_id"],
            "error": None if passed is not None else "Verifier failed to produce valid decision",
        }

    def _build_verify_context(
        self,
        input_files: FileMap,
        task_prompt: str,
        output_files: FileMap,
        system_prompt: Optional[str],
        schema: Optional[SchemaType],
    ) -> FileMap:
        """Build verify context containing worker task info and output to verify."""
        # Start with shared worker_task structure
        context = self._build_evaluator_context(
            input_files=input_files,
            task_prompt=task_prompt,
            system_prompt=system_prompt,
            schema=schema,
        )

        # Add output files to verify
        for name, content in output_files.items():
            context[f"worker_output/{name}"] = content

        return context

    def _build_evaluator_context(
        self,
        input_files: FileMap,
        task_prompt: str,
        system_prompt: Optional[str],
        schema: Optional[SchemaType],
    ) -> FileMap:
        """Build evaluator context (shared by judge and verify).

        Creates worker_task/ structure with input files, prompts, schema.
        """
        context: FileMap = {}

        if system_prompt:
            context["worker_task/system_prompt.txt"] = system_prompt
        context["worker_task/user_prompt.txt"] = task_prompt

        json_schema = to_json_schema(schema)
        if json_schema:
            context["worker_task/schema.json"] = json.dumps(json_schema, indent=2)

        for name, content in input_files.items():
            context[f"worker_task/input/{name}"] = content

        return context

    @staticmethod
    def _build_retry_prompt_with_feedback(original_prompt: str, feedback: str) -> str:
        """Build a retry prompt with verifier feedback."""
        return apply_template(RETRY_FEEDBACK_PROMPT, {
            "originalPrompt": original_prompt,
            "feedback": feedback,
        })

    def _attach_verify_info(
        self,
        result: Any,
        verify_info: VerifyInfo,
        force_error: bool = False,
    ) -> Any:
        """Attach verify info to a result, creating a new result object."""
        if isinstance(result, SwarmResult):
            return SwarmResult(
                status="error" if force_error else result.status,
                data=result.data,
                files=result.files,
                meta=result.meta,
                error=result.error,
                raw_data=result.raw_data,
                best_of=result.best_of,
                verify=verify_info,
            )
        elif isinstance(result, ReduceResult):
            return ReduceResult(
                status="error" if force_error else result.status,
                data=result.data,
                files=result.files,
                meta=result.meta,
                error=result.error,
                raw_data=result.raw_data,
                verify=verify_info,
            )
        else:
            # Fallback - just set verify attribute
            result.verify = verify_info
            if force_error:
                result.status = "error"
            return result

    # =========================================================================
    # PRIVATE: BESTOF
    # =========================================================================

    async def _execute_best_of_candidate(
        self,
        input_files: FileMap,
        prompt: str,
        candidate_index: int,
        operation_id: str,
        config: BestOfConfig,
        mcp_servers: Optional[Dict[str, Any]],
        skills: Optional[List[str]],
        composio: Optional[ComposioSetup],
        system_prompt: Optional[str],
        schema: Optional[SchemaType],
        schema_options: Optional[Dict[str, Any]],
        timeout: int,
        parent_index: Optional[int] = None,
        attempt: int = 1,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> SwarmResult:
        """Execute a single bestOf candidate."""
        base_tag = (
            f"{self.config.tag}-map-{parent_index}-bestof-cand-{candidate_index}"
            if parent_index is not None
            else f"{self.config.tag}-bestof-cand-{candidate_index}"
        )
        error_retry = attempt - 1 if attempt > 1 else None
        tag_prefix = f"{base_tag}-er{error_retry}" if error_retry else base_tag

        # Get agent override for this candidate
        candidate_agent = config.task_agents[candidate_index] if config.task_agents and candidate_index < len(config.task_agents) else None

        # Build observability for JSONL (matches TS: operation="map" with role="candidate")
        observability = _filter_none({
            'swarm_name': self.config.tag,
            'operation_id': operation_id,
            'operation': 'map',
            'item_index': parent_index,
            'role': 'candidate',
            'candidate_index': candidate_index,
            'error_retry': error_retry,
            **self._pipeline_context_to_observability(_pipeline_context),
        })

        # Acquire semaphore here (inside retry loop) so it's released during backoff
        async with self.semaphore:
            result = await self._execute(
                context=input_files,
                prompt=prompt,
                system_prompt=system_prompt,
                schema=schema,
                schema_options=schema_options,
                agent=candidate_agent,
                mcp_servers=mcp_servers,
                skills=skills,
                composio=composio,
                tag_prefix=tag_prefix,
                timeout=timeout,
                observability=observability,
            )

        meta = IndexedMeta(
            operation_id=operation_id,
            operation="bestof-cand",
            tag=result["tag"],
            sandbox_id=result["sandbox_id"],
            swarm_name=self.config.tag,
            operation_name=name,
            error_retry=error_retry,
            candidate_index=candidate_index,
            item_index=candidate_index,  # candidate index for this operation
            **self._pipeline_context_to_meta(_pipeline_context),
        )

        return self._build_result(result, meta)

    async def _execute_best_of_judge(
        self,
        input_files: FileMap,
        task_prompt: str,
        candidates: List[SwarmResult],
        config: BestOfConfig,
        mcp_servers: Optional[Dict[str, Any]],
        skills: Optional[List[str]],
        composio: Optional[ComposioSetup],
        timeout: int,
        system_prompt: Optional[str],
        schema: Optional[SchemaType],
        operation_id: str,
        parent_index: Optional[int] = None,
        attempt: int = 1,
        name: Optional[str] = None,
        _pipeline_context: Optional[PipelineContext] = None,
    ) -> Dict[str, Any]:
        """Execute bestOf judge.

        Returns a dict with status field for retry compatibility.
        """
        base_tag = (
            f"{self.config.tag}-map-{parent_index}-bestof-judge"
            if parent_index is not None
            else f"{self.config.tag}-bestof-judge"
        )
        error_retry = attempt - 1 if attempt > 1 else None
        tag_prefix = f"{base_tag}-er{error_retry}" if error_retry else base_tag

        # Build judge context
        context = self._build_judge_context(
            input_files=input_files,
            task_prompt=task_prompt,
            candidates=candidates,
            system_prompt=system_prompt,
            schema=schema,
        )

        # Build judge system prompt
        file_tree = build_file_tree(context)
        judge_system_prompt = apply_template(JUDGE_PROMPT, {
            "candidateCount": str(len(candidates)),
            "criteria": config.judge_criteria,
            "fileTree": file_tree,
        })

        # Judge schema (always JSON Schema dict for simplicity)
        judge_schema = {
            "type": "object",
            "properties": {
                "winner": {"type": "integer", "minimum": 0, "maximum": len(candidates) - 1},
                "reasoning": {"type": "string"},
            },
            "required": ["winner", "reasoning"],
        }

        # Build observability for JSONL (matches TS: operation="map" with role="judge")
        observability = _filter_none({
            'swarm_name': self.config.tag,
            'operation_id': operation_id,
            'operation': 'map',
            'item_index': parent_index,
            'role': 'judge',
            'error_retry': error_retry,
            **self._pipeline_context_to_observability(_pipeline_context),
        })

        # Acquire semaphore here (inside retry loop) so it's released during backoff
        async with self.semaphore:
            result = await self._execute(
                context=context,
                prompt=JUDGE_USER_PROMPT,
                system_prompt=judge_system_prompt,
                schema=judge_schema,
                schema_options=None,
                agent=config.judge_agent,
                mcp_servers=mcp_servers,
                skills=skills,
                composio=composio,
                tag_prefix=tag_prefix,
                timeout=timeout,
                observability=observability,
            )

        winner = None
        reasoning = "Judge failed to provide reasoning"

        if result.get("data") and not result.get("error"):
            data = result["data"]
            if isinstance(data, dict):
                winner = data.get("winner")
                reasoning = data.get("reasoning", reasoning)
        elif result.get("raw_data"):
            # Validation failed but we have raw data - extract reasoning and default winner to 0
            try:
                raw = json.loads(result["raw_data"])
                warnings.warn(
                    f"Judge returned invalid winner {raw.get('winner')}, defaulting to candidate 0",
                    stacklevel=2
                )
                winner = 0
                reasoning = raw.get("reasoning", reasoning)
            except Exception:
                warnings.warn(
                    f"Judge validation failed: {result.get('error')}",
                    stacklevel=2
                )

        return {
            "status": "success" if winner is not None else "error",
            "winner": winner,
            "reasoning": reasoning,
            "tag": result["tag"],
            "sandbox_id": result["sandbox_id"],
            "error": None if winner is not None else "Judge failed to produce valid decision",
        }

    def _build_judge_context(
        self,
        input_files: FileMap,
        task_prompt: str,
        candidates: List[SwarmResult],
        system_prompt: Optional[str],
        schema: Optional[SchemaType],
    ) -> FileMap:
        """Build judge context containing worker task info and candidate outputs."""
        # Start with shared worker_task structure
        context = self._build_evaluator_context(
            input_files=input_files,
            task_prompt=task_prompt,
            system_prompt=system_prompt,
            schema=schema,
        )

        # Add candidate outputs
        for i, c in enumerate(candidates):
            if c.status == "error":
                context[f"candidate_{i}/_failed.txt"] = f"STATUS: FAILED\n\nError: {c.error or 'Unknown error'}"
            for name, content in c.files.items():
                context[f"candidate_{i}/{name}"] = content

        return context

    # =========================================================================
    # PRIVATE: UTILITIES
    # =========================================================================

    def _generate_operation_id(self) -> str:
        """Generate a unique operation ID."""
        return secrets.token_hex(8)

    def _pipeline_context_to_meta(self, ctx: Optional[PipelineContext]) -> Dict[str, Any]:
        """Extract pipeline context fields for meta objects."""
        if not ctx:
            return {}
        return _filter_none({
            'pipeline_run_id': ctx.pipeline_run_id,
            'pipeline_step_index': ctx.pipeline_step_index,
        })

    def _pipeline_context_to_observability(self, ctx: Optional[PipelineContext]) -> Dict[str, Any]:
        """Extract pipeline context fields for observability dict."""
        if not ctx:
            return {}
        return _filter_none({
            'pipeline_run_id': ctx.pipeline_run_id,
            'pipeline_step_index': ctx.pipeline_step_index,
        })

    def _get_files(self, item: ItemInput) -> FileMap:
        """Extract files from an item (FileMap or SwarmResult)."""
        if is_swarm_result(item):
            files = dict(item.files)
            # Rename result.json → data.json for clarity when used as input
            if "result.json" in files:
                files["data.json"] = files.pop("result.json")
            return files
        return item

    def _get_index(self, item: ItemInput, fallback: int) -> int:
        """Get index from item (for SwarmResult) or use fallback."""
        if is_swarm_result(item):
            return item.meta.item_index
        return fallback

    def _resolve_prompt(self, prompt: Prompt, files: FileMap, index: int) -> str:
        """Resolve prompt (string or callable) to string."""
        return prompt(files, index) if callable(prompt) else prompt

    def _build_agent_config(self, override: Optional[AgentConfig]) -> Optional[AgentConfig]:
        """Build agent config with optional override.

        If override provided, merge with base config (keys inherited from base).
        If no override and no base config, return None (TS SDK resolves from env).
        """
        base = self.config.agent
        if override:
            return AgentConfig(
                type=override.type,
                api_key=base.api_key if base else None,
                provider_api_key=base.provider_api_key if base else None,
                oauth_token=base.oauth_token if base else None,
                provider_base_url=base.provider_base_url if base else None,
                model=override.model,
                reasoning_effort=override.reasoning_effort,
            )
        return base

    def _build_result(
        self,
        result: Dict[str, Any],
        meta: IndexedMeta,
        files_override: Optional[FileMap] = None,
    ) -> SwarmResult:
        """Build SwarmResult from execution result."""
        files = files_override if files_override is not None else result["files"]

        if result.get("error"):
            return SwarmResult(
                status="error",
                data=None,
                files=files,
                meta=meta,
                error=result["error"],
                raw_data=result.get("raw_data"),
            )

        return SwarmResult(
            status="success",
            data=result["data"],
            files=files,
            meta=meta,
        )

    def _build_error_result(self, error: str, meta: IndexedMeta) -> SwarmResult:
        """Build error SwarmResult."""
        return SwarmResult(
            status="error",
            data=None,
            files={},
            meta=meta,
            error=error,
        )

