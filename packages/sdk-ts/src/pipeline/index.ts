/**
 * Pipeline - Fluent API for Swarm Operations
 *
 * Thin wrapper over Swarm providing method chaining, timing, and events.
 *
 * @example
 * ```typescript
 * const pipeline = new Pipeline(swarm)
 *   .map({ prompt: "Analyze..." })
 *   .filter({ prompt: "Rate...", schema, condition: d => d.score > 7 })
 *   .reduce({ prompt: "Summarize..." });
 *
 * // Run with items
 * const result = await pipeline.run(documents);
 *
 * // Reusable - run with different data
 * await pipeline.run(batch1);
 * await pipeline.run(batch2);
 * ```
 */

import { randomBytes } from "crypto";
import {
  Swarm,
  type SwarmResult,
  type ReduceResult,
  type ItemInput,
  type FileMap,
  type RetryConfig,
  type VerifyConfig,
  type BestOfConfig,
  type PipelineContext,
} from "../swarm";
import type {
  Step,
  MapConfig,
  FilterConfig,
  ReduceConfig,
  StepResult,
  PipelineResult,
  PipelineEvents,
  PipelineEventMap,
} from "./types";

export * from "./types";

// =============================================================================
// PIPELINE
// =============================================================================

/**
 * Pipeline for chaining Swarm operations.
 *
 * Swarm is bound at construction (infrastructure).
 * Items are passed at execution (data).
 * Pipeline is immutable - each method returns a new instance.
 */
export class Pipeline<T = FileMap> {
  protected readonly swarm: Swarm;
  protected readonly steps: Step[];
  protected readonly events: PipelineEvents;

  constructor(swarm: Swarm, steps: Step[] = [], events: PipelineEvents = {}) {
    this.swarm = swarm;
    this.steps = steps;
    this.events = events;
  }

  // ===========================================================================
  // STEP METHODS
  // ===========================================================================

  /** Add a map step to transform items in parallel. */
  map<U>(config: MapConfig<U>): Pipeline<U> {
    return new Pipeline<U>(
      this.swarm,
      [...this.steps, { type: "map", config: config as MapConfig<unknown> }],
      this.events
    );
  }

  /** Add a filter step to evaluate and filter items. */
  filter<U>(config: FilterConfig<U>): Pipeline<U> {
    return new Pipeline<U>(
      this.swarm,
      [...this.steps, { type: "filter", config: config as FilterConfig<unknown> }],
      this.events
    );
  }

  /** Add a reduce step (terminal - no steps can follow). */
  reduce<U>(config: ReduceConfig<U>): TerminalPipeline<U> {
    return new TerminalPipeline<U>(
      this.swarm,
      [...this.steps, { type: "reduce", config: config as ReduceConfig<unknown> }],
      this.events
    );
  }

  // ===========================================================================
  // EVENTS
  // ===========================================================================

  /**
   * Register event handlers for step lifecycle.
   *
   * Supports two styles:
   * - Object: `.on({ onStepComplete: fn, onItemRetry: fn })`
   * - Chainable: `.on("stepComplete", fn).on("itemRetry", fn)`
   */
  on(handlers: PipelineEvents): Pipeline<T>;
  on<K extends keyof PipelineEventMap>(event: K, handler: PipelineEventMap[K]): Pipeline<T>;
  on(eventOrHandlers: PipelineEvents | keyof PipelineEventMap, handler?: PipelineEventMap[keyof PipelineEventMap]): Pipeline<T> {
    if (typeof eventOrHandlers === "string") {
      // Chainable style: .on("stepComplete", fn)
      const key = `on${eventOrHandlers.charAt(0).toUpperCase()}${eventOrHandlers.slice(1)}` as keyof PipelineEvents;
      return new Pipeline<T>(
        this.swarm,
        this.steps,
        { ...this.events, [key]: handler }
      );
    }
    // Object style: .on({ onStepComplete: fn })
    return new Pipeline<T>(
      this.swarm,
      this.steps,
      { ...this.events, ...eventOrHandlers }
    );
  }

