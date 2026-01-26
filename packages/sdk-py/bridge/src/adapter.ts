/**
 * Evolve SDK Adapter
 *
 * Maps JSON-RPC methods to Evolve TypeScript SDK calls.
 * This layer changes when the SDK changes - transport layer stays stable.
 *
 * All SDK integration is isolated here for easy maintenance.
 */

import { Evolve, type AgentConfig, type AgentType, type ReasoningEffort } from '@evolvingmachines/sdk';
import { createE2BProvider } from '@evolvingmachines/e2b';
import { createModalProvider } from '@evolvingmachines/modal';
import type {
  InitializeParams,
  RunParams,
  ExecuteCommandParams,
  UploadFilesParams,
  SetSessionParams,
  GetHostParams,
  StatusResponse,
  RunResponse,
  OutputResultResponse,
  GetHostResponse,
  EventCallbacks,
  EncodedFileMap,
  CreateInstanceParams,
  InstanceRunParams,
  InstanceGetOutputParams,
  InstanceIdParams,
  ComposioAuthParams,
  ComposioStatusParams,
  ComposioConnectionsParams,
  ComposioAuthResponse,
  ComposioStatusResponse,
  ComposioConnectionsResponse,
  ComposioConfig,
} from './types';

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Decode base64/text encoded files for SDK consumption
 */
function decodeFiles(encoded: EncodedFileMap): Record<string, string | Buffer> {
  const decoded: Record<string, string | Buffer> = {};
  for (const [name, file] of Object.entries(encoded)) {
    decoded[name] = file.encoding === 'base64'
      ? Buffer.from(file.content, 'base64')
      : file.content;
  }
  return decoded;
}

/**
 * Encode files for JSON transport (text stays text, binary becomes base64)
 *
 * Handles all FileMap value types: string, Buffer, Uint8Array, ArrayBuffer
 */
function encodeFiles(files: Record<string, string | Buffer | Uint8Array | ArrayBuffer>): EncodedFileMap {
  const result: EncodedFileMap = {};

  for (const [name, rawContent] of Object.entries(files)) {
    if (typeof rawContent === 'string') {
      result[name] = { content: rawContent, encoding: 'text' };
    } else {
      // Buffer.from handles Buffer, Uint8Array, and ArrayBuffer uniformly
      const buffer = Buffer.from(rawContent as ArrayBuffer);
      result[name] = { content: buffer.toString('base64'), encoding: 'base64' };
    }
  }

  return result;
}

// =============================================================================
// ADAPTER CLASS
// =============================================================================

/**
 * Evolve SDK Adapter
 *
 * Handles all Evolve SDK interactions. The Bridge class delegates
 * RPC method calls here, keeping transport and SDK concerns separate.
 */
export class EvolveAdapter {
  private evolve: Evolve | null = null;

  // Multi-instance support for Swarm operations
  private instances: Map<string, Evolve> = new Map();

  // ===========================================================================
  // PRIVATE: EVOLVE BUILDER (shared by initialize and createInstance)
  // ===========================================================================

  private createSandboxProvider(config: { type: string; config: Record<string, any> }) {
    switch (config.type) {
      case 'e2b':
        return createE2BProvider(config.config as any);
      case 'modal':
        return createModalProvider(config.config as any);
      default:
        throw new Error(`Unsupported sandbox provider: ${config.type}`);
    }
  }

  private buildAgentConfig(params: InitializeParams): AgentConfig | undefined {
    // Only build config if any agent params provided (TS SDK resolves defaults from env)
    if (!params.agent_type && !params.api_key && !params.provider_api_key && !params.oauth_token && !params.model && !params.reasoning_effort && !params.betas) {
      return undefined;
    }
    return {
      ...(params.agent_type && { type: params.agent_type as AgentType }),
      ...(params.api_key && { apiKey: params.api_key }),
      ...(params.provider_api_key && { providerApiKey: params.provider_api_key }),
      ...(params.oauth_token && { oauthToken: params.oauth_token }),
      ...(params.provider_base_url && { providerBaseUrl: params.provider_base_url }),
      ...(params.model && { model: params.model }),
      ...(params.reasoning_effort && { reasoningEffort: params.reasoning_effort as ReasoningEffort }),
      ...(params.betas && { betas: params.betas }),
    } as AgentConfig;
  }

