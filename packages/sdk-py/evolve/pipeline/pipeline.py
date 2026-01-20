"""Pipeline - Fluent API for Swarm Operations.

Thin wrapper over Swarm providing method chaining, timing, and events.

Example:
    ```python
    pipeline = (
        Pipeline(swarm)
        .map(MapConfig(prompt="Analyze..."))
        .filter(FilterConfig(
            prompt="Rate quality",
            schema=QualitySchema,
            condition=lambda d: d.score > 7,
        ))
        .reduce(ReduceConfig(prompt="Synthesize..."))
    )

    # Run with items
    result = await pipeline.run(documents)

    # Reusable - run with different data
    await pipeline.run(batch1)
    await pipeline.run(batch2)
    ```
"""

import secrets
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Generic, List, Optional, TypeVar, Union, overload

from ..swarm import Swarm
from ..swarm.types import FileMap, ItemInput, BestOfConfig, VerifyConfig, PipelineContext
from ..swarm.results import SwarmResult, SwarmResultList, ReduceResult
from ..retry import RetryConfig
from .types import (
    Step,
    StepType,
    MapConfig,
    FilterConfig,
    ReduceConfig,
    StepResult,
    PipelineResult,
    PipelineEvents,
    PipelineEventMap,
    StepStartEvent,
    StepCompleteEvent,
    StepErrorEvent,
    ItemRetryEvent,
    WorkerCompleteEvent,
    VerifierCompleteEvent,
    CandidateCompleteEvent,
    JudgeCompleteEvent,
)


T = TypeVar('T')


# =============================================================================
# PIPELINE
# =============================================================================