  // ===========================================================================
  // EXECUTION
  // ===========================================================================

  /** Execute the pipeline with the given items. */
  async run(items: ItemInput[]): Promise<PipelineResult<T>> {
    const pipelineRunId = randomBytes(8).toString("hex");
    const stepResults: StepResult<unknown>[] = [];
    let currentItems: ItemInput[] = items;
    const startTime = Date.now();

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      const stepName = step.config.name;
      const stepStart = Date.now();

      this.events.onStepStart?.({
        type: step.type,
        index: i,
        name: stepName,
        itemCount: currentItems.length,
      });

      // Build pipeline context for observability
      // Note: stepName is passed via config.name which gets spread to params.name
      const pipelineContext: PipelineContext = {
        pipelineRunId,
        pipelineStepIndex: i,
      };

      try {
        const result = await this.executeStep(step, currentItems, i, stepName, pipelineContext);
        const durationMs = Date.now() - stepStart;

        stepResults.push({
          type: step.type,
          index: i,
          durationMs,
          results: result.output,
        });

        this.events.onStepComplete?.({
          type: step.type,
          index: i,
          name: stepName,
          durationMs,
          successCount: result.successCount,
          errorCount: result.errorCount,
          filteredCount: result.filteredCount,
        });

        // Reduce is terminal
        if (step.type === "reduce") {
          return {
            pipelineRunId,
            steps: stepResults,
            output: result.output as ReduceResult<T>,
            totalDurationMs: Date.now() - startTime,
          };
        }

        currentItems = result.nextItems;
      } catch (error) {
        this.events.onStepError?.({
          type: step.type,
          index: i,
          name: stepName,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
      }
    }

    const lastResult = stepResults[stepResults.length - 1];
    return {
      pipelineRunId,
      steps: stepResults,
      output: (lastResult?.results ?? []) as SwarmResult<T>[],
      totalDurationMs: Date.now() - startTime,
    };
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private async executeStep(
    step: Step,
    items: ItemInput[],
    stepIndex: number,
    stepName?: string,
    pipelineContext?: PipelineContext
  ): Promise<{
    output: SwarmResult<unknown>[] | ReduceResult<unknown>;
    nextItems: ItemInput[];
    successCount: number;
    errorCount: number;
    filteredCount: number;
  }> {
    if (step.type === "map") {
      const config = step.config as MapConfig<unknown>;
      const results = await this.swarm.map({
        items,
        ...config,
        _pipelineContext: pipelineContext,
        retry: this.wrapRetry(config.retry as RetryConfig, stepIndex, stepName),
        verify: this.wrapVerify(config.verify, stepIndex, stepName),
        bestOf: this.wrapBestOf(config.bestOf, stepIndex, stepName),
      });
      return {
        output: [...results],
        nextItems: results.success,
        successCount: results.success.length,
        errorCount: results.error.length,
        filteredCount: 0,
      };
    }

    if (step.type === "filter") {
      const config = step.config as FilterConfig<unknown>;
      const results = await this.swarm.filter({
        items,
        ...config,
        _pipelineContext: pipelineContext,
        retry: this.wrapRetry(config.retry as RetryConfig, stepIndex, stepName),
        verify: this.wrapVerify(config.verify, stepIndex, stepName),
      });
      const emit = config.emit ?? "success";
      const nextItems =
        emit === "success" ? results.success :
        emit === "filtered" ? results.filtered :
        [...results.success, ...results.filtered];
      return {
        output: [...results],
        nextItems,
        successCount: results.success.length,
        errorCount: results.error.length,
        filteredCount: results.filtered.length,
      };
    }

    // reduce
    const config = step.config as ReduceConfig<unknown>;
    const result = await this.swarm.reduce({
      items,
      ...config,
      _pipelineContext: pipelineContext,
      retry: this.wrapRetry(config.retry as RetryConfig, stepIndex, stepName),
      verify: this.wrapVerify(config.verify, stepIndex, stepName),
    });
    return {
      output: result,
      nextItems: [],
      successCount: result.status === "success" ? 1 : 0,
      errorCount: result.status === "error" ? 1 : 0,
      filteredCount: 0,
    };
  }

  private wrapRetry(
    config: RetryConfig | undefined,
    stepIndex: number,
    stepName?: string
  ): RetryConfig | undefined {
    if (!config) return undefined;
    return {
      ...config,
      onItemRetry: (itemIndex, attempt, error) => {
        config.onItemRetry?.(itemIndex, attempt, error);
        this.events.onItemRetry?.({ stepIndex, stepName, itemIndex, attempt, error });
      },
    };
  }

  private wrapVerify(
    config: VerifyConfig | undefined,
    stepIndex: number,
    stepName?: string
  ): VerifyConfig | undefined {
    if (!config) return undefined;
    return {
      ...config,
      onWorkerComplete: (itemIndex, attempt, status) => {
        config.onWorkerComplete?.(itemIndex, attempt, status);
        this.events.onWorkerComplete?.({ stepIndex, stepName, itemIndex, attempt, status });
      },
      onVerifierComplete: (itemIndex, attempt, passed, feedback) => {
        config.onVerifierComplete?.(itemIndex, attempt, passed, feedback);
        this.events.onVerifierComplete?.({ stepIndex, stepName, itemIndex, attempt, passed, feedback });
      },
    };
  }

  private wrapBestOf(
    config: BestOfConfig | undefined,
    stepIndex: number,
    stepName?: string
  ): BestOfConfig | undefined {
    if (!config) return undefined;
    return {
      ...config,
      onCandidateComplete: (itemIndex, candidateIndex, status) => {
        config.onCandidateComplete?.(itemIndex, candidateIndex, status);
        this.events.onCandidateComplete?.({ stepIndex, stepName, itemIndex, candidateIndex, status });
      },
      onJudgeComplete: (itemIndex, winnerIndex, reasoning) => {
        config.onJudgeComplete?.(itemIndex, winnerIndex, reasoning);
        this.events.onJudgeComplete?.({ stepIndex, stepName, itemIndex, winnerIndex, reasoning });
      },
    };
  }
}

// =============================================================================
// TERMINAL PIPELINE
// =============================================================================

/** Pipeline after reduce - no more steps can be added. */
export class TerminalPipeline<T> extends Pipeline<T> {
  constructor(swarm: Swarm, steps: Step[], events: PipelineEvents) {
    super(swarm, steps, events);
  }

  /**
   * Register event handlers for step lifecycle.
   *
   * Supports two styles:
   * - Object: `.on({ onStepComplete: fn, onItemRetry: fn })`
   * - Chainable: `.on("stepComplete", fn).on("itemRetry", fn)`
   */
  override on(handlers: PipelineEvents): TerminalPipeline<T>;
  override on<K extends keyof PipelineEventMap>(event: K, handler: PipelineEventMap[K]): TerminalPipeline<T>;
  override on(eventOrHandlers: PipelineEvents | keyof PipelineEventMap, handler?: PipelineEventMap[keyof PipelineEventMap]): TerminalPipeline<T> {
    if (typeof eventOrHandlers === "string") {
      const key = `on${eventOrHandlers.charAt(0).toUpperCase()}${eventOrHandlers.slice(1)}` as keyof PipelineEvents;
      return new TerminalPipeline<T>(
        this.swarm,
        this.steps,
        { ...this.events, [key]: handler }
      );
    }
    return new TerminalPipeline<T>(
      this.swarm,
      this.steps,
      { ...this.events, ...eventOrHandlers }
    );
  }

  /** @throws Cannot add steps after reduce */
  override map(): never {
    throw new Error("Cannot add steps after reduce");
  }

  /** @throws Cannot add steps after reduce */
  override filter(): never {
    throw new Error("Cannot add steps after reduce");
  }

  /** @throws Cannot add steps after reduce */
  override reduce(): never {
    throw new Error("Cannot add steps after reduce");
  }
}
