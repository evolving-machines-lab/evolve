# OAuth File Support for Codex and Gemini CLI Agents

## Summary

Add `oauthFile` support for Codex and Gemini agents, enabling users with ChatGPT Pro or Google AI subscriptions to use their OAuth-authenticated CLIs through Evolve SDK without API keys.

## Background

### Current State

| Agent | OAuth Support | Mechanism |
|-------|--------------|-----------|
| Claude | ✅ `oauthToken` | Env var: `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | ❌ | Only `providerApiKey` → `OPENAI_API_KEY` |
| Gemini | ❌ | Only `providerApiKey` → `GEMINI_API_KEY` |

### CLI Auth Mechanisms

- **Claude CLI**: Reads OAuth token from `CLAUDE_CODE_OAUTH_TOKEN` env var
- **Codex CLI**: Reads OAuth from `~/.codex/auth.json` file (no env var support)
- **Gemini CLI**: Reads OAuth from `~/.gemini/oauth_creds.json` file (no env var support)

### Auth File Structures

**Codex** (`~/.codex/auth.json`):
```json
{
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "eyJ...",
    "access_token": "eyJ...",
    "refresh_token": "rt_...",
    "account_id": "..."
  },
  "last_refresh": "2026-01-27T04:36:44.371836Z"
}
```

**Gemini** (`~/.gemini/oauth_creds.json`):
```json
{
  "access_token": "ya29...",
  "refresh_token": "1//...",
  "scope": "https://www.googleapis.com/auth/cloud-platform ...",
  "token_type": "Bearer",
  "id_token": "eyJ...",
  "expiry_date": 1769491184144
}
```

## Design

### Approach: File-Based OAuth Injection

Copy the auth file content to the sandbox at the expected path. This approach was chosen over token-based injection for reliability:

1. **Forward compatible**: If CLIs add new auth fields, file copy still works
2. **Minimal error surface**: Single file write vs. constructing complex JSON
3. **Local parity**: If local auth works, sandbox auth will too
4. **Low maintenance**: No need to track auth schema changes per CLI version

### User Experience

```typescript
// Development: Point to local auth file
const agent = new Evolve()
  .withAgent({
    type: "codex",
    oauthFile: "~/.codex/auth.json"
  })
  .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }));

// CI/CD: Pass file content from secrets
const agent = new Evolve()
  .withAgent({
    type: "gemini",
    oauthFile: process.env.GEMINI_OAUTH_JSON  // raw JSON content
  })
  .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }));

// Environment variable fallback
// CODEX_OAUTH_FILE=~/.codex/auth.json (path)
// GEMINI_OAUTH_FILE={"access_token":...} (content)
```

### Resolution Priority

For Codex/Gemini agents:
1. `oauthFile` (explicit) → Direct mode with auth file
2. `providerApiKey` (explicit) → Direct mode with API key
3. `apiKey` (Evolve key) → Gateway mode
4. `CODEX_OAUTH_FILE` / `GEMINI_OAUTH_FILE` env var → Direct mode with auth file
5. `OPENAI_API_KEY` / `GEMINI_API_KEY` env var → Direct mode with API key
6. `EVOLVE_API_KEY` env var → Gateway mode

## Implementation

### 1. Type Changes

**types.ts**:
```typescript
export interface AgentConfig {
  type: AgentType;
  apiKey?: string;
  providerApiKey?: string;
  oauthToken?: string;  // Claude only (env var based)

  /**
   * OAuth auth file for Codex/Gemini.
   * Accepts file path (e.g., "~/.codex/auth.json") or raw JSON content.
   * Default: CODEX_OAUTH_FILE or GEMINI_OAUTH_FILE env var
   */
  oauthFile?: string;

  model?: string;
  reasoningEffort?: ReasoningEffort;
  betas?: string[];
}

export interface ResolvedAgentConfig {
  type: AgentType;
  apiKey: string;
  baseUrl?: string;
  isDirectMode: boolean;
  isOAuth?: boolean;
  oauthFileContent?: string;  // Resolved auth file JSON content
  model?: string;
  reasoningEffort?: ReasoningEffort;
  betas?: string[];
}
```

### 2. Registry Changes

**registry.ts**:
```typescript
export interface AgentRegistryEntry {
  templateId: string;
  apiKeyEnv: string;
  oauthEnv?: string;           // Claude: CLAUDE_CODE_OAUTH_TOKEN
  oauthFileEnv?: string;       // NEW: Codex: CODEX_OAUTH_FILE, Gemini: GEMINI_OAUTH_FILE
  oauthFilePath?: string;      // NEW: Target path in sandbox
  baseUrlEnv: string;
  // ... rest unchanged
}