@dataclass
class Pipeline(Generic[T]):
    """Pipeline for chaining Swarm operations.

    Swarm is bound at construction (infrastructure).
    Items are passed at execution (data).
    Pipeline is immutable - each method returns a new instance.
    """
    _swarm: Swarm
    _steps: List[Step] = field(default_factory=list)
    _events: PipelineEvents = field(default_factory=PipelineEvents)

    # ===========================================================================
    # STEP METHODS
    # ===========================================================================

    def map(self, config: MapConfig[T]) -> 'Pipeline[T]':
        """Add a map step to transform items in parallel."""
        new_steps = self._steps + [Step(type="map", config=config)]
        return Pipeline(
            _swarm=self._swarm,
            _steps=new_steps,
            _events=self._events,
        )

    def filter(self, config: FilterConfig[T]) -> 'Pipeline[T]':
        """Add a filter step to evaluate and filter items."""
        new_steps = self._steps + [Step(type="filter", config=config)]
        return Pipeline(
            _swarm=self._swarm,
            _steps=new_steps,
            _events=self._events,
        )

    def reduce(self, config: ReduceConfig[T]) -> 'TerminalPipeline[T]':
        """Add a reduce step (terminal - no steps can follow)."""
        new_steps = self._steps + [Step(type="reduce", config=config)]
        return TerminalPipeline(
            _swarm=self._swarm,
            _steps=new_steps,
            _events=self._events,
        )

    # ===========================================================================
    # EVENTS
    # ===========================================================================

    @overload
    def on(self, handlers: PipelineEvents) -> 'Pipeline[T]': ...

    @overload
    def on(self, event: str, handler: Callable) -> 'Pipeline[T]': ...

    def on(self, event_or_handlers: Union[PipelineEvents, str], handler: Optional[Callable] = None) -> 'Pipeline[T]':
        """Register event handlers for step lifecycle.

        Supports two styles:
        - Object: .on(PipelineEvents(on_step_complete=fn))
        - Chainable: .on("step_complete", fn)
        """
        if isinstance(event_or_handlers, str):
            # Chainable style: .on("step_complete", fn)
            key = PipelineEventMap.get(event_or_handlers)
            if key is None:
                raise ValueError(f"Unknown event: {event_or_handlers}")
            new_events = replace(self._events, **{key: handler})
        else:
            # Object style: .on(PipelineEvents(...))
            new_events = replace(
                self._events,
                on_step_start=event_or_handlers.on_step_start or self._events.on_step_start,
                on_step_complete=event_or_handlers.on_step_complete or self._events.on_step_complete,
                on_step_error=event_or_handlers.on_step_error or self._events.on_step_error,
                on_item_retry=event_or_handlers.on_item_retry or self._events.on_item_retry,
                on_worker_complete=event_or_handlers.on_worker_complete or self._events.on_worker_complete,
                on_verifier_complete=event_or_handlers.on_verifier_complete or self._events.on_verifier_complete,
                on_candidate_complete=event_or_handlers.on_candidate_complete or self._events.on_candidate_complete,
                on_judge_complete=event_or_handlers.on_judge_complete or self._events.on_judge_complete,
            )
        return Pipeline(
            _swarm=self._swarm,
            _steps=self._steps,
            _events=new_events,
        )

    # ===========================================================================
    # EXECUTION
    # ===========================================================================

    async def run(self, items: List[ItemInput]) -> PipelineResult[T]:
        """Execute the pipeline with the given items."""
        pipeline_run_id = secrets.token_hex(8)
        step_results: List[StepResult] = []
        current_items: List[ItemInput] = list(items)
        start_time = time.time()

        for i, step in enumerate(self._steps):
            step_name = getattr(step.config, 'name', None)
            step_start = time.time()

            if self._events.on_step_start:
                self._events.on_step_start(StepStartEvent(
                    type=step.type,
                    index=i,
                    name=step_name,
                    item_count=len(current_items),
                ))

            # Create PipelineContext for observability
            pipeline_context = PipelineContext(
                pipeline_run_id=pipeline_run_id,
                pipeline_step_index=i,
            )

            try:
                result = await self._execute_step(step, current_items, i, step_name, pipeline_context)
                duration_ms = int((time.time() - step_start) * 1000)

                step_results.append(StepResult(
                    type=step.type,
                    index=i,
                    duration_ms=duration_ms,
                    results=result["output"],
                ))

                if self._events.on_step_complete:
                    self._events.on_step_complete(StepCompleteEvent(
                        type=step.type,
                        index=i,
                        name=step_name,
                        duration_ms=duration_ms,
                        success_count=result["success_count"],
                        error_count=result["error_count"],
                        filtered_count=result["filtered_count"],
                    ))

                # Reduce is terminal
                if step.type == "reduce":
                    return PipelineResult(
                        pipeline_run_id=pipeline_run_id,
                        steps=step_results,
                        output=result["output"],
                        total_duration_ms=int((time.time() - start_time) * 1000),
                    )

                current_items = result["next_items"]

            except Exception as e:
                if self._events.on_step_error:
                    self._events.on_step_error(StepErrorEvent(
                        type=step.type,
                        index=i,
                        name=step_name,
                        error=e,
                    ))
                raise

        last_result = step_results[-1] if step_results else None
        return PipelineResult(
            pipeline_run_id=pipeline_run_id,
            steps=step_results,
            output=last_result.results if last_result else [],
            total_duration_ms=int((time.time() - start_time) * 1000),
        )

    # ===========================================================================
    # PRIVATE
    # ===========================================================================

    async def _execute_step(
        self,
        step: Step,
        items: List[ItemInput],
        step_index: int,
        step_name: Optional[str],
        pipeline_context: PipelineContext,
    ) -> dict:
        """Execute a single step and return results."""
        if step.type == "map":
            config = step.config
            results = await self._swarm.map(
                items=items,
                prompt=config.prompt,
                system_prompt=config.system_prompt,
                schema=config.schema,
                schema_options=config.schema_options,
                agent=config.agent,
                mcp_servers=config.mcp_servers,
                skills=config.skills,
                composio=config.composio,
                best_of=self._wrap_best_of(config.best_of, step_index, step_name),
                verify=self._wrap_verify(config.verify, step_index, step_name),
                retry=self._wrap_retry(config.retry, step_index, step_name),
                timeout_ms=config.timeout_ms,
                name=step_name,
                _pipeline_context=pipeline_context,
            )
            return {
                "output": list(results),
                "next_items": results.success,
                "success_count": len(results.success),
                "error_count": len(results.error),
                "filtered_count": 0,
            }

        if step.type == "filter":
            config = step.config
            results = await self._swarm.filter(
                items=items,
                prompt=config.prompt,
                schema=config.schema,
                condition=config.condition,
                schema_options=config.schema_options,
                system_prompt=config.system_prompt,
                agent=config.agent,
                mcp_servers=config.mcp_servers,
                skills=config.skills,
                composio=config.composio,
                verify=self._wrap_verify(config.verify, step_index, step_name),
                retry=self._wrap_retry(config.retry, step_index, step_name),
                timeout_ms=config.timeout_ms,
                name=step_name,
                _pipeline_context=pipeline_context,
            )
            emit = getattr(config, 'emit', 'success')
            if emit == "success":
                next_items = results.success
            elif emit == "filtered":
                next_items = results.filtered
            else:  # "all"
                next_items = results.success + results.filtered
            return {
                "output": list(results),
                "next_items": next_items,
                "success_count": len(results.success),
                "error_count": len(results.error),
                "filtered_count": len(results.filtered),
            }

        # reduce
        config = step.config
        result = await self._swarm.reduce(
            items=items,
            prompt=config.prompt,
            system_prompt=config.system_prompt,
            schema=config.schema,
            schema_options=config.schema_options,
            agent=config.agent,
            mcp_servers=config.mcp_servers,
            skills=config.skills,
            composio=config.composio,
            verify=self._wrap_verify(config.verify, step_index, step_name),
            retry=self._wrap_retry(config.retry, step_index, step_name),
            timeout_ms=config.timeout_ms,
            name=step_name,
            _pipeline_context=pipeline_context,
        )
        return {
            "output": result,
            "next_items": [],
            "success_count": 1 if result.status == "success" else 0,
            "error_count": 1 if result.status == "error" else 0,
            "filtered_count": 0,
        }

    def _wrap_retry(
        self,
        config: Optional[RetryConfig],
        step_index: int,
        step_name: Optional[str],
    ) -> Optional[RetryConfig]:
        """Wrap retry config to inject pipeline-level callback."""
        if config is None:
            return None

        original_callback = config.on_item_retry

        def wrapped_callback(item_index: int, attempt: int, error: str):
            if original_callback:
                original_callback(item_index, attempt, error)
            if self._events.on_item_retry:
                self._events.on_item_retry(ItemRetryEvent(
                    step_index=step_index,
                    step_name=step_name,
                    item_index=item_index,
                    attempt=attempt,
                    error=error,
                ))

        return RetryConfig(
            max_attempts=config.max_attempts,
            backoff_ms=config.backoff_ms,
            backoff_multiplier=config.backoff_multiplier,
            retry_on=config.retry_on,
            on_item_retry=wrapped_callback,
        )

    def _wrap_verify(
        self,
        config: Optional[VerifyConfig],
        step_index: int,
        step_name: Optional[str],
    ) -> Optional[VerifyConfig]:
        """Wrap verify config to inject pipeline-level callbacks."""
        if config is None:
            return None

        original_worker = config.on_worker_complete
        original_verifier = config.on_verifier_complete

        def wrapped_worker(item_index: int, attempt: int, status: str):
            if original_worker:
                original_worker(item_index, attempt, status)
            if self._events.on_worker_complete:
                self._events.on_worker_complete(WorkerCompleteEvent(
                    step_index=step_index,
                    step_name=step_name,
                    item_index=item_index,
                    attempt=attempt,
                    status=status,
                ))

        def wrapped_verifier(item_index: int, attempt: int, passed: bool, feedback: Optional[str]):
            if original_verifier:
                original_verifier(item_index, attempt, passed, feedback)
            if self._events.on_verifier_complete:
                self._events.on_verifier_complete(VerifierCompleteEvent(
                    step_index=step_index,
                    step_name=step_name,
                    item_index=item_index,
                    attempt=attempt,
                    passed=passed,
                    feedback=feedback,
                ))

        return VerifyConfig(
            criteria=config.criteria,
            max_attempts=config.max_attempts,
            verifier_agent=config.verifier_agent,
            verifier_mcp_servers=config.verifier_mcp_servers,
            verifier_skills=config.verifier_skills,
            verifier_composio=config.verifier_composio,
            on_worker_complete=wrapped_worker,
            on_verifier_complete=wrapped_verifier,
        )

    def _wrap_best_of(
        self,
        config: Optional[BestOfConfig],
        step_index: int,
        step_name: Optional[str],
    ) -> Optional[BestOfConfig]:
        """Wrap bestOf config to inject pipeline-level callbacks."""
        if config is None:
            return None

        original_candidate = config.on_candidate_complete
        original_judge = config.on_judge_complete

        def wrapped_candidate(item_index: int, candidate_index: int, status: str):
            if original_candidate:
                original_candidate(item_index, candidate_index, status)
            if self._events.on_candidate_complete:
                self._events.on_candidate_complete(CandidateCompleteEvent(
                    step_index=step_index,
                    step_name=step_name,
                    item_index=item_index,
                    candidate_index=candidate_index,
                    status=status,
                ))

        def wrapped_judge(item_index: int, winner_index: int, reasoning: str):
            if original_judge:
                original_judge(item_index, winner_index, reasoning)
            if self._events.on_judge_complete:
                self._events.on_judge_complete(JudgeCompleteEvent(
                    step_index=step_index,
                    step_name=step_name,
                    item_index=item_index,
                    winner_index=winner_index,
                    reasoning=reasoning,
                ))

        return BestOfConfig(
            judge_criteria=config.judge_criteria,
            n=config.n,
            task_agents=config.task_agents,
            judge_agent=config.judge_agent,
            mcp_servers=config.mcp_servers,
            judge_mcp_servers=config.judge_mcp_servers,
            skills=config.skills,
            judge_skills=config.judge_skills,
            composio=config.composio,
            judge_composio=config.judge_composio,
            on_candidate_complete=wrapped_candidate,
            on_judge_complete=wrapped_judge,
        )