  private buildEvolve(params: InitializeParams): Evolve {
    const kit = new Evolve()
      .withWorkspaceMode(params.workspace_mode ?? 'knowledge');

    // Only call .withAgent() if config provided (TS SDK resolves from EVOLVE_API_KEY)
    const agentConfig = this.buildAgentConfig(params);
    if (agentConfig) {
      kit.withAgent(agentConfig);
    }

    // Only call .withSandbox() if provider provided (TS SDK resolves from EVOLVE_API_KEY)
    if (params.sandbox_provider) {
      kit.withSandbox(this.createSandboxProvider(params.sandbox_provider));
    }

    if (params.working_directory) kit.withWorkingDirectory(params.working_directory);
    if (params.system_prompt) kit.withSystemPrompt(params.system_prompt);
    if (params.session_tag_prefix) kit.withSessionTagPrefix(params.session_tag_prefix);
    if (params.schema) kit.withSchema(params.schema, params.schema_options);
    if (params.context && Object.keys(params.context).length > 0) {
      kit.withContext(decodeFiles(params.context));
    }
    if (params.mcp_servers) {
      kit.withMcpServers(params.mcp_servers);
    }
    if (params.skills?.length) {
      kit.withSkills(params.skills);
    }
    if (params.observability) {
      kit.withObservability(params.observability);
    }
    if (params.composio) {
      kit.withComposio(params.composio.user_id, params.composio.config ? {
        toolkits: params.composio.config.toolkits,
        tools: params.composio.config.tools,
        keys: params.composio.config.keys,
        authConfigs: params.composio.config.auth_configs,
      } : undefined);
    }

    return kit;
  }

  // ===========================================================================
  // RPC DISPATCH
  // ===========================================================================

