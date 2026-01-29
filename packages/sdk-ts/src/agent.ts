/**
 * Unified Agent Implementation
 *
 * Single Agent class that uses registry lookup for agent-specific behavior.
 * All agent differences are data (in registry), not code.
 *
 * Evidence: sdk-rewrite-v3.md Design Decisions section
 */

import type { z } from "zod";
import Ajv, { type ValidateFunction } from "ajv";
import type {
  AgentType,
  SandboxInstance,
  FileMap,
  AgentConfig,
  ResolvedAgentConfig,
  AgentOptions,
  RunOptions,
  ExecuteCommandOptions,
  AgentResponse,
  OutputResult,
  StreamCallbacks,
  JsonSchema,
  SchemaValidationOptions,
  SkillName,
  McpServerConfig,
} from "./types";
import { VALIDATION_PRESETS } from "./types";
import { getAgentConfig, type AgentRegistryEntry } from "./registry";
import { writeMcpConfig } from "./mcp";
import { createAgentParser, type AgentParser } from "./parsers";
import { DEFAULT_TIMEOUT_MS, DEFAULT_WORKING_DIR, getGatewayUrl, getGeminiGatewayUrl } from "./constants";
import { buildWorkerSystemPrompt } from "./prompts";
import { isZodSchema } from "./utils";
import { SessionLogger } from "./observability";
import { setupComposio } from "./composio";

// Re-export types for external consumers
export type { AgentConfig, AgentOptions, RunOptions, ExecuteCommandOptions, AgentResponse, StreamCallbacks };

// =============================================================================
// PROMPT ESCAPING
// =============================================================================

/**
 * Escape prompt for bash double-quoted strings
 *
 * Only escape characters that are special inside double quotes.
 * Evidence: sdk-rewrite-v3.md Prompt Escaping section
 */