# =============================================================================
# TERMINAL PIPELINE
# =============================================================================

@dataclass
class TerminalPipeline(Pipeline[T]):
    """Pipeline after reduce - no more steps can be added."""

    def map(self, config: MapConfig) -> 'Pipeline':
        """Cannot add steps after reduce."""
        raise RuntimeError("Cannot add steps after reduce")

    def filter(self, config: FilterConfig) -> 'Pipeline':
        """Cannot add steps after reduce."""
        raise RuntimeError("Cannot add steps after reduce")

    def reduce(self, config: ReduceConfig) -> 'TerminalPipeline':
        """Cannot add steps after reduce."""
        raise RuntimeError("Cannot add steps after reduce")

    @overload
    def on(self, handlers: PipelineEvents) -> 'TerminalPipeline[T]': ...

    @overload
    def on(self, event: str, handler: Callable) -> 'TerminalPipeline[T]': ...

    def on(self, event_or_handlers: Union[PipelineEvents, str], handler: Optional[Callable] = None) -> 'TerminalPipeline[T]':
        """Register event handlers for step lifecycle."""
        if isinstance(event_or_handlers, str):
            key = PipelineEventMap.get(event_or_handlers)
            if key is None:
                raise ValueError(f"Unknown event: {event_or_handlers}")
            new_events = replace(self._events, **{key: handler})
        else:
            new_events = replace(
                self._events,
                on_step_start=event_or_handlers.on_step_start or self._events.on_step_start,
                on_step_complete=event_or_handlers.on_step_complete or self._events.on_step_complete,
                on_step_error=event_or_handlers.on_step_error or self._events.on_step_error,
                on_item_retry=event_or_handlers.on_item_retry or self._events.on_item_retry,
                on_worker_complete=event_or_handlers.on_worker_complete or self._events.on_worker_complete,
                on_verifier_complete=event_or_handlers.on_verifier_complete or self._events.on_verifier_complete,
                on_candidate_complete=event_or_handlers.on_candidate_complete or self._events.on_candidate_complete,
                on_judge_complete=event_or_handlers.on_judge_complete or self._events.on_judge_complete,
            )
        return TerminalPipeline(
            _swarm=self._swarm,
            _steps=self._steps,
            _events=new_events,
        )