  /**
   * Dispatch RPC method to appropriate handler
   *
   * Note: 'initialize' is handled specially by Bridge (needs event callbacks),
   * so it's not included here. Call adapter.initialize() directly.
   */
  async handle(method: string, params: any): Promise<any> {
    switch (method) {
      case 'run':
        return this.run(params);
      case 'execute_command':
        return this.executeCommand(params);
      case 'upload_context':
        return this.uploadContext(params);
      case 'upload_files':
        return this.uploadFiles(params);
      case 'get_output_files':
        return this.getOutputFiles(params?.recursive ?? false);
      case 'get_session':
        return this.getSession();
      case 'set_session':
        return this.setSession(params);
      case 'pause':
        return this.pause();
      case 'resume':
        return this.resume();
      case 'kill':
        return this.kill();
      case 'get_host':
        return this.getHost(params);
      case 'get_session_tag':
        return this.getSessionTag();
      case 'get_session_timestamp':
        return this.getSessionTimestamp();
      // Multi-instance methods (for Swarm)
      case 'create_instance':
        return this.createInstance(params);
      case 'run_on_instance':
        return this.runOnInstance(params);
      case 'get_output_on_instance':
        return this.getOutputOnInstance(params);
      case 'kill_instance':
        return this.killInstance(params);
      // Composio static methods (no instance required)
      case 'composio_auth':
        return this.composioAuth(params);
      case 'composio_status':
        return this.composioStatus(params);
      case 'composio_connections':
        return this.composioConnections(params);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /**
   * Get the Evolve instance (for shutdown handling)
   */
  getEvolve(): Evolve | null {
    return this.evolve;
  }

  /**
   * Get all Evolve instances (for shutdown handling)
   */
  getAllInstances(): Map<string, Evolve> {
    return this.instances;
  }

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  async initialize(params: InitializeParams, callbacks?: EventCallbacks): Promise<StatusResponse> {
    this.evolve = this.buildEvolve(params);

    // Initialize-only configurations (not used by Swarm workers)
    if (params.files && Object.keys(params.files).length > 0) {
      this.evolve.withFiles(decodeFiles(params.files));
    }
    if (params.secrets) {
      this.evolve.withSecrets(params.secrets);
    }
    if (params.sandbox_id) {
      this.evolve.withSession(params.sandbox_id);
    }

    // Setup event forwarding (callbacks provided by Bridge)
    if (params.forward_stdout === true && callbacks?.onStdout) {
      this.evolve.on('stdout', callbacks.onStdout);
    }
    if (params.forward_stderr === true && callbacks?.onStderr) {
      this.evolve.on('stderr', callbacks.onStderr);
    }
    if (params.forward_content === true && callbacks?.onContent) {
      this.evolve.on('content', callbacks.onContent);
    }

    return { status: 'ok' };
  }

  // ===========================================================================
  // RUNTIME METHODS
  // ===========================================================================

  async run(params: RunParams): Promise<RunResponse> {
    this.ensureInitialized();

    const result = await this.evolve!.run({
      prompt: params.prompt,
      timeoutMs: params.timeout_ms,
      background: params.background,
    });

    return {
      sandbox_id: result.sandboxId,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async executeCommand(params: ExecuteCommandParams): Promise<RunResponse> {
    this.ensureInitialized();

    const result = await this.evolve!.executeCommand(params.command, {
      timeoutMs: params.timeout_ms,
      background: params.background,
    });

    return {
      sandbox_id: result.sandboxId,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  // ===========================================================================
  // FILE OPERATIONS
  // ===========================================================================

  async uploadContext(params: UploadFilesParams): Promise<StatusResponse> {
    this.ensureInitialized();
    await this.evolve!.uploadContext(decodeFiles(params.files));
    return { status: 'ok' };
  }

  async uploadFiles(params: UploadFilesParams): Promise<StatusResponse> {
    this.ensureInitialized();
    await this.evolve!.uploadFiles(decodeFiles(params.files));
    return { status: 'ok' };
  }

  /**
   * Get output files with full OutputResult (matches TS SDK)
   *
   * Returns files, data, error, and rawData for exact parity with TypeScript SDK.
   * Evidence: sdk-ts/src/types.ts OutputResult<T> interface
   */
  async getOutputFiles(recursive: boolean): Promise<OutputResultResponse> {
    this.ensureInitialized();
    const output = await this.evolve!.getOutputFiles(recursive);
    return {
      files: encodeFiles(output.files),
      data: output.data,
      error: output.error,
      raw_data: output.rawData,  // camelCase → snake_case for JSON-RPC protocol
    };
  }

  // ===========================================================================
  // SESSION MANAGEMENT
  // ===========================================================================

  async getSession(): Promise<string | null> {
    this.ensureInitialized();
    return this.evolve!.getSession();
  }

  async setSession(params: SetSessionParams): Promise<StatusResponse> {
    this.ensureInitialized();
    await this.evolve!.setSession(params.session_id);
    return { status: 'ok' };
  }

  async pause(): Promise<StatusResponse> {
    this.ensureInitialized();
    await this.evolve!.pause();
    return { status: 'ok' };
  }

  async resume(): Promise<StatusResponse> {
    this.ensureInitialized();
    await this.evolve!.resume();
    return { status: 'ok' };
  }

  async kill(): Promise<StatusResponse> {
    this.ensureInitialized();
    await this.evolve!.kill();
    return { status: 'ok' };
  }

  async getHost(params: GetHostParams): Promise<GetHostResponse> {
    this.ensureInitialized();
    const url = await this.evolve!.getHost(params.port);
    return { url };
  }

  // ===========================================================================
  // OBSERVABILITY
  // ===========================================================================

  async getSessionTag(): Promise<string | null> {
    this.ensureInitialized();
    return this.evolve!.getSessionTag();
  }

  async getSessionTimestamp(): Promise<string | null> {
    this.ensureInitialized();
    return this.evolve!.getSessionTimestamp();
  }

  // ===========================================================================
  // MULTI-INSTANCE METHODS (for Swarm)
  // ===========================================================================

  /**
   * Create a new Evolve instance with the given ID
   */
  async createInstance(params: CreateInstanceParams): Promise<StatusResponse> {
    const { instance_id, ...initParams } = params;

    if (this.instances.has(instance_id)) {
      throw new Error(`Instance ${instance_id} already exists`);
    }

    const kit = this.buildEvolve(initParams);
    this.instances.set(instance_id, kit);
    return { status: 'ok' };
  }

  /**
   * Run prompt on a specific instance
   */
  async runOnInstance(params: InstanceRunParams): Promise<RunResponse> {
    const { instance_id, ...runParams } = params;
    const kit = this.instances.get(instance_id);
    if (!kit) {
      throw new Error(`Instance ${instance_id} not found`);
    }

    const result = await kit.run({
      prompt: runParams.prompt,
      timeoutMs: runParams.timeout_ms,
      background: runParams.background,
    });

    return {
      sandbox_id: result.sandboxId,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Get output files from a specific instance
   */
  async getOutputOnInstance(params: InstanceGetOutputParams): Promise<OutputResultResponse> {
    const kit = this.instances.get(params.instance_id);
    if (!kit) {
      throw new Error(`Instance ${params.instance_id} not found`);
    }

    const output = await kit.getOutputFiles(params.recursive ?? false);
    return {
      files: encodeFiles(output.files),
      data: output.data,
      error: output.error,
      raw_data: output.rawData,
    };
  }

  /**
   * Kill and remove a specific instance
   */
  async killInstance(params: InstanceIdParams): Promise<StatusResponse> {
    const kit = this.instances.get(params.instance_id);
    if (kit) {
      await kit.kill().catch(() => {});
      this.instances.delete(params.instance_id);
    }
    return { status: 'ok' };
  }

  /**
   * Kill all instances (called during shutdown)
   */
  async killAllInstances(): Promise<void> {
    const kills = Array.from(this.instances.values()).map(kit =>
      kit.kill().catch(() => {})
    );
    await Promise.all(kills);
    this.instances.clear();
  }

  // ===========================================================================
  // COMPOSIO STATIC METHODS (no instance required)
  // ===========================================================================

  /**
   * Get OAuth URL for authenticating a toolkit
   */
  async composioAuth(params: ComposioAuthParams): Promise<ComposioAuthResponse> {
    const result = await Evolve.composio.auth(params.user_id, params.toolkit);
    return {
      url: result.url,
      connection_id: result.connectionId,
    };
  }

  /**
   * Check connection status for a user
   */
  async composioStatus(params: ComposioStatusParams): Promise<ComposioStatusResponse> {
    const result = await Evolve.composio.status(params.user_id, params.toolkit);
    // TS SDK returns boolean if toolkit specified, Record<string,boolean> if not
    if (typeof result === 'boolean') {
      return { connected: result };
    }
    return { status_map: result };
  }

  /**
   * List all connections for a user
   */
  async composioConnections(params: ComposioConnectionsParams): Promise<ComposioConnectionsResponse> {
    const result = await Evolve.composio.connections(params.user_id);
    return {
      connections: result.map((c) => ({
        toolkit: c.toolkit,
        connected: c.connected,
        account_id: c.accountId,
      })),
    };
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private ensureInitialized(): void {
    if (!this.evolve) {
      throw new Error('Bridge not initialized. Call initialize() first.');
    }
  }
}
