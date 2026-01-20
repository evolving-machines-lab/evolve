/**
 * Swarm Abstractions
 *
 * Functional programming for AI agents.
 *
 * @example
 * ```typescript
 * const swarm = new Swarm({
 *   agent: { type: "claude", apiKey: "..." },
 *   sandbox: createE2BProvider({ apiKey: "..." }),
 * });
 *
 * const analyses = await swarm.map({
 *   items: documents,
 *   prompt: "Analyze this",
 * });
 *
 * const evaluated = await swarm.filter({
 *   items: analyses,
 *   prompt: "Evaluate severity",
 *   schema: SeveritySchema,
 *   condition: r => r.severity === "critical",
 * });
 * // evaluated.success = passed condition
 * // evaluated.filtered = didn't pass condition
 * // evaluated.error = agent errors
 *
 * const report = await swarm.reduce({
 *   items: evaluated.success,
 *   prompt: "Create summary",
 * });
 * ```
 */

import { randomBytes } from "crypto";
import { z } from "zod";
import { Evolve } from "../evolve";
import { DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_MS, MAX_CONCURRENCY } from "../constants";
import { JUDGE_PROMPT, JUDGE_USER_PROMPT, VERIFY_PROMPT, VERIFY_USER_PROMPT, REDUCE_PROMPT, RETRY_FEEDBACK_PROMPT, applyTemplate, buildFileTree } from "../prompts";
import { zodSchemaToJson, jsonSchemaToString, isZodSchema } from "../utils";
import { executeWithRetry } from "../utils/retry";
import type { AgentConfig, SandboxProvider, OutputResult, JsonSchema, SchemaValidationOptions, McpServerConfig, SkillName } from "../types";
import { Semaphore } from "./semaphore";
import {
  SWARM_RESULT_BRAND,
  SwarmResultList,
  type SwarmConfig,
  type BestOfConfig,
  type VerifyConfig,
  type SwarmResult,
  type ReduceResult,
  type BestOfResult,
  type BaseMeta,
  type IndexedMeta,
  type ReduceMeta,
  type JudgeMeta,
  type VerifyMeta,
  type JudgeDecision,
  type VerifyDecision,
  type VerifyInfo,
  type ItemInput,
  type FileMap,
  type Prompt,
  type MapParams,
  type FilterParams,
  type ReduceParams,
  type BestOfParams,
  type AgentOverride,
  type RetryConfig,
  type PipelineContext,
  type ComposioSetup,
} from "./types";

export * from "./types";
export { Semaphore } from "./semaphore";

// =============================================================================
// SWARM CLASS
// =============================================================================

/** Internal resolved config with defaults applied */
interface ResolvedSwarmConfig {
  agent?: AgentConfig;  // Optional - Evolve resolves from env
  sandbox?: SandboxProvider;  // Optional - Evolve resolves from env
  tag: string;
  concurrency: number;
  timeoutMs: number;
  workspaceMode: "knowledge" | "swe";
  retry?: RetryConfig;
  mcpServers?: Record<string, McpServerConfig>;
  skills?: SkillName[];
  composio?: ComposioSetup;
}

export class Swarm {
  private config: ResolvedSwarmConfig;
  private semaphore: Semaphore;