function escapePrompt(prompt: string): string {
  return prompt
    .replace(/\\/g, "\\\\") // Escape backslashes FIRST
    .replace(/"/g, '\\"') // Escape double quotes
    .replace(/\$/g, "\\$") // Escape dollar signs
    .replace(/`/g, "\\`"); // Escape backticks (command substitution)
}

// =============================================================================
// AGENT CLASS
// =============================================================================

/**
 * Unified Agent class
 *
 * Uses registry lookup for agent-specific behavior.
 * Tracks hasRun state for continue flag handling.
 */
export class Agent {
  private agentConfig: ResolvedAgentConfig;
  private options: AgentOptions;
  private sandbox?: SandboxInstance;
  private hasRun: boolean = false;
  private readonly workingDir: string;
  private lastRunTimestamp?: number;
  private readonly registry: AgentRegistryEntry;
  private sessionLogger?: SessionLogger;

  // Skills storage
  private readonly skills?: SkillName[];

  // Schema storage (mutually exclusive)
  private readonly zodSchema?: z.ZodType<unknown>;
  private readonly jsonSchema?: JsonSchema;
  private readonly schemaOptions?: SchemaValidationOptions;
  private readonly compiledValidator?: ValidateFunction;

  constructor(agentConfig: ResolvedAgentConfig, options: AgentOptions = {}) {
    this.agentConfig = agentConfig;
    this.options = options;
    this.workingDir = options.workingDirectory || DEFAULT_WORKING_DIR;

    // Store skills
    this.skills = options.skills;

    // Auto-detect and store schema type
    if (options.schema) {
      if (isZodSchema(options.schema)) {
        this.zodSchema = options.schema;
        if (options.schemaOptions) {
          console.warn("[Evolve] schemaOptions ignored for Zod schemas - use .passthrough(), .strip(), z.coerce instead");
        }
      } else {
        // JSON Schema - validate at config time (fail fast)
        this.jsonSchema = options.schema as JsonSchema;
        this.schemaOptions = options.schemaOptions;

        // Compile schema (validates it's valid JSON Schema + creates reusable validator)
        try {
          const ajv = this.createAjvValidator();
          this.compiledValidator = ajv.compile(this.jsonSchema);
        } catch (e) {
          throw new Error(`Invalid JSON Schema: ${(e as Error).message}`);
        }
      }
    }

    // Cache registry lookup once in constructor
    this.registry = getAgentConfig(agentConfig.type);
  }

  /**
   * Create Ajv validator instance with configured options
   */
  private createAjvValidator(): Ajv {
    // Start with loose preset (default), then apply mode, then individual options
    const preset = VALIDATION_PRESETS[this.schemaOptions?.mode || "loose"];
    const opts = {
      ...preset,
      // Individual options override preset
      ...(this.schemaOptions?.coerceTypes !== undefined && { coerceTypes: this.schemaOptions.coerceTypes }),
      ...(this.schemaOptions?.removeAdditional !== undefined && { removeAdditional: this.schemaOptions.removeAdditional }),
      ...(this.schemaOptions?.useDefaults !== undefined && { useDefaults: this.schemaOptions.useDefaults }),
      ...(this.schemaOptions?.allErrors !== undefined && { allErrors: this.schemaOptions.allErrors }),
    };
    // Disable strict mode - allows unknown formats (e.g., date-time from Pydantic schemas)
    // Ajv validates structure, Pydantic handles format validation for rich types
    return new Ajv({ ...opts, strict: false });
  }

  // ===========================================================================
  // SANDBOX MANAGEMENT
  // ===========================================================================

  /**
   * Get or create sandbox instance
   */
  async getSandbox(): Promise<SandboxInstance> {
    if (this.sandbox) return this.sandbox;

    if (!this.options.sandboxProvider) {
      throw new Error("No sandbox provider configured");
    }

    const provider = this.options.sandboxProvider;

    if (this.options.sandboxId) {
      // Connect to existing sandbox - skip setup
      if (
        this.options.mcpServers ||
        this.options.context ||
        this.options.files ||
        this.options.systemPrompt
      ) {
        console.warn(
          "[Evolve] Connecting to existing sandbox - ignoring mcpServers, context, files, and systemPrompt"
        );
      }
      this.sandbox = await provider.connect(this.options.sandboxId);
      // Existing sandbox may have prior runs - use resume/continue command
      this.hasRun = true;
    } else {
      // Create new sandbox with full initialization
      const envVars = this.buildEnvironmentVariables();

      this.sandbox = await provider.create({
        envs: envVars,
        workingDirectory: this.workingDir,
      });

      // Agent-specific setup (e.g., codex login)
      await this.setupAgentAuth(this.sandbox);

      // Workspace setup
      await this.setupWorkspace(this.sandbox);
    }

    return this.sandbox;
  }

  /**
   * Build environment variables for sandbox
   */
  private buildEnvironmentVariables(): Record<string, string> {
    const envVars: Record<string, string> = {};

    // File-based OAuth (Codex, Gemini): auth file handles auth, no API key env var needed
    if (this.agentConfig.oauthFileContent) {
      // Some agents need an activation env var (e.g., Gemini needs GOOGLE_GENAI_USE_GCA=true)
      if (this.registry.oauthActivationEnv) {
        envVars[this.registry.oauthActivationEnv.key] = this.registry.oauthActivationEnv.value;
      }
    } else {
      // OAuth mode uses oauthEnv (e.g., CLAUDE_CODE_OAUTH_TOKEN), else apiKeyEnv
      const keyEnv = this.agentConfig.isOAuth && this.registry.oauthEnv
        ? this.registry.oauthEnv
        : this.registry.apiKeyEnv;
      envVars[keyEnv] = this.agentConfig.apiKey;
    }

    if (this.agentConfig.isDirectMode && !this.agentConfig.isOAuth) {
      // Direct mode (non-OAuth): use resolved baseUrl if set (e.g., Qwen needs Dashscope endpoint)
      if (this.agentConfig.baseUrl) {
        envVars[this.registry.baseUrlEnv] = this.agentConfig.baseUrl;
      }
    } else if (!this.agentConfig.isDirectMode) {
      // Gateway mode: route through Evolve gateway
      envVars[this.registry.baseUrlEnv] = this.registry.usePassthroughGateway
        ? getGeminiGatewayUrl()
        : getGatewayUrl();
      // Expose EVOLVE_API_KEY in sandbox for gateway services (e.g., browser-use)
      envVars['EVOLVE_API_KEY'] = this.agentConfig.apiKey;
    }
    // OAuth direct mode: no baseUrl needed (Claude Code CLI handles it)

    if (this.options.secrets) {
      Object.assign(envVars, this.options.secrets);
    }
    return envVars;
  }

  /**
   * Agent-specific authentication setup
   */
  private async setupAgentAuth(sandbox: SandboxInstance): Promise<void> {
    // File-based OAuth: write auth file directly
    if (this.agentConfig.oauthFileContent && this.registry.oauthFileName) {
      const settingsDir = this.registry.mcpConfig.settingsDir.replace(/^~/, "/home/user");
      await sandbox.files.makeDir(settingsDir);
      await sandbox.files.write(`${settingsDir}/${this.registry.oauthFileName}`, this.agentConfig.oauthFileContent);
      return;
    }
    // Default: run setup command (e.g., "codex login --with-api-key")
    if (this.registry.setupCommand) {
      await sandbox.commands.run(this.registry.setupCommand, { timeoutMs: 30000 });
    }
  }

  /**
   * Setup workspace structure and files
   */
  private async setupWorkspace(sandbox: SandboxInstance): Promise<void> {
    const workspaceMode = this.options.workspaceMode || "knowledge";

    // Create workspace folders (swe mode includes repo/)
    const folders = workspaceMode === "swe"
      ? `${this.workingDir}/repo ${this.workingDir}/context ${this.workingDir}/scripts ${this.workingDir}/temp ${this.workingDir}/output`
      : `${this.workingDir}/context ${this.workingDir}/scripts ${this.workingDir}/temp ${this.workingDir}/output`;

    await sandbox.commands.run(`mkdir -p ${folders}`, { timeoutMs: 30000 });

    // Generate system prompt using shared utility
    // Pass whichever schema type is configured (buildWorkerSystemPrompt auto-detects)
    const fullPrompt = buildWorkerSystemPrompt({
      workingDir: this.workingDir,
      systemPrompt: this.options.systemPrompt,
      schema: this.zodSchema || this.jsonSchema,
      mode: workspaceMode,
    });

    // Write system prompt file
    const filePath = `${this.workingDir}/${this.registry.systemPromptFile}`;
    await sandbox.files.write(filePath, fullPrompt);

    // Upload context files
    if (this.options.context) {
      await this.uploadContextFiles(sandbox, this.options.context);
    }

    // Upload workspace files
    if (this.options.files) {
      await this.uploadWorkspaceFiles(sandbox, this.options.files);
    }

    // Setup Composio and MCP servers
    let mcpServers: Record<string, McpServerConfig> = { ...this.options.mcpServers };

    if (this.options.composio) {
      const composioMcp = await setupComposio(
        this.options.composio.userId,
        this.options.composio.config
      );
      mcpServers = {
        ...mcpServers,
        composio: {
          type: "http",
          url: composioMcp.url,
          headers: composioMcp.headers,
        },
      };
    }

    // Write MCP config if any servers configured
    if (Object.keys(mcpServers).length > 0) {
      await writeMcpConfig(
        this.agentConfig.type,
        sandbox,
        this.workingDir,
        mcpServers
      );
    }

    // Setup skills
    if (this.skills?.length) {
      await this.setupSkills(sandbox);
    }
  }

  /**
   * Setup skills for the agent
   *
   * Copies selected skills from source (~/.evolve/skills/) to CLI-specific directory.
   * All CLIs use the same pattern: skills are auto-discovered from their target directory.
   */
  private async setupSkills(sandbox: SandboxInstance): Promise<void> {
    if (!this.skills?.length) return;

    const { skillsConfig } = this.registry;
    const { sourceDir, targetDir } = skillsConfig;

    await sandbox.files.makeDir(targetDir);

    // Copy selected skills from source to target directory
    for (const skill of this.skills) {
      const copyCmd = `cp -r ${sourceDir}/${skill} ${targetDir}/ 2>/dev/null || true`;
      await sandbox.commands.run(copyCmd, { timeoutMs: 30000 });
    }
  }

  /**
   * Upload context files to context/ folder
   */
  private async uploadContextFiles(
    sandbox: SandboxInstance,
    files: FileMap
  ): Promise<void> {
    const entries = Object.entries(files).map(([name, content]) => ({
      path: `${this.workingDir}/context/${name}`,
      data: content,
    }));

    if (entries.length === 0) return;

    // Create parent directories
    const dirs = new Set(
      entries.map((e) => e.path.substring(0, e.path.lastIndexOf("/"))).filter(Boolean)
    );
    if (dirs.size > 0) {
      await sandbox.commands.run(`mkdir -p ${Array.from(dirs).join(" ")}`, {
        timeoutMs: 30000,
      });
    }

    await sandbox.files.writeBatch(entries);
  }

  /**
   * Upload workspace files to working directory
   */
  private async uploadWorkspaceFiles(
    sandbox: SandboxInstance,
    files: FileMap
  ): Promise<void> {
    const entries = Object.entries(files).map(([path, content]) => ({
      // Support absolute paths (use as-is) and relative paths (prefix with workingDir)
      path: path.startsWith("/") ? path : `${this.workingDir}/${path}`,
      data: content,
    }));

    if (entries.length === 0) return;

    // Create parent directories
    const dirs = new Set(
      entries.map((e) => e.path.substring(0, e.path.lastIndexOf("/"))).filter(Boolean)
    );
    if (dirs.size > 0) {
      await sandbox.commands.run(`mkdir -p ${Array.from(dirs).join(" ")}`, {
        timeoutMs: 30000,
      });
    }

    await sandbox.files.writeBatch(entries);
  }

  // ===========================================================================
  // COMMAND BUILDING
  // ===========================================================================

  /**
   * Build the CLI command for running the agent
   */
  private buildCommand(prompt: string): string {
    return this.registry.buildCommand({
      prompt: escapePrompt(prompt),
      model: this.agentConfig.model || this.registry.defaultModel,
      isResume: this.hasRun,
      reasoningEffort: this.agentConfig.reasoningEffort,
      betas: this.agentConfig.betas,
      isDirectMode: this.agentConfig.isDirectMode,
      skills: this.skills,
    });
  }

  // ===========================================================================
  // RUN METHOD
  // ===========================================================================

  /**
   * Run agent with prompt
   *
   * Streams output via callbacks, returns final response.
   */
  async run(
    options: RunOptions,
    callbacks?: StreamCallbacks
  ): Promise<AgentResponse> {
    const { prompt, timeoutMs = DEFAULT_TIMEOUT_MS, background = false } = options;
    const sandbox = await this.getSandbox();

    // Track turn start time BEFORE process starts (for output file filtering)
    // Files modified AFTER this time will be returned by getOutputFiles()
    this.lastRunTimestamp = Date.now();

    // Initialize session logger on first run (local logging always, dashboard sync only in gateway mode)
    if (!this.sessionLogger) {
      const provider = this.options.sandboxProvider;
      this.sessionLogger = new SessionLogger({
        provider: provider?.name || provider?.providerType || "unknown",
        agent: this.agentConfig.type,
        model: this.agentConfig.model || this.registry.defaultModel,
        sandboxId: sandbox.sandboxId,
        tagPrefix: this.options.sessionTagPrefix,
        apiKey: this.agentConfig.isDirectMode ? undefined : this.agentConfig.apiKey,
        observability: this.options.observability,
      });
    }

    // Log the prompt (non-blocking)
    this.sessionLogger.writePrompt(prompt);

    // Build command
    const command = this.buildCommand(prompt);

    // Line buffer for NDJSON parsing (shared by both modes)
    let lineBuffer = "";

    // Create parser once (shared by onContent callback and session logger)
    const parser = createAgentParser(this.agentConfig.type);

    // Streaming callback for stdout (shared by both modes)
    const onStdout = (chunk: string) => {
      // Line-based NDJSON parsing
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? ""; // Keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;

        // Parse once, use for both session logger and onContent
        const events = parser(line);

        // Log to session logger with pre-parsed events (non-blocking)
        this.sessionLogger?.writeEventParsed(line, events);

        // Emit raw stdout with newline (matches raw output)
        callbacks?.onStdout?.(line + "\n");

        // Emit content events to callback
        if (events && callbacks?.onContent) {
          for (const event of events) {
            callbacks.onContent(event);
          }
        }
      }
    };

    // Streaming callback for stderr (shared by both modes)
    const onStderr = (chunk: string) => {
      callbacks?.onStderr?.(chunk);
    };

    // Background execution - spawn and don't wait
    if (background) {
      const handle = await sandbox.commands.spawn(command, {
        cwd: this.workingDir,
        timeoutMs,
        onStdout,
        onStderr,
      });
      this.hasRun = true;

      return {
        sandboxId: sandbox.sandboxId,
        exitCode: 0, // Process started but not completed
        stdout: `Background process started with ID ${handle.processId}`,
        stderr: "",
      };
    }

    // Run command with streaming (blocks until completion)
    const result = await sandbox.commands.run(command, {
      cwd: this.workingDir,
      timeoutMs,
      onStdout,
      onStderr,
    });

    // Process any remaining buffered content
    if (lineBuffer.trim()) {
      // Parse once, use for both session logger and onContent
      const events = parser(lineBuffer);

      // Log to session logger with pre-parsed events (non-blocking)
      this.sessionLogger?.writeEventParsed(lineBuffer, events);

      // Emit raw stdout
      callbacks?.onStdout?.(lineBuffer + "\n");

      // Emit content events to callback
      if (events && callbacks?.onContent) {
        for (const event of events) {
          callbacks.onContent(event);
        }
      }
    }

    // Mark that we've run (for continue flag on next run)
    this.hasRun = true;

    return {
      sandboxId: sandbox.sandboxId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  // ===========================================================================
  // EXECUTE COMMAND
  // ===========================================================================

  /**
   * Execute arbitrary command in sandbox
   */
  async executeCommand(
    command: string,
    options: ExecuteCommandOptions = {},
    callbacks?: StreamCallbacks
  ): Promise<AgentResponse> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, background = false } = options;
    const sandbox = await this.getSandbox();

    // Track turn start time BEFORE process starts (for output file filtering)
    // Files modified AFTER this time will be returned by getOutputFiles()
    this.lastRunTimestamp = Date.now();

    let stdout = "";
    let stderr = "";

    // Streaming callbacks (shared by both modes)
    const onStdout = (chunk: string) => {
      stdout += chunk;
      callbacks?.onStdout?.(chunk);
    };
    const onStderr = (chunk: string) => {
      stderr += chunk;
      callbacks?.onStderr?.(chunk);
    };

    if (background) {
      // Background execution - spawn and don't wait
      // Returns immediately with pid, caller can track via sandbox.commands.list()
      const handle = await sandbox.commands.spawn(command, {
        cwd: this.workingDir,
        timeoutMs,
        onStdout,
        onStderr,
      });

      return {
        sandboxId: sandbox.sandboxId,
        exitCode: 0, // Process started but not completed
        stdout: `Background process started with ID ${handle.processId}`,
        stderr: "",
      };
    }

    // Foreground execution with streaming (blocks until completion)
    const result = await sandbox.commands.run(command, {
      cwd: this.workingDir,
      timeoutMs,
      onStdout,
      onStderr,
    });

    return {
      sandboxId: sandbox.sandboxId,
      exitCode: result.exitCode,
      stdout,
      stderr,
    };
  }

  // ===========================================================================
  // FILE OPERATIONS
  // ===========================================================================

  /**
   * Upload context files (to context/ folder)
   */
  async uploadContext(files: FileMap): Promise<void> {
    const sandbox = await this.getSandbox();
    await this.uploadContextFiles(sandbox, files);
  }

  /**
   * Upload files to working directory
   */
  async uploadFiles(files: FileMap): Promise<void> {
    const sandbox = await this.getSandbox();
    await this.uploadWorkspaceFiles(sandbox, files);
  }

  /**
   * Get output files from output/ folder with optional schema validation
   *
   * Returns files modified after the last run() call.
   * If schema was provided, validates result.json and returns typed data.
   *
   * @param recursive - Include files in subdirectories (default: false)
   */
  async getOutputFiles<T = unknown>(recursive = false): Promise<OutputResult<T>> {
    const sandbox = await this.getSandbox();
    const outputDir = `${this.workingDir}/output`;

    // Get file list with ctime (inode change time)
    // ctime reflects when the file was actually written to disk, even if mtime is overwritten
    // (e.g., wget sets mtime to server's Last-Modified, but ctime is the local write time)
    const depthArg = recursive ? "" : "-maxdepth 1";
    const result = await sandbox.commands.run(
      `find ${outputDir} ${depthArg} -type f -exec stat -c '%n|%Z' {} \\; 2>/dev/null || true`,
      { timeoutMs: 30000 }
    );

    const lines = result.stdout.split("\n").filter(Boolean);

    // Convert turn start time to seconds for comparison with stat's ctime
    // Subtract 2 seconds to account for potential clock skew between host and sandbox
    const turnStartTimeSec = this.lastRunTimestamp
      ? Math.floor(this.lastRunTimestamp / 1000) - 2
      : 0;

    // Parse and filter files
    const filesToRead: string[] = [];
    const outputDirPrefix = `${outputDir}/`;

    for (const line of lines) {
      const [fullPath, ctimeStr] = line.split("|");
      if (!fullPath || !ctimeStr) continue;

      const ctimeSec = parseInt(ctimeStr, 10);

      // Only include files created/written after the current turn started
      if (turnStartTimeSec > 0 && ctimeSec < turnStartTimeSec) {
        continue;
      }

      filesToRead.push(fullPath);
    }

    // Read all files in parallel
    const files: FileMap = {};
    const results = await Promise.all(
      filesToRead.map(async (fullPath) => {
        try {
          const content = await sandbox.files.read(fullPath);
          // Get relative path from output/ directory
          const relativePath = fullPath.startsWith(outputDirPrefix)
            ? fullPath.slice(outputDirPrefix.length)
            : fullPath.split("/").pop() || fullPath;
          return { relativePath, content };
        } catch {
          return null;
        }
      })
    );

    for (const r of results) {
      if (r) files[r.relativePath] = r.content;
    }

    // No schema - return files only
    if (!this.zodSchema && !this.jsonSchema) return { files, data: null };

    // Validate result.json against schema
    const json = files["result.json"];
    if (!json) {
      return { files, data: null, error: "Schema provided but agent did not create output/result.json" };
    }

    // Convert to string once (for parsing and rawData)
    const rawData = typeof json === "string" ? json : new TextDecoder().decode(json as Uint8Array);

    try {
      const parsed = JSON.parse(rawData);

      // Validate with Zod if provided
      if (this.zodSchema) {
        const validated = this.zodSchema.safeParse(parsed);
        return validated.success
          ? { files, data: validated.data as T }
          : { files, data: null, error: `Schema validation failed: ${validated.error.message}`, rawData };
      }

      // Validate with Ajv (JSON Schema)
      if (this.compiledValidator) {
        const valid = this.compiledValidator(parsed);
        if (valid) {
          return { files, data: parsed as T };
        } else {
          const errors = this.compiledValidator.errors
            ?.map((e) => `${e.instancePath} ${e.message}`)
            .join(", ") || "Unknown validation error";
          return { files, data: null, error: `Schema validation failed: ${errors}`, rawData };
        }
      }

      return { files, data: null };
    } catch (e) {
      return { files, data: null, error: `Failed to parse result.json: ${(e as Error).message}`, rawData };
    }
  }

  // ===========================================================================
  // SANDBOX CONTROL
  // ===========================================================================

  /**
   * Get current session (sandbox ID)
   */
  getSession(): string | null {
    return this.sandbox?.sandboxId || this.options.sandboxId || null;
  }

  /**
   * Set session (sandbox ID) to connect to
   *
   * When reconnecting to an existing sandbox, we assume the agent
   * may have already run commands, so we set hasRun=true to use
   * the continue/resume command template instead of first-run.
   */
  async setSession(sandboxId: string): Promise<void> {
    // Close existing session logger (flush pending events)
    if (this.sessionLogger) {
      await this.sessionLogger.close();
      this.sessionLogger = undefined;
    }

    this.options.sandboxId = sandboxId;
    this.sandbox = undefined;
    // Assume existing sandbox may have prior runs - use continue command
    this.hasRun = true;
  }

  /**
   * Pause sandbox
   */
  async pause(): Promise<void> {
    if (this.sandbox) {
      await this.sandbox.pause();
    }
  }

  /**
   * Resume sandbox
   */
  async resume(): Promise<void> {
    if (this.sandbox && this.options.sandboxProvider) {
      this.sandbox = await this.options.sandboxProvider.connect(
        this.sandbox.sandboxId
      );
    }
  }

  /**
   * Kill sandbox (terminates all processes)
   */
  async kill(): Promise<void> {
    // Close session logger (flush pending events)
    if (this.sessionLogger) {
      await this.sessionLogger.close();
      this.sessionLogger = undefined;
    }

    // Kill sandbox (terminates all processes inside)
    if (this.sandbox) {
      await this.sandbox.kill();
      this.sandbox = undefined;
      this.hasRun = false;
    }
  }

  /**
   * Get host URL for a port
   */
  async getHost(port: number): Promise<string> {
    const sandbox = await this.getSandbox();
    return sandbox.getHost(port);
  }

  /**
   * Get agent type
   */
  getAgentType(): AgentType {
    return this.agentConfig.type;
  }

  // ===========================================================================
  // OBSERVABILITY
  // ===========================================================================

  /**
   * Get current session tag
   *
   * Returns null if no session has started (run() not called yet).
   */
  getSessionTag(): string | null {
    return this.sessionLogger?.getTag() || null;
  }

  /**
   * Get current session timestamp
   *
   * Returns null if no session has started (run() not called yet).
   */
  getSessionTimestamp(): string | null {
    return this.sessionLogger?.getTimestamp() || null;
  }
}