// Registry entries:
codex: {
  // ... existing fields
  oauthFileEnv: "CODEX_OAUTH_FILE",
  oauthFilePath: "~/.codex/auth.json",
}

gemini: {
  // ... existing fields
  oauthFileEnv: "GEMINI_OAUTH_FILE",
  oauthFilePath: "~/.gemini/oauth_creds.json",
}
```

### 3. Config Resolution

**config.ts** - Add new resolution path:
```typescript
export function resolveAgentConfig(type: AgentType, config?: AgentConfig): ResolvedAgentConfig {
  // 1. Claude oauthToken (existing)
  if (config?.oauthToken) {
    if (type !== "claude") throw new Error("oauthToken only supported for claude");
    return { type, apiKey: config.oauthToken, isDirectMode: true, isOAuth: true, ... };
  }

  // 2. NEW: Codex/Gemini oauthFile
  if (config?.oauthFile || process.env[registry[type].oauthFileEnv]) {
    if (type === "claude") throw new Error("Use oauthToken for claude, not oauthFile");
    const fileContent = resolveOAuthFile(config?.oauthFile || process.env[registry[type].oauthFileEnv]);
    return {
      type,
      apiKey: "", // Not needed for file-based auth
      isDirectMode: true,
      isOAuth: true,
      oauthFileContent: fileContent,
      ...
    };
  }

  // 3. providerApiKey (existing)
  // 4. apiKey / EVOLVE_API_KEY (existing)
  // ...
}

function resolveOAuthFile(input: string): string {
  // If input looks like JSON, return as-is
  if (input.trim().startsWith("{")) {
    return input;
  }
  // Otherwise treat as file path, expand ~ and read
  const expandedPath = input.replace(/^~/, os.homedir());
  return fs.readFileSync(expandedPath, "utf-8");
}
```

### 4. Sandbox Setup

**agent.ts** - Modify `setupAgentAuth`:
```typescript
private async setupAgentAuth(sandbox: SandboxInstance): Promise<void> {
  // NEW: Write OAuth file if provided
  if (this.agentConfig.oauthFileContent && this.registry.oauthFilePath) {
    const targetPath = this.registry.oauthFilePath.replace(/^~/, "/home/user");

    // Ensure directory exists
    const dir = path.dirname(targetPath);
    await sandbox.commands.run(`mkdir -p ${dir}`);

    // Write auth file with restricted permissions
    await sandbox.files.write(targetPath, this.agentConfig.oauthFileContent);
    await sandbox.commands.run(`chmod 600 ${targetPath}`);

    // Skip setupCommand - already authenticated
    return;
  }

  // Existing: Run setupCommand for API key auth
  if (this.registry.setupCommand) {
    await sandbox.commands.run(this.registry.setupCommand, { timeoutMs: 30000 });
  }
}
```

**agent.ts** - Modify `buildEnvironmentVariables`:
```typescript
private buildEnvironmentVariables(): Record<string, string> {
  const envVars: Record<string, string> = {};

  // OAuth file mode: no env vars needed (auth is file-based)
  if (this.agentConfig.oauthFileContent) {
    // Only pass secrets if provided
    if (this.options.secrets) {
      Object.assign(envVars, this.options.secrets);
    }
    return envVars;
  }

  // Existing logic for oauthToken / apiKey modes...
}
```

## Files to Modify

| File | Changes |
|------|---------|
| `packages/sdk-ts/src/types.ts` | Add `oauthFile` to AgentConfig, `oauthFileContent` to ResolvedAgentConfig |
| `packages/sdk-ts/src/registry.ts` | Add `oauthFileEnv`, `oauthFilePath` to interface and codex/gemini entries |
| `packages/sdk-ts/src/utils/config.ts` | Add oauthFile resolution logic with file path expansion |
| `packages/sdk-ts/src/agent.ts` | Write auth file to sandbox, skip setupCommand for OAuth |

## Testing Strategy

### Unit Tests
- `config.test.ts`: Test oauthFile resolution (path vs content, ~ expansion)
- `config.test.ts`: Test resolution priority (oauthFile > providerApiKey > apiKey)
- `config.test.ts`: Test error on oauthFile for claude agent

### Integration Tests
- `16-codex-oauth.ts`: Run Codex agent with oauthFile pointing to ~/.codex/auth.json
- `17-gemini-oauth.ts`: Run Gemini agent with oauthFile pointing to ~/.gemini/oauth_creds.json
- Verify agents can execute tasks without API keys

## Rollout

1. Implement types and registry changes
2. Add config resolution logic
3. Modify agent sandbox setup
4. Add unit tests
5. Add integration tests
6. Update documentation/README

## Open Questions

None - design is complete.