  constructor(config: SwarmConfig = {}) {
    const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
    if (concurrency > MAX_CONCURRENCY) {
      throw new Error(
        `concurrency=${concurrency} exceeds max ${MAX_CONCURRENCY}. ` +
          "For higher parallelism, scale horizontally with multiple processes."
      );
    }

    this.config = {
      agent: config.agent,  // Optional - Evolve resolves from env
      sandbox: config.sandbox,  // Optional - Evolve resolves from env
      tag: config.tag ?? "swarm",
      concurrency,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      workspaceMode: config.workspaceMode ?? "knowledge",
      retry: config.retry,
      mcpServers: config.mcpServers,
      skills: config.skills,
      composio: config.composio,
    };
    this.semaphore = new Semaphore(this.config.concurrency);
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Apply an agent to each item in parallel.
   */
  async map<T = FileMap>(params: MapParams<T>): Promise<SwarmResultList<T>> {
    const { items, prompt, bestOf, verify } = params;
    const retry = params.retry ?? this.config.retry;
    const operationId = this.generateOperationId();
    const timeoutMs = params.timeoutMs ?? this.config.timeoutMs;

    // bestOf and verify are mutually exclusive
    if (bestOf && verify) {
      throw new Error("map() cannot use both bestOf and verify options simultaneously");
    }

    const results = await Promise.all(
      items.map((item, index) => {
        // bestOf has internal per-candidate and judge retry - don't double-wrap
        if (bestOf) {
          return this.executeMapItemWithBestOf<T>(item, prompt, index, operationId, params, timeoutMs, retry);
        }

        // verify has internal retry loop with feedback - don't double-wrap with retry
        if (verify) {
          return this.executeMapItemWithVerify<T>(item, prompt, index, operationId, params, timeoutMs, retry);
        }

        // Wrap with retry if configured (simple map only)
        if (retry) {
          return executeWithRetry(
            (attempt) => this.executeMapItem<T>(item, prompt, index, operationId, params, timeoutMs, attempt),
            retry,
            index
          );
        }
        return this.executeMapItem<T>(item, prompt, index, operationId, params, timeoutMs);
      })
    );

    return SwarmResultList.from(results);
  }

  /**
   * Two-step evaluation: agent assesses each item, then local condition applies threshold.
   *
   * 1. Agent sees context files, evaluates per prompt, outputs result.json matching schema
   * 2. Condition function receives parsed data, returns true (success) or false (filtered)
   *
   * Returns ALL items with status:
   * - "success": passed condition
   * - "filtered": evaluated but didn't pass condition
   * - "error": agent error
   *
   * Use `.success` for passing items, `.filtered` for non-passing.
   */
  async filter<T>(params: FilterParams<T>): Promise<SwarmResultList<T>> {
    const { items, prompt, condition, verify } = params;
    const retry = params.retry ?? this.config.retry;
    const operationId = this.generateOperationId();
    const timeoutMs = params.timeoutMs ?? this.config.timeoutMs;

    const evaluated = await Promise.all(
      items.map((item, index) => {
        // verify has internal retry loop with feedback - don't double-wrap with retry
        if (verify) {
          return this.executeFilterItemWithVerify<T>(item, prompt, index, operationId, params, timeoutMs, retry);
        }

        // Wrap with retry if configured
        if (retry) {
          return executeWithRetry(
            (attempt) => this.executeFilterItem<T>(item, prompt, index, operationId, params, timeoutMs, attempt),
            retry,
            index
          );
        }
        return this.executeFilterItem<T>(item, prompt, index, operationId, params, timeoutMs);
      })
    );

    // Apply condition and set status accordingly
    const results: SwarmResult<T>[] = [];
    for (const r of evaluated) {
      if (r.status === "error") {
        // Already errored, keep as-is
        results.push(r);
      } else if (r.data !== null) {
        try {
          if (condition(r.data as T)) {
            // Passed condition → success
            results.push(r);
          } else {
            // Didn't pass condition → filtered
            results.push({ ...r, status: "filtered" });
          }
        } catch (e) {
          // Condition threw → error
          results.push({
            ...r,
            status: "error",
            data: null,
            error: `Condition function threw: ${(e as Error).message}`,
          });
        }
      }
    }

    return SwarmResultList.from(results);
  }

  /**
   * Synthesize many items into one.
   */
  async reduce<T = FileMap>(params: ReduceParams<T>): Promise<ReduceResult<T>> {
    const { items, prompt, verify } = params;
    const retry = params.retry ?? this.config.retry;
    const operationId = this.generateOperationId();
    const timeoutMs = params.timeoutMs ?? this.config.timeoutMs;

    // Collect files and track original indices
    const allFiles: FileMap[] = [];
    const indices: number[] = [];

    items.forEach((item, i) => {
      allFiles.push(this.getFiles(item));
      indices.push(this.getIndex(item, i));
    });

    // Build context: item_0/, item_1/, etc.
    const context: FileMap = {};
    allFiles.forEach((files, i) => {
      Object.entries(files).forEach(([name, content]) => {
        context[`item_${indices[i]}/${name}`] = content;
      });
    });

    // Build reduce system prompt (context structure + user's systemPrompt)
    const fileTree = buildFileTree(context);
    const reduceContextPrompt = applyTemplate(REDUCE_PROMPT, { fileTree });
    const systemPrompt = params.systemPrompt
      ? `${reduceContextPrompt}\n\n${params.systemPrompt}`
      : reduceContextPrompt;

    // Build meta (sandboxId/tag updated after execution)
    const buildMeta = (
      result: { tag: string; sandboxId: string },
      errorRetry?: number,
      verifyRetry?: number
    ): ReduceMeta => ({
      operationId,
      operation: "reduce",
      tag: result.tag,
      sandboxId: result.sandboxId,
      swarmName: this.config.tag,
      operationName: params.name,
      inputCount: items.length,
      inputIndices: indices,
      errorRetry,
      verifyRetry,
      ...this.pipelineContextToMeta(params._pipelineContext),
    });

    const mcpServers = params.mcpServers ?? this.config.mcpServers;
    const skills = params.skills ?? this.config.skills;
    const composio = params.composio ?? this.config.composio;

    // Shared execution logic
    const executeOnce = async (promptToUse: string, tagPrefix: string, errorRetry?: number, attemptIndex?: number): Promise<ReduceResult<T>> => {
      const result = await this.semaphore.use(() =>
        this.execute(context, promptToUse, {
          systemPrompt: systemPrompt,
          schema: params.schema,
          schemaOptions: params.schemaOptions,
          agent: params.agent,
          mcpServers,
          skills,
          composio,
          tagPrefix,
          timeoutMs,
          observability: {
            swarmName: this.config.tag,
            operationName: params.name,
            operationId,
            operation: "reduce",
            role: "worker",
            errorRetry,
            verifyRetry: attemptIndex && attemptIndex > 1 ? attemptIndex - 1 : undefined,
            ...this.pipelineContextToObservability(params._pipelineContext),
          },
        })
      );
      const meta = buildMeta(result, errorRetry, attemptIndex && attemptIndex > 1 ? attemptIndex - 1 : undefined);
      return result.error
        ? { status: "error", data: null, files: result.files, meta, error: result.error, rawData: result.rawData }
        : { status: "success", data: result.data as T, files: result.files, meta };
    };

    const baseTag = `${this.config.tag}-reduce`;

    // verify has internal retry loop with feedback - don't double-wrap with retry
    if (verify) {
      return this.runWithVerification(
        (currentPrompt: string, tagPrefix: string, attemptIndex?: number) =>
          executeOnce(currentPrompt, tagPrefix, undefined, attemptIndex),
        {
          originalPrompt: prompt,
          inputFiles: context,
          verifyConfig: verify,
          timeoutMs,
          systemPrompt: systemPrompt,
          schema: params.schema,
          mcpServers,
          skills,
          composio,
          operationId,
          baseTag,
          retry,
          operation: "reduce",
          _pipelineContext: params._pipelineContext,
        }
      );
    }

    // Wrap with retry if configured (uses shared retry utility)
    if (retry) {
      return executeWithRetry((attempt: number) => {
        const errorRetry = attempt > 1 ? attempt - 1 : undefined;
        const tagPrefix = errorRetry ? `${baseTag}-er${errorRetry}` : baseTag;
        return executeOnce(prompt, tagPrefix, errorRetry);
      }, retry);
    }

    return executeOnce(prompt, baseTag);
  }

  /**
   * Run N candidates on the same task, judge picks the best.
   */
  async bestOf<T = FileMap>(params: BestOfParams<T>): Promise<BestOfResult<T>> {
    const { item, prompt, config } = params;
    const retry = params.retry ?? this.config.retry;

    // Resolve n: explicit or inferred from taskAgents
    const n = config.n ?? config.taskAgents?.length;
    if (n === undefined) {
      throw new Error("bestOf requires n or taskAgents");
    }
    if (n < 2) {
      throw new Error("bestOf requires n >= 2");
    }

    const operationId = this.generateOperationId();
    const timeoutMs = params.timeoutMs ?? this.config.timeoutMs;
    const inputFiles = this.getFiles(item);

    // Resolve MCP servers for candidates and judge
    const candidateMcpServers = config.mcpServers ?? this.config.mcpServers;
    const judgeMcpServers = config.judgeMcpServers ?? config.mcpServers ?? this.config.mcpServers;

    // Resolve skills for candidates and judge (same pattern as mcpServers)
    const candidateSkills = config.skills ?? this.config.skills;
    const judgeSkills = config.judgeSkills ?? config.skills ?? this.config.skills;

    // Resolve composio for candidates and judge (same pattern as mcpServers/skills)
    const candidateComposio = config.composio ?? this.config.composio;
    const judgeComposio = config.judgeComposio ?? config.composio ?? this.config.composio;

    // Run candidates (semaphore inside executeBestOfCandidate)
    const candidates = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const result = retry
          ? await executeWithRetry(
              (attempt) => this.executeBestOfCandidate<T>({
                inputFiles, prompt, candidateIndex: i, operationId, config,
                systemPrompt: params.systemPrompt, schema: params.schema,
                schemaOptions: params.schemaOptions, mcpServers: candidateMcpServers,
                skills: candidateSkills,
                composio: candidateComposio,
                timeoutMs, attempt,
              }),
              retry,
              i
            )
          : await this.executeBestOfCandidate<T>({
              inputFiles, prompt, candidateIndex: i, operationId, config,
              systemPrompt: params.systemPrompt, schema: params.schema,
              schemaOptions: params.schemaOptions, mcpServers: candidateMcpServers,
              skills: candidateSkills,
              composio: candidateComposio,
              timeoutMs,
            });
        // Emit candidate complete event (itemIndex=0 for standalone bestOf)
        config.onCandidateComplete?.(0, i, result.status === "success" ? "success" : "error");
        return result;
      })
    );

    // Run judge (semaphore inside executeBestOfJudge)
    // Judge uses default retry (status === "error"), not custom retryOn
    const judge = retry
      ? await executeWithRetry(
          (attempt) => this.executeBestOfJudge({
            inputFiles, taskPrompt: prompt, candidates, config, timeoutMs, operationId,
            systemPrompt: params.systemPrompt, schema: params.schema,
            schemaOptions: params.schemaOptions, mcpServers: judgeMcpServers,
            skills: judgeSkills,
            composio: judgeComposio,
            attempt,
          }),
          { ...retry, retryOn: undefined },
          0
        )
      : await this.executeBestOfJudge({
          inputFiles, taskPrompt: prompt, candidates, config, timeoutMs, operationId,
          systemPrompt: params.systemPrompt, schema: params.schema,
          schemaOptions: params.schemaOptions, mcpServers: judgeMcpServers,
          skills: judgeSkills,
          composio: judgeComposio,
        });

    const firstSuccess = candidates.findIndex((c) => c.status === "success");
    const winnerIndex = judge.decision?.winner ?? (firstSuccess >= 0 ? firstSuccess : 0);

    // Emit judge complete event (itemIndex=0 for standalone bestOf)
    config.onJudgeComplete?.(0, winnerIndex, judge.decision?.reasoning ?? "Judge failed to provide reasoning");

    const judgeMeta: JudgeMeta = {
      operationId,
      operation: "bestof-judge",
      tag: judge.tag,
      sandboxId: judge.sandboxId,
      swarmName: this.config.tag,
      operationName: params.name,
      candidateCount: n,
    };

    return {
      winner: candidates[winnerIndex] ?? candidates[0],
      winnerIndex,
      judgeReasoning: judge.decision?.reasoning ?? "Judge failed to provide reasoning",
      judgeMeta,
      candidates,
    };
  }

  // ===========================================================================
  // PRIVATE: EXECUTION
  // ===========================================================================

  private async execute(
    context: FileMap,
    prompt: string,
    opts: {
      systemPrompt?: string; // Passed directly to kit.withSystemPrompt()
      schema?: z.ZodType<unknown> | JsonSchema; // Triggers SCHEMA_PROMPT + validation
      schemaOptions?: SchemaValidationOptions; // For JSON Schema only
      agent?: AgentOverride;
      mcpServers?: Record<string, McpServerConfig>;
      skills?: SkillName[];
      composio?: ComposioSetup;
      tagPrefix: string;
      timeoutMs: number;
      /** Observability metadata for trace grouping */
      observability?: Record<string, unknown>;
    }
  ): Promise<{ files: FileMap; data: unknown; tag: string; sandboxId: string; error?: string; rawData?: string }> {
    let kit: Evolve | null = null;
    let sandboxId = "";
    let tag = opts.tagPrefix;
    let files: FileMap = {};
    let data: unknown = null;
    let error: string | undefined;
    let rawData: string | undefined;

    // Merge override with defaults (override wins)
    const agentConfig: AgentConfig = { ...this.config.agent, ...opts.agent };

    try {
      kit = new Evolve()
        .withAgent(agentConfig)
        .withSandbox(this.config.sandbox)
        .withWorkspaceMode(this.config.workspaceMode)
        .withSessionTagPrefix(opts.tagPrefix);

      // withSchema() handles both SCHEMA_PROMPT generation and validation
      if (opts.schema) {
        kit.withSchema(opts.schema, opts.schemaOptions);
      }

      // Pass system prompt directly to Evolve (handles SYSTEM_PROMPT wrapping)
      if (opts.systemPrompt) {
        kit.withSystemPrompt(opts.systemPrompt);
      }

      // Configure MCP servers
      if (opts.mcpServers) {
        kit.withMcpServers(opts.mcpServers);
      }

      // Configure skills
      if (opts.skills?.length) {
        kit.withSkills(opts.skills);
      }

      // Configure Composio
      if (opts.composio) {
        kit.withComposio(opts.composio.userId, opts.composio.config);
      }

      // Pass observability metadata for trace grouping
      if (opts.observability) {
        kit.withObservability(opts.observability);
      }

      // Upload context
      if (Object.keys(context).length > 0) kit.withContext(context);

      // Run agent
      const result = await kit.run({ prompt, timeoutMs: opts.timeoutMs });
      sandboxId = result.sandboxId;
      tag = kit.getSessionTag() ?? opts.tagPrefix;

      // Get output files with automatic validation (handled by withSchema())
      let output: OutputResult<unknown> | null = null;
      try {
        output = await kit.getOutputFiles(true);
        files = output.files;
      } catch {
        // Sandbox may be gone, keep files empty
      }

      if (result.exitCode !== 0) {
        error = `Agent exited with code ${result.exitCode}`;
      } else if (opts.schema) {
        if (output) {
          // Schema validation handled by core SDK
          data = output.data;
          if (output.error) error = output.error;
          if (output.rawData) rawData = output.rawData;
        } else {
          error = "Failed to read output files from sandbox";
        }
      } else {
        data = files;
      }
    } catch (e) {
      error = (e as Error).message;
      if (kit) {
        tag = kit.getSessionTag() ?? opts.tagPrefix;
        // Try to capture partial output even on failure (e.g., timeout)
        try {
          const output = await kit.getOutputFiles(true);
          files = output.files;
        } catch {
          // Sandbox may already be gone
        }
      }
    } finally {
      if (kit) {
        await kit.kill().catch(() => {});
      }
    }

    return { files, data, tag, sandboxId, error, rawData };
  }

  // ===========================================================================
  // PRIVATE: MAP
  // ===========================================================================

  private async executeMapItem<T>(
    item: ItemInput,
    prompt: Prompt,
    index: number,
    operationId: string,
    params: MapParams<T>,
    timeoutMs: number,
    attempt: number = 1
  ): Promise<SwarmResult<T>> {
    const files = this.getFiles(item);
    const tagPrefix = attempt > 1
      ? `${this.config.tag}-map-${index}-er${attempt - 1}`
      : `${this.config.tag}-map-${index}`;

    const promptStr = this.evaluatePrompt(prompt, files, index);
    if (promptStr instanceof Error) {
      return this.buildErrorResult<T>(
        `Prompt function threw: ${promptStr.message}`,
        { operationId, operation: "map", tag: tagPrefix, sandboxId: "", itemIndex: index }
      );
    }

    const mcpServers = params.mcpServers ?? this.config.mcpServers;
    const skills = params.skills ?? this.config.skills;
    const composio = params.composio ?? this.config.composio;

    const result = await this.semaphore.use(() =>
      this.execute(files, promptStr, {
        systemPrompt: params.systemPrompt,
        schema: params.schema,
        schemaOptions: params.schemaOptions,
        agent: params.agent,
        mcpServers,
        skills,
        composio,
        tagPrefix,
        timeoutMs,
        observability: {
          swarmName: this.config.tag,
          operationName: params.name,
          operationId,
          operation: "map",
          itemIndex: index,
          role: "worker",
          errorRetry: attempt > 1 ? attempt - 1 : undefined,
          ...this.pipelineContextToObservability(params._pipelineContext),
        },
      })
    );

    const meta: IndexedMeta = {
      operationId,
      operation: "map",
      tag: result.tag,
      sandboxId: result.sandboxId,
      swarmName: this.config.tag,
      operationName: params.name,
      itemIndex: index,
      errorRetry: attempt > 1 ? attempt - 1 : undefined,
      ...this.pipelineContextToMeta(params._pipelineContext),
    };

    return this.buildResult<T>(result, meta);
  }

  private async executeMapItemWithVerify<T>(
    item: ItemInput,
    prompt: Prompt,
    index: number,
    operationId: string,
    params: MapParams<T>,
    timeoutMs: number,
    retry?: RetryConfig<SwarmResult<T>>
  ): Promise<SwarmResult<T>> {
    const files = this.getFiles(item);
    const baseTag = `${this.config.tag}-map-${index}`;
    const verifyConfig = params.verify!;
    const mcpServers = params.mcpServers ?? this.config.mcpServers;
    const skills = params.skills ?? this.config.skills;
    const composio = params.composio ?? this.config.composio;

    const promptStr = this.evaluatePrompt(prompt, files, index);
    if (promptStr instanceof Error) {
      return this.buildErrorResult<T>(
        `Prompt function threw: ${promptStr.message}`,
        { operationId, operation: "map", tag: baseTag, sandboxId: "", itemIndex: index }
      );
    }

    // Worker function that executes map item (tagPrefix managed by runWithVerification)
    const workerFn = async (currentPrompt: string, tagPrefix: string, attemptIndex?: number): Promise<SwarmResult<T>> => {
      const result = await this.semaphore.use(() =>
        this.execute(files, currentPrompt, {
          systemPrompt: params.systemPrompt,
          schema: params.schema,
          schemaOptions: params.schemaOptions,
          agent: params.agent,
          mcpServers,
          skills,
          composio,
          tagPrefix,
          timeoutMs,
          observability: {
            swarmName: this.config.tag,
            operationName: params.name,
            operationId,
            operation: "map",
            itemIndex: index,
            role: "worker",
            verifyRetry: attemptIndex && attemptIndex > 1 ? attemptIndex - 1 : undefined,
            ...this.pipelineContextToObservability(params._pipelineContext),
          },
        })
      );

      const meta: IndexedMeta = {
        operationId,
        operation: "map",
        tag: result.tag,
        sandboxId: result.sandboxId,
        swarmName: this.config.tag,
        operationName: params.name,
        itemIndex: index,
        verifyRetry: attemptIndex && attemptIndex > 1 ? attemptIndex - 1 : undefined,
        ...this.pipelineContextToMeta(params._pipelineContext),
      };

      return this.buildResult<T>(result, meta);
    };

    // Run with verification loop
    return this.runWithVerification(workerFn, {
      originalPrompt: promptStr,
      inputFiles: files,
      verifyConfig,
      timeoutMs,
      systemPrompt: params.systemPrompt,
      schema: params.schema,
      mcpServers,
      skills,
      composio,
      operationId,
      baseTag,
      retry,
      itemIndex: index,
      operation: "map",
      _pipelineContext: params._pipelineContext,
    });
  }

  private async executeMapItemWithBestOf<T>(
    item: ItemInput,
    prompt: Prompt,
    index: number,
    operationId: string,
    params: MapParams<T>,
    timeoutMs: number,
    retry?: RetryConfig<SwarmResult<T>>
  ): Promise<SwarmResult<T>> {
    const files = this.getFiles(item);
    const tagPrefix = `${this.config.tag}-map-${index}`;

    const promptStr = this.evaluatePrompt(prompt, files, index);
    if (promptStr instanceof Error) {
      return this.buildErrorResult<T>(
        `Prompt function threw: ${promptStr.message}`,
        { operationId, operation: "map", tag: tagPrefix, sandboxId: "", itemIndex: index }
      );
    }

    const bestOfConfig = params.bestOf!;
    const n = bestOfConfig.n ?? bestOfConfig.taskAgents?.length;
    if (n === undefined || n < 2) {
      return this.buildErrorResult<T>(
        "bestOf requires n >= 2 or taskAgents with at least 2 elements",
        { operationId, operation: "map", tag: tagPrefix, sandboxId: "", itemIndex: index }
      );
    }

    // Resolve MCP servers for candidates and judge
    const operationMcpServers = params.mcpServers ?? this.config.mcpServers;
    const candidateMcpServers = bestOfConfig.mcpServers ?? operationMcpServers;
    const judgeMcpServers = bestOfConfig.judgeMcpServers ?? bestOfConfig.mcpServers ?? operationMcpServers;

    // Resolve skills for candidates and judge
    const operationSkills = params.skills ?? this.config.skills;
    const candidateSkills = bestOfConfig.skills ?? operationSkills;
    const judgeSkills = bestOfConfig.judgeSkills ?? bestOfConfig.skills ?? operationSkills;

    // Resolve composio for candidates and judge
    const operationComposio = params.composio ?? this.config.composio;
    const candidateComposio = bestOfConfig.composio ?? operationComposio;
    const judgeComposio = bestOfConfig.judgeComposio ?? bestOfConfig.composio ?? operationComposio;

    // Run candidates (semaphore inside executeBestOfCandidate)
    const candidates = await Promise.all(
      Array.from({ length: n }, async (_, candidateIndex) => {
        const result = retry
          ? await executeWithRetry(
              (attempt) => this.executeBestOfCandidate<T>({
                inputFiles: files, prompt: promptStr, candidateIndex, operationId,
                config: bestOfConfig, systemPrompt: params.systemPrompt,
                schema: params.schema, schemaOptions: params.schemaOptions,
                mcpServers: candidateMcpServers,
                skills: candidateSkills,
                composio: candidateComposio,
                timeoutMs, parentIndex: index, attempt,
                _pipelineContext: params._pipelineContext,
              }),
              retry,
              candidateIndex
            )
          : await this.executeBestOfCandidate<T>({
              inputFiles: files, prompt: promptStr, candidateIndex, operationId,
              config: bestOfConfig, systemPrompt: params.systemPrompt,
              schema: params.schema, schemaOptions: params.schemaOptions,
              mcpServers: candidateMcpServers,
              skills: candidateSkills,
              composio: candidateComposio,
              timeoutMs, parentIndex: index,
              _pipelineContext: params._pipelineContext,
            });
        // Emit candidate complete event
        bestOfConfig.onCandidateComplete?.(index, candidateIndex, result.status === "success" ? "success" : "error");
        return result;
      })
    );

    // Run judge (semaphore inside executeBestOfJudge)
    // Judge uses default retry (status === "error"), not custom retryOn
    const judge = retry
      ? await executeWithRetry(
          (attempt) => this.executeBestOfJudge({
            inputFiles: files, taskPrompt: promptStr, candidates,
            config: bestOfConfig, timeoutMs, operationId, systemPrompt: params.systemPrompt,
            schema: params.schema, schemaOptions: params.schemaOptions,
            mcpServers: judgeMcpServers,
            skills: judgeSkills,
            composio: judgeComposio,
            parentIndex: index, attempt,
            _pipelineContext: params._pipelineContext,
          }),
          { ...retry, retryOn: undefined },
          0
        )
      : await this.executeBestOfJudge({
          inputFiles: files, taskPrompt: promptStr, candidates,
          config: bestOfConfig, timeoutMs, operationId, systemPrompt: params.systemPrompt,
          schema: params.schema, schemaOptions: params.schemaOptions,
          mcpServers: judgeMcpServers,
          skills: judgeSkills,
          composio: judgeComposio,
          parentIndex: index,
          _pipelineContext: params._pipelineContext,
        });

    const firstSuccess = candidates.findIndex((c) => c.status === "success");
    const winnerIndex = judge.decision?.winner ?? (firstSuccess >= 0 ? firstSuccess : 0);
    const winner = candidates[winnerIndex] ?? candidates[0];

    // Emit judge complete event
    bestOfConfig.onJudgeComplete?.(index, winnerIndex, judge.decision?.reasoning ?? "Judge failed to provide reasoning");

    const judgeMeta: JudgeMeta = {
      operationId,
      operation: "bestof-judge",
      tag: judge.tag,
      sandboxId: judge.sandboxId,
      swarmName: this.config.tag,
      operationName: params.name,
      candidateCount: n,
      ...this.pipelineContextToMeta(params._pipelineContext),
    };

    // Return winner with map operation and bestOf observability data
    return {
      ...winner,
      meta: {
        ...winner.meta,
        operation: "map",
        swarmName: this.config.tag,
        operationName: params.name,
        itemIndex: index,
        ...this.pipelineContextToMeta(params._pipelineContext),
      },
      bestOf: {
        winnerIndex,
        judgeReasoning: judge.decision?.reasoning ?? "Judge failed to provide reasoning",
        judgeMeta,
        candidates,
      },
    };
  }

  // ===========================================================================
  // PRIVATE: FILTER
  // ===========================================================================

  private async executeFilterItem<T>(
    item: ItemInput,
    prompt: string,
    index: number,
    operationId: string,
    params: FilterParams<T>,
    timeoutMs: number,
    attempt: number = 1
  ): Promise<SwarmResult<T>> {
    const originalFiles = this.getFiles(item);
    const tagPrefix = attempt > 1
      ? `${this.config.tag}-filter-${index}-er${attempt - 1}`
      : `${this.config.tag}-filter-${index}`;
    const mcpServers = params.mcpServers ?? this.config.mcpServers;
    const skills = params.skills ?? this.config.skills;
    const composio = params.composio ?? this.config.composio;

    const result = await this.semaphore.use(() =>
      this.execute(originalFiles, prompt, {
        systemPrompt: params.systemPrompt,
        schema: params.schema,
        schemaOptions: params.schemaOptions,
        agent: params.agent,
        mcpServers,
        skills,
        composio,
        tagPrefix,
        timeoutMs,
        observability: {
          swarmName: this.config.tag,
          operationName: params.name,
          operationId,
          operation: "filter",
          itemIndex: index,
          role: "worker",
          errorRetry: attempt > 1 ? attempt - 1 : undefined,
          ...this.pipelineContextToObservability(params._pipelineContext),
        },
      })
    );

    const meta: IndexedMeta = {
      operationId,
      operation: "filter",
      tag: result.tag,
      sandboxId: result.sandboxId,
      swarmName: this.config.tag,
      operationName: params.name,
      itemIndex: index,
      errorRetry: attempt > 1 ? attempt - 1 : undefined,
      ...this.pipelineContextToMeta(params._pipelineContext),
    };

    // Filter passes through ORIGINAL files, not output
    return this.buildResult<T>(result, meta, originalFiles);
  }

  private async executeFilterItemWithVerify<T>(
    item: ItemInput,
    prompt: string,
    index: number,
    operationId: string,
    params: FilterParams<T>,
    timeoutMs: number,
    retry?: RetryConfig<SwarmResult<T>>
  ): Promise<SwarmResult<T>> {
    const originalFiles = this.getFiles(item);
    const baseTag = `${this.config.tag}-filter-${index}`;
    const verifyConfig = params.verify!;
    const mcpServers = params.mcpServers ?? this.config.mcpServers;
    const skills = params.skills ?? this.config.skills;
    const composio = params.composio ?? this.config.composio;

    // Worker function that executes filter item (tagPrefix managed by runWithVerification)
    const workerFn = async (currentPrompt: string, tagPrefix: string, attemptIndex?: number): Promise<SwarmResult<T>> => {
      const result = await this.semaphore.use(() =>
        this.execute(originalFiles, currentPrompt, {
          systemPrompt: params.systemPrompt,
          schema: params.schema,
          schemaOptions: params.schemaOptions,
          agent: params.agent,
          mcpServers,
          skills,
          composio,
          tagPrefix,
          timeoutMs,
          observability: {
            swarmName: this.config.tag,
            operationName: params.name,
            operationId,
            operation: "filter",
            itemIndex: index,
            role: "worker",
            verifyRetry: attemptIndex && attemptIndex > 1 ? attemptIndex - 1 : undefined,
            ...this.pipelineContextToObservability(params._pipelineContext),
          },
        })
      );

      const meta: IndexedMeta = {
        operationId,
        operation: "filter",
        tag: result.tag,
        sandboxId: result.sandboxId,
        swarmName: this.config.tag,
        operationName: params.name,
        itemIndex: index,
        verifyRetry: attemptIndex && attemptIndex > 1 ? attemptIndex - 1 : undefined,
        ...this.pipelineContextToMeta(params._pipelineContext),
      };

      // Filter passes through ORIGINAL files, not output
      return this.buildResult<T>(result, meta, originalFiles);
    };

    // Run with verification loop
    return this.runWithVerification(workerFn, {
      originalPrompt: prompt,
      inputFiles: originalFiles,
      verifyConfig,
      timeoutMs,
      systemPrompt: params.systemPrompt,
      schema: params.schema,
      mcpServers,
      skills,
      composio,
      operationId,
      baseTag,
      retry,
      itemIndex: index,
      operation: "filter",
      _pipelineContext: params._pipelineContext,
    });
  }

  // ===========================================================================
  // PRIVATE: BESTOF
  // ===========================================================================

  /**
   * Execute a single bestOf candidate.
   * Used by both standalone bestOf() and map() with bestOf option.
   */
  private async executeBestOfCandidate<T>(params: {
    inputFiles: FileMap;
    prompt: string;
    candidateIndex: number;
    operationId: string;
    config: BestOfConfig;
    systemPrompt?: string;
    schema?: z.ZodType<T> | JsonSchema;
    schemaOptions?: SchemaValidationOptions;
    mcpServers?: Record<string, McpServerConfig>;
    skills?: SkillName[];
    composio?: ComposioSetup;
    timeoutMs: number;
    parentIndex?: number;
    attempt?: number;
    _pipelineContext?: PipelineContext;
  }): Promise<SwarmResult<T>> {
    const { inputFiles, prompt, candidateIndex, operationId, config, timeoutMs, parentIndex, attempt = 1, _pipelineContext } = params;

    // Use cand-{candidate} format for clarity (map+bestOf and standalone bestOf)
    const baseTag =
      parentIndex !== undefined
        ? `${this.config.tag}-map-${parentIndex}-bestof-cand-${candidateIndex}`
        : `${this.config.tag}-bestof-cand-${candidateIndex}`;
    const tagPrefix = attempt > 1 ? `${baseTag}-er${attempt - 1}` : baseTag;

    const result = await this.semaphore.use(() =>
      this.execute(inputFiles, prompt, {
        systemPrompt: params.systemPrompt,
        schema: params.schema,
        schemaOptions: params.schemaOptions,
        agent: config.taskAgents?.[candidateIndex],
        mcpServers: params.mcpServers,
        skills: params.skills,
        composio: params.composio,
        tagPrefix,
        timeoutMs,
        observability: {
          swarmName: this.config.tag,
          operationId,
          operation: "map",  // bestOf is part of map operation
          itemIndex: parentIndex,
          role: "candidate",
          candidateIndex,
          errorRetry: attempt > 1 ? attempt - 1 : undefined,
          ...this.pipelineContextToObservability(_pipelineContext),
        },
      })
    );

    const meta: IndexedMeta = {
      operationId,
      operation: "bestof-cand",
      tag: result.tag,
      sandboxId: result.sandboxId,
      swarmName: this.config.tag,
      itemIndex: candidateIndex,
      errorRetry: attempt > 1 ? attempt - 1 : undefined,
      candidateIndex,
      ...this.pipelineContextToMeta(_pipelineContext),
    };

    return this.buildResult<T>(result, meta);
  }

  /**
   * Build judge context containing worker task info and candidate outputs.
   */
  private buildJudgeContext(params: {
    inputFiles: FileMap;
    taskPrompt: string;
    candidates: SwarmResult<unknown>[];
    systemPrompt?: string;
    schema?: z.ZodType<unknown> | JsonSchema;
  }): FileMap {
    // Start with shared worker_task structure
    const context = this.buildEvaluatorContext({
      inputFiles: params.inputFiles,
      taskPrompt: params.taskPrompt,
      systemPrompt: params.systemPrompt,
      schema: params.schema,
    });

    // Add candidate outputs
    params.candidates.forEach((c, i) => {
      if (c.status === "error") {
        context[`candidate_${i}/_failed.txt`] = `STATUS: FAILED\n\nError: ${c.error ?? "Unknown error"}`;
      }
      Object.entries(c.files).forEach(([name, content]) => {
        context[`candidate_${i}/${name}`] = content;
      });
    });

    return context;
  }

  /**
   * Execute judge to pick best candidate.
   * Returns RetryableResult-compatible type for use with executeWithRetry.
   */
  private async executeBestOfJudge(params: {
    inputFiles: FileMap;
    taskPrompt: string;
    candidates: SwarmResult<unknown>[];
    config: BestOfConfig;
    timeoutMs: number;
    operationId: string;
    systemPrompt?: string;
    schema?: z.ZodType<unknown> | JsonSchema;
    schemaOptions?: SchemaValidationOptions;
    mcpServers?: Record<string, McpServerConfig>;
    skills?: SkillName[];
    composio?: ComposioSetup;
    parentIndex?: number;
    attempt?: number;
    _pipelineContext?: PipelineContext;
  }): Promise<{ status: "success" | "error"; decision: JudgeDecision | null; tag: string; sandboxId: string; error?: string }> {
    const { candidates, config, timeoutMs, operationId, parentIndex, attempt = 1, _pipelineContext } = params;

    // Build tag for traceability
    const baseTag =
      parentIndex !== undefined
        ? `${this.config.tag}-map-${parentIndex}-bestof-judge`
        : `${this.config.tag}-bestof-judge`;
    const tagPrefix = attempt > 1 ? `${baseTag}-er${attempt - 1}` : baseTag;

    // Build judge context
    const context = this.buildJudgeContext({
      inputFiles: params.inputFiles,
      taskPrompt: params.taskPrompt,
      candidates: candidates,
      systemPrompt: params.systemPrompt,
      schema: params.schema,
    });

    // Build judge system prompt
    const fileTree = buildFileTree(context);
    const judgeSystemPrompt = applyTemplate(JUDGE_PROMPT, {
      candidateCount: String(candidates.length),
      criteria: config.judgeCriteria,
      fileTree,
    });

    const judgeSchema = z.object({
      winner: z.number().min(0).max(candidates.length - 1),
      reasoning: z.string(),
    });

    const result = await this.semaphore.use(() =>
      this.execute(context, JUDGE_USER_PROMPT, {
        systemPrompt: judgeSystemPrompt,
        schema: judgeSchema,
        agent: config.judgeAgent,
        mcpServers: params.mcpServers,
        skills: params.skills,
        composio: params.composio,
        tagPrefix,
        timeoutMs,
        observability: {
          swarmName: this.config.tag,
          operationId,
          operation: "map",  // bestOf is part of map operation
          itemIndex: parentIndex,
          role: "judge",
          errorRetry: attempt > 1 ? attempt - 1 : undefined,
          ...this.pipelineContextToObservability(_pipelineContext),
        },
      })
    );

    let decision: JudgeDecision | null = null;
    if (result.data && !result.error) {
      decision = result.data as JudgeDecision;
    } else if (result.rawData) {
      // Validation failed but we have raw data - extract reasoning and default winner to 0
      try {
        const raw = JSON.parse(result.rawData);
        console.warn(`Judge returned invalid winner ${raw.winner}, defaulting to candidate 0`);
        decision = { winner: 0, reasoning: raw.reasoning ?? "Judge failed to provide reasoning" };
      } catch {
        console.warn(`Judge validation failed: ${result.error}`);
      }
    }

    return {
      status: decision ? "success" : "error",
      decision,
      tag: result.tag,
      sandboxId: result.sandboxId,
      error: decision ? undefined : "Judge failed to produce valid decision",
    };
  }

  // ===========================================================================
  // PRIVATE: VERIFY
  // ===========================================================================

  private static readonly DEFAULT_VERIFY_MAX_ATTEMPTS = 3;

  private static readonly VerifyDecisionSchema = z.object({
    passed: z.boolean(),
    reasoning: z.string(),
    feedback: z.string().optional(),
  });

  /**
   * Build verify context containing worker task info and output to verify.
   */
  private buildVerifyContext(params: {
    inputFiles: FileMap;
    taskPrompt: string;
    outputFiles: FileMap;
    systemPrompt?: string;
    schema?: z.ZodType<unknown> | JsonSchema;
  }): FileMap {
    // Start with shared worker_task structure
    const context = this.buildEvaluatorContext({
      inputFiles: params.inputFiles,
      taskPrompt: params.taskPrompt,
      systemPrompt: params.systemPrompt,
      schema: params.schema,
    });

    // Add output files to verify
    Object.entries(params.outputFiles).forEach(([name, content]) => {
      context[`worker_output/${name}`] = content;
    });

    return context;
  }

  /**
   * Execute verifier to check if output meets criteria.
   */
  private async executeVerify(params: {
    inputFiles: FileMap;
    outputFiles: FileMap;
    taskPrompt: string;
    config: VerifyConfig;
    timeoutMs: number;
    systemPrompt?: string;
    schema?: z.ZodType<unknown> | JsonSchema;
    mcpServers?: Record<string, McpServerConfig>;
    skills?: SkillName[];
    composio?: ComposioSetup;
    operationId: string;
    workerTag: string;
    retryAttempt?: number;
    /** Operation type for observability */
    operation?: "map" | "filter" | "reduce";
    /** Item index for observability */
    itemIndex?: number;
    /** Verify attempt number for observability */
    attemptIndex?: number;
    /** Pipeline context for observability */
    _pipelineContext?: PipelineContext;
  }): Promise<{ status: "success" | "error"; decision: VerifyDecision | null; tag: string; sandboxId: string; error?: string }> {
    const { config, timeoutMs, operationId, workerTag, retryAttempt = 1, operation, itemIndex, attemptIndex, _pipelineContext } = params;

    // Verifier tag = workerTag-verifier, with -er{n} suffix for error retries
    const tagPrefix = retryAttempt > 1
      ? `${workerTag}-verifier-er${retryAttempt - 1}`
      : `${workerTag}-verifier`;

    // Resolve MCP servers: verifierMcpServers takes precedence
    const verifierMcpServers = config.verifierMcpServers ?? params.mcpServers;
    // Resolve skills: verifierSkills takes precedence
    const verifierSkills = config.verifierSkills ?? params.skills;
    // Resolve composio: verifierComposio takes precedence
    const verifierComposio = config.verifierComposio ?? params.composio;

    // Build verify context
    const context = this.buildVerifyContext({
      inputFiles: params.inputFiles,
      taskPrompt: params.taskPrompt,
      outputFiles: params.outputFiles,
      systemPrompt: params.systemPrompt,
      schema: params.schema,
    });

    // Build verify system prompt
    const fileTree = buildFileTree(context);
    const verifySystemPrompt = applyTemplate(VERIFY_PROMPT, {
      criteria: config.criteria,
      fileTree,
    });

    const result = await this.semaphore.use(() =>
      this.execute(context, VERIFY_USER_PROMPT, {
        systemPrompt: verifySystemPrompt,
        schema: Swarm.VerifyDecisionSchema,
        agent: config.verifierAgent,
        mcpServers: verifierMcpServers,
        skills: verifierSkills,
        composio: verifierComposio,
        tagPrefix,
        timeoutMs,
        observability: {
          swarmName: this.config.tag,
          operationId,
          operation,
          itemIndex,
          role: "verifier",
          verifyRetry: attemptIndex && attemptIndex > 1 ? attemptIndex - 1 : undefined,
          errorRetry: retryAttempt > 1 ? retryAttempt - 1 : undefined,
          ...this.pipelineContextToObservability(_pipelineContext),
        },
      })
    );

    let decision: VerifyDecision | null = null;
    if (result.data && !result.error) {
      decision = result.data as VerifyDecision;
    } else if (result.rawData) {
      try {
        const raw = JSON.parse(result.rawData);
        decision = {
          passed: !!raw.passed,
          reasoning: raw.reasoning ?? "Verification completed",
          feedback: raw.feedback,
        };
      } catch {
        console.warn(`Verify validation failed: ${result.error}`);
      }
    }

    return {
      status: decision ? "success" : "error",
      decision,
      tag: result.tag,
      sandboxId: result.sandboxId,
      error: decision ? undefined : "Verifier failed to produce valid decision",
    };
  }

  /**
   * Build a retry prompt with verifier feedback.
   */
  private static buildRetryPromptWithFeedback(originalPrompt: string, feedback: string): string {
    return applyTemplate(RETRY_FEEDBACK_PROMPT, { originalPrompt, feedback });
  }

  /**
   * Shared verification loop for map, filter, and reduce.
   * Runs worker function, verifies output, retries with feedback if needed.
   *
   * @param workerFn - Function that executes the worker with a given prompt, tag prefix, and attempt index
   * @param params - Common verification parameters
   * @returns Result with verify info attached
   */
  private async runWithVerification<TResult extends { status: "success" | "error" | "filtered"; files: FileMap }>(
    workerFn: (prompt: string, tagPrefix: string, attemptIndex?: number) => Promise<TResult>,
    params: {
      originalPrompt: string;
      inputFiles: FileMap;
      verifyConfig: VerifyConfig;
      timeoutMs: number;
      systemPrompt?: string;
      schema?: z.ZodType<unknown> | JsonSchema;
      mcpServers?: Record<string, McpServerConfig>;
      skills?: SkillName[];
      composio?: ComposioSetup;
      operationId: string;
      baseTag: string;
      retry?: { maxAttempts?: number; backoffMs?: number; backoffMultiplier?: number };
      itemIndex?: number;
      /** Operation type for observability */
      operation?: "map" | "filter" | "reduce";
      /** Pipeline context for observability */
      _pipelineContext?: PipelineContext;
    }
  ): Promise<TResult & { verify?: VerifyInfo }> {
    const { originalPrompt, inputFiles, verifyConfig, timeoutMs, operationId, baseTag, retry, itemIndex = 0, operation, _pipelineContext } = params;
    const maxAttempts = verifyConfig.maxAttempts ?? Swarm.DEFAULT_VERIFY_MAX_ATTEMPTS;

    let currentPrompt = originalPrompt;
    let lastResult: TResult | null = null;
    let verifyAttempts = 0;

    while (verifyAttempts < maxAttempts) {
      verifyAttempts++;

      // Build worker tag: baseTag, baseTag-vr1, baseTag-vr2, etc. (vr = verify retry)
      const workerTag = verifyAttempts > 1 ? `${baseTag}-vr${verifyAttempts - 1}` : baseTag;

      // Run worker (with error retry if configured)
      // Worker keeps retryOn (user-specified condition) and gets -er{n} tag suffix for error retries
      const workerResult = retry
        ? await executeWithRetry(
            (retryAttempt) => workerFn(
              currentPrompt,
              retryAttempt > 1 ? `${workerTag}-er${retryAttempt - 1}` : workerTag,
              verifyAttempts
            ),
            retry,
            itemIndex
          )
        : await workerFn(currentPrompt, workerTag, verifyAttempts);

      // Emit worker complete event
      verifyConfig.onWorkerComplete?.(
        itemIndex,
        verifyAttempts,
        workerResult.status === "error" ? "error" : "success"
      );

      // If worker failed even after retries, return immediately
      if (workerResult.status === "error") {
        return workerResult as TResult & { verify?: VerifyInfo };
      }

      lastResult = workerResult;

      // Run verification (verifier tag = workerTag-verify, with error retry like judge)
      const verification = retry
        ? await executeWithRetry(
            (retryAttempt) => this.executeVerify({
              inputFiles,
              outputFiles: workerResult.files,
              taskPrompt: currentPrompt,
              config: verifyConfig,
              timeoutMs,
              systemPrompt: params.systemPrompt,
              schema: params.schema,
              mcpServers: params.mcpServers,
              skills: params.skills,
              composio: params.composio,
              operationId,
              workerTag,
              retryAttempt,
              operation,
              itemIndex,
              attemptIndex: verifyAttempts,
              _pipelineContext,
            }),
            { ...retry, retryOn: undefined }
          )
        : await this.executeVerify({
            inputFiles,
            outputFiles: workerResult.files,
            taskPrompt: currentPrompt,
            config: verifyConfig,
            timeoutMs,
            systemPrompt: params.systemPrompt,
            schema: params.schema,
            mcpServers: params.mcpServers,
            skills: params.skills,
            composio: params.composio,
            operationId,
            workerTag,
            operation,
            itemIndex,
            attemptIndex: verifyAttempts,
            _pipelineContext,
          });

      // Build verify meta
      const verifyMeta: VerifyMeta = {
        operationId,
        operation: "verify",
        tag: verification.tag,
        sandboxId: verification.sandboxId,
        swarmName: this.config.tag,
        attempts: verifyAttempts,
        ...this.pipelineContextToMeta(_pipelineContext),
      };

      // Emit verifier complete event
      verifyConfig.onVerifierComplete?.(
        itemIndex,
        verifyAttempts,
        verification.decision?.passed ?? false,
        verification.decision?.feedback
      );

      // If verification passed, return result with verify info
      if (verification.decision?.passed) {
        return {
          ...workerResult,
          verify: {
            passed: true,
            reasoning: verification.decision.reasoning,
            verifyMeta,
            attempts: verifyAttempts,
          },
        };
      }

      // If verification failed and we have attempts left, rebuild prompt with feedback
      if (verifyAttempts < maxAttempts) {
        const feedback = verification.decision?.feedback ?? verification.decision?.reasoning ?? "Output did not meet criteria";
        currentPrompt = Swarm.buildRetryPromptWithFeedback(originalPrompt, feedback);
      }
    }

    // Max retries exceeded - return last result with error status and verify info
    // Use last worker tag for consistency
    const lastWorkerTag = verifyAttempts > 1 ? `${baseTag}-vr${verifyAttempts - 1}` : baseTag;
    return {
      ...lastResult!,
      status: "error",
      verify: {
        passed: false,
        reasoning: "Max verification retries exceeded",
        verifyMeta: {
          operationId,
          operation: "verify",
          tag: `${lastWorkerTag}-verifier`,
          sandboxId: "",
          swarmName: this.config.tag,
          attempts: verifyAttempts,
          ...this.pipelineContextToMeta(_pipelineContext),
        },
        attempts: verifyAttempts,
      },
    } as TResult & { verify?: VerifyInfo };
  }

  // ===========================================================================
  // PRIVATE: UTILITIES
  // ===========================================================================

  private generateOperationId(): string {
    return randomBytes(8).toString("hex");
  }

  /** Convert pipeline context to observability fields */
  private pipelineContextToObservability(ctx?: PipelineContext): Record<string, unknown> {
    if (!ctx) return {};
    return {
      pipelineRunId: ctx.pipelineRunId,
      pipelineStepIndex: ctx.pipelineStepIndex,
    };
  }

  /** Extract pipeline tracking fields for meta objects */
  private pipelineContextToMeta(ctx?: PipelineContext): Pick<BaseMeta, "pipelineRunId" | "pipelineStepIndex"> {
    return {
      pipelineRunId: ctx?.pipelineRunId,
      pipelineStepIndex: ctx?.pipelineStepIndex,
    };
  }

  /**
   * Safely evaluate prompt (string or function).
   * Returns evaluated string or Error if function threw.
   */
  private evaluatePrompt(prompt: Prompt, files: FileMap, index: number): string | Error {
    if (typeof prompt === "string") return prompt;
    try {
      return prompt(files, index);
    } catch (e) {
      return e as Error;
    }
  }

  /**
   * Build evaluator context (shared by judge and verify).
   * Creates worker_task/ structure with input files, prompts, schema.
   */
  private buildEvaluatorContext(params: {
    inputFiles: FileMap;
    taskPrompt: string;
    systemPrompt?: string;
    schema?: z.ZodType<unknown> | JsonSchema;
  }): FileMap {
    const context: FileMap = {};

    if (params.systemPrompt) {
      context["worker_task/system_prompt.txt"] = params.systemPrompt;
    }
    context["worker_task/user_prompt.txt"] = params.taskPrompt;
    if (params.schema) {
      context["worker_task/schema.json"] = isZodSchema(params.schema)
        ? zodSchemaToJson(params.schema)
        : jsonSchemaToString(params.schema);
    }

    Object.entries(params.inputFiles).forEach(([name, content]) => {
      context[`worker_task/input/${name}`] = content;
    });

    return context;
  }

  private isSwarmResult(input: unknown): input is SwarmResult {
    return (
      typeof input === "object" &&
      input !== null &&
      SWARM_RESULT_BRAND in input &&
      (input as Record<symbol, unknown>)[SWARM_RESULT_BRAND] === true
    );
  }

  private getFiles(input: ItemInput): FileMap {
    if (this.isSwarmResult(input)) {
      const files = { ...input.files };
      // Rename result.json → data.json for clarity when used as input to next operation
      if (files["result.json"]) {
        files["data.json"] = files["result.json"];
        delete files["result.json"];
      }
      return files;
    }
    return input as FileMap;
  }

  private getIndex(input: ItemInput, fallback: number): number {
    return this.isSwarmResult(input) ? input.meta.itemIndex : fallback;
  }

  private buildResult<T>(
    result: { files: FileMap; data: unknown; tag: string; sandboxId: string; error?: string; rawData?: string },
    meta: IndexedMeta,
    filesOverride?: FileMap
  ): SwarmResult<T> {
    const files = filesOverride ?? result.files;

    if (result.error) {
      return {
        [SWARM_RESULT_BRAND]: true,
        status: "error",
        data: null,
        files,
        meta,
        error: result.error,
        rawData: result.rawData,
      };
    }
    return {
      [SWARM_RESULT_BRAND]: true,
      status: "success",
      data: result.data as T,
      files,
      meta,
    };
  }

  private buildErrorResult<T>(error: string, meta: IndexedMeta): SwarmResult<T> {
    return {
      [SWARM_RESULT_BRAND]: true,
      status: "error",
      data: null,
      files: {},
      meta,
      error,
    };
  }
}
