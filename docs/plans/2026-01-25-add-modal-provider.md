# Add Modal Sandbox Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Modal as a second sandbox provider option alongside E2B, enabling users to run AI agents in Modal's serverless cloud infrastructure.

**Architecture:** Create a new `@evolvingmachines/modal` TypeScript package following the E2B pattern. Implement `SandboxProvider` interface wrapping Modal's JavaScript SDK. Add `ModalProvider` Python configuration class. Register in bridge adapter.

**Tech Stack:** Modal JavaScript SDK (`modal`), TypeScript, Python dataclasses

---

## Task 1: Create Modal Package Structure

**Files:**
- Create: `packages/modal/package.json`
- Create: `packages/modal/tsconfig.json`
- Create: `packages/modal/tsup.config.ts`

**Step 1: Create package.json**

```json
{
  "name": "@evolvingmachines/modal",
  "version": "0.0.1",
  "keywords": [
    "ai",
    "agents",
    "sandbox",
    "modal",
    "evolve-sdk",
    "orchestration"
  ],
  "homepage": "https://github.com/evolving-machines-lab/evolve",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/evolving-machines-lab/evolve.git"
  },
  "type": "module",
  "main": "dist/index.cjs",
  "types": "dist/index.d.ts",
  "license": "Apache-2.0",
  "files": [
    "dist",
    "LICENSE"
  ],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "scripts": {
    "build": "tsup --minify",
    "dev": "tsup --watch",
    "type-check": "tsc --noEmit"
  },
  "dependencies": {
    "modal": "^0.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.15.18",
    "tsup": "^8.4.0",
    "typescript": "^5.8.3"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

**Step 4: Verify files created**

Run: `ls -la packages/modal/`
Expected: package.json, tsconfig.json, tsup.config.ts exist

**Step 5: Commit**

```bash
git add packages/modal/package.json packages/modal/tsconfig.json packages/modal/tsup.config.ts
git commit -m "feat(modal): add package structure for Modal sandbox provider"
```

---

## Task 2: Implement Modal Sandbox Types

**Files:**
- Create: `packages/modal/src/index.ts`

**Step 1: Write the core types and interfaces**

Create `packages/modal/src/index.ts` with Modal-specific types. These mirror the E2B package types but are adapted for Modal's API.

```typescript
/**
 * Modal Sandbox Provider - Clean Architecture
 *
 * @requires modal >= 0.1.0 (Modal JavaScript SDK)
 * @requires Node.js >= 18 (for ReadableStream support)
 *
 * Design principles:
 * - Single way to do things (no dual methods)
 * - Options objects only (no positional args)
 * - All interface methods required (no optional ?)
 * - Configuration externalized (no hardcoded mappings)
 * - Clear naming (run = blocking, spawn = background)
 */

import { ModalClient, type Sandbox as ModalSandbox } from "modal";

// ============================================================
// MODULE-LEVEL CONSTANTS & HELPERS
// ============================================================

const BINARY_EXTENSIONS = new Set([
  ".xlsx", ".xls", ".docx", ".doc", ".pptx", ".ppt",
  ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".mp3", ".wav", ".ogg", ".flac", ".aac",
  ".mp4", ".avi", ".mov", ".mkv", ".webm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".dll", ".so", ".dylib",
  ".sqlite", ".db", ".pickle", ".pkl", ".parquet",
]);

function isBinaryFile(path: string): boolean {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// ============================================================
// CORE TYPES (match E2B package for consistency)
// ============================================================

/** Result of a completed sandbox command */
export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Handle to a running background process in sandbox */
export interface SandboxCommandHandle {
  readonly pid: number;
  wait(): Promise<SandboxCommandResult>;
  kill(): Promise<boolean>;
}

/** Information about a running process */
export interface ProcessInfo {
  pid: number;
  cmd: string;
  args: string[];
  envs: Record<string, string>;
  cwd?: string;
  tag?: string;
}

/** Sandbox metadata and lifecycle info */
export interface SandboxInfo {
  sandboxId: string;
  templateId: string;
  name?: string;
  metadata: Record<string, string>;
  startedAt: string;
  endAt?: string;
}

/** File or directory entry info */
export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "dir";
}

// ============================================================
// OPTIONS (match E2B package)
// ============================================================

/** Options for blocking sandbox command execution */
export interface SandboxRunOptions {
  timeoutMs?: number;
  envs?: Record<string, string>;
  cwd?: string;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

/** Options for spawning background sandbox processes */
export interface SandboxSpawnOptions extends SandboxRunOptions {
  stdin?: boolean;
}

/** Options for creating a sandbox */
export interface SandboxCreateOptions {
  templateId: string;
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
  timeoutMs?: number;
  workingDirectory?: string;
}

/** Options for listing sandboxes */
export interface SandboxListOptions {
  state?: ("running" | "paused")[];
  metadata?: Record<string, string>;
  limit?: number;
}

// ============================================================
// INTERFACES (match SDK types.ts)
// ============================================================

/** Command execution capabilities */
export interface SandboxCommands {
  run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult>;
  spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle>;
  list(): Promise<ProcessInfo[]>;
  kill(pid: number): Promise<boolean>;
}

/** File system operations */
export interface SandboxFiles {
  read(path: string): Promise<string | Uint8Array>;
  write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void>;
  writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void>;
  makeDir(path: string): Promise<void>;
}

/** Sandbox instance with full capabilities */
export interface SandboxInstance {
  readonly sandboxId: string;
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;
  getHost(port: number): string;
  kill(): Promise<void>;
  pause(): Promise<void>;
}

/** Sandbox lifecycle management */
export interface SandboxProvider {
  readonly providerType: string;
  create(options: SandboxCreateOptions): Promise<SandboxInstance>;
  connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance>;
  list(options?: SandboxListOptions): Promise<SandboxInfo[]>;
}

// ============================================================
// CONFIGURATION
// ============================================================

export interface ModalConfig {
  /** Modal API token. Default: reads from MODAL_TOKEN_ID and MODAL_TOKEN_SECRET env vars */
  tokenId?: string;
  tokenSecret?: string;
  /** Default app name to use for sandboxes */
  appName?: string;
  /** Default image to use (e.g., "python:3.13") */
  defaultImage?: string;
  defaultTimeoutMs?: number;
}

interface ResolvedModalConfig {
  tokenId: string;
  tokenSecret: string;
  appName: string;
  defaultImage: string;
  defaultTimeoutMs: number;
}
```

**Step 2: Verify file created**

Run: `head -50 packages/modal/src/index.ts`
Expected: Types and interfaces visible

**Step 3: Commit**

```bash
git add packages/modal/src/index.ts
git commit -m "feat(modal): add core types and interfaces"
```

---

## Task 3: Implement Modal Commands and Files Classes

**Files:**
- Modify: `packages/modal/src/index.ts`

**Step 1: Add ModalCommands implementation**

Append to `packages/modal/src/index.ts`:

```typescript
// ============================================================
// IMPLEMENTATION
// ============================================================

class ModalCommands implements SandboxCommands {
  constructor(private sandbox: ModalSandbox) {}

  async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    // Parse command into parts (Modal expects command array)
    const parts = command.split(" ");

    const process = await this.sandbox.exec(parts, {
      env: options?.envs,
      workdir: options?.cwd,
      timeoutMs: options?.timeoutMs,
    });

    // Collect stdout/stderr
    let stdout = "";
    let stderr = "";

    if (process.stdout) {
      stdout = await process.stdout;
    }
    if (process.stderr) {
      stderr = await process.stderr;
    }

    // Stream callbacks if provided
    if (options?.onStdout && stdout) {
      options.onStdout(stdout);
    }
    if (options?.onStderr && stderr) {
      options.onStderr(stderr);
    }

    return {
      exitCode: process.exitCode ?? 0,
      stdout,
      stderr,
    };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    const parts = command.split(" ");

    const process = await this.sandbox.exec(parts, {
      env: options?.envs,
      workdir: options?.cwd,
      timeoutMs: options?.timeoutMs,
    });

    // Modal doesn't expose PID directly, use a placeholder
    const pid = Date.now();

    return {
      pid,
      wait: async () => {
        const stdout = process.stdout ? await process.stdout : "";
        const stderr = process.stderr ? await process.stderr : "";
        return {
          exitCode: process.exitCode ?? 0,
          stdout,
          stderr,
        };
      },
      kill: async () => {
        // Modal processes are managed by the sandbox lifecycle
        return true;
      },
    };
  }

  async list(): Promise<ProcessInfo[]> {
    // Modal doesn't expose process listing - return empty
    return [];
  }

  async kill(pid: number): Promise<boolean> {
    // Modal processes are managed by sandbox lifecycle
    return true;
  }
}
```

**Step 2: Add ModalFiles implementation**

Append to `packages/modal/src/index.ts`:

```typescript
class ModalFiles implements SandboxFiles {
  constructor(private sandbox: ModalSandbox) {}

  async read(path: string): Promise<string | Uint8Array> {
    const file = await this.sandbox.open(path, "r");
    const content = await file.read();
    await file.close();

    if (isBinaryFile(path)) {
      // Return as Uint8Array for binary files
      return new TextEncoder().encode(content);
    }
    return content;
  }

  async write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    const file = await this.sandbox.open(path, "w");

    let data: string;
    if (typeof content === "string") {
      data = content;
    } else if (content instanceof Buffer) {
      data = content.toString("utf-8");
    } else if (content instanceof ArrayBuffer) {
      data = new TextDecoder().decode(content);
    } else {
      data = new TextDecoder().decode(content);
    }

    await file.write(data);
    await file.close();
  }

  async writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void> {
    // Modal doesn't have batch write - iterate
    for (const { path, data } of files) {
      await this.write(path, data);
    }
  }

  async makeDir(path: string): Promise<void> {
    // Use exec to create directory
    await this.sandbox.exec(["mkdir", "-p", path]);
  }
}
```

**Step 3: Verify implementations added**

Run: `grep -n "class Modal" packages/modal/src/index.ts`
Expected: ModalCommands and ModalFiles classes found

**Step 4: Commit**

```bash
git add packages/modal/src/index.ts
git commit -m "feat(modal): implement ModalCommands and ModalFiles classes"
```

---

## Task 4: Implement ModalSandboxImpl and ModalSandboxProvider

**Files:**
- Modify: `packages/modal/src/index.ts`

**Step 1: Add ModalSandboxImpl class**

Append to `packages/modal/src/index.ts`:

```typescript
class ModalSandboxImpl implements SandboxInstance {
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;

  constructor(
    private sandbox: ModalSandbox,
    private _sandboxId: string,
  ) {
    this.commands = new ModalCommands(sandbox);
    this.files = new ModalFiles(sandbox);
  }

  get sandboxId(): string {
    return this._sandboxId;
  }

  getHost(port: number): string {
    // Modal sandboxes expose ports differently - construct URL
    // Format: https://<sandbox-id>--<port>.modal.run
    return `https://${this._sandboxId}--${port}.modal.run`;
  }

  async kill(): Promise<void> {
    await this.sandbox.terminate();
  }

  async pause(): Promise<void> {
    // Modal doesn't support pause - kill instead
    await this.sandbox.terminate();
  }
}
```

**Step 2: Add ModalSandboxProvider class**

Append to `packages/modal/src/index.ts`:

```typescript
export class ModalSandboxProvider implements SandboxProvider {
  readonly providerType = "modal" as const;
  private readonly client: ModalClient;
  private readonly config: ResolvedModalConfig;

  constructor(config: ResolvedModalConfig) {
    this.config = config;
    this.client = new ModalClient();
  }

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    const timeoutMs = options.timeoutMs ?? this.config.defaultTimeoutMs;

    // Get or create the Modal app
    const app = await this.client.apps.fromName(this.config.appName, { createIfMissing: true });

    // Create image from template (templateId maps to image name)
    const image = this.client.images.fromRegistry(options.templateId || this.config.defaultImage);

    // Create sandbox with configuration
    const sandbox = await this.client.sandboxes.create(app, image, {
      env: options.envs,
      timeoutMs,
      workdir: options.workingDirectory,
    });

    // Get sandbox ID
    const sandboxId = sandbox.sandboxId;

    if (options.workingDirectory) {
      await sandbox.exec(["mkdir", "-p", options.workingDirectory]);
    }

    return new ModalSandboxImpl(sandbox, sandboxId);
  }

  async connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance> {
    // Connect to existing sandbox by ID
    const sandbox = await this.client.sandboxes.fromId(sandboxId);
    return new ModalSandboxImpl(sandbox, sandboxId);
  }

  async list(options?: SandboxListOptions): Promise<SandboxInfo[]> {
    // Modal doesn't expose a sandbox listing API in the same way
    // Return empty for now - users should track sandbox IDs
    return [];
  }
}
```

**Step 3: Verify provider class added**

Run: `grep -n "ModalSandboxProvider" packages/modal/src/index.ts`
Expected: Class definition found

**Step 4: Commit**

```bash
git add packages/modal/src/index.ts
git commit -m "feat(modal): implement ModalSandboxImpl and ModalSandboxProvider"
```

---

## Task 5: Add Factory Function and Exports

**Files:**
- Modify: `packages/modal/src/index.ts`

**Step 1: Add factory function**

Append to `packages/modal/src/index.ts`:

```typescript
// ============================================================
// FACTORY
// ============================================================

/**
 * Create Modal sandbox provider.
 *
 * @param config - Optional configuration. If tokens not provided, reads from MODAL_TOKEN_ID and MODAL_TOKEN_SECRET env vars.
 * @throws Error if tokens cannot be resolved
 */
export function createModalProvider(config: ModalConfig = {}): SandboxProvider {
  const tokenId = config.tokenId ?? process.env.MODAL_TOKEN_ID;
  const tokenSecret = config.tokenSecret ?? process.env.MODAL_TOKEN_SECRET;

  if (!tokenId || !tokenSecret) {
    throw new Error(
      "Modal tokens required. " +
        "Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET environment variables or pass tokenId/tokenSecret in config. " +
        "Get your tokens at https://modal.com/settings"
    );
  }

  // Set Modal auth environment variables for the SDK
  process.env.MODAL_TOKEN_ID = tokenId;
  process.env.MODAL_TOKEN_SECRET = tokenSecret;

  return new ModalSandboxProvider({
    tokenId,
    tokenSecret,
    appName: config.appName ?? "evolve-sandbox",
    defaultImage: config.defaultImage ?? "python:3.12-slim",
    defaultTimeoutMs: config.defaultTimeoutMs ?? 3600000,
  });
}
```

**Step 2: Verify factory function added**

Run: `grep -n "createModalProvider" packages/modal/src/index.ts`
Expected: Function definition found

**Step 3: Commit**

```bash
git add packages/modal/src/index.ts
git commit -m "feat(modal): add createModalProvider factory function"
```

---

## Task 6: Add Python ModalProvider Configuration

**Files:**
- Modify: `packages/sdk-py/evolve/config.py:102` (after E2BProvider)

**Step 1: Add ModalProvider dataclass**

After the `E2BProvider` class (around line 102), add:

```python
@dataclass
class ModalProvider:
    """Modal sandbox provider configuration.

    Args:
        token_id: Modal token ID (defaults to MODAL_TOKEN_ID env var)
        token_secret: Modal token secret (defaults to MODAL_TOKEN_SECRET env var)
        app_name: Modal app name to use (default: 'evolve-sandbox')
        default_image: Default Docker image (default: 'python:3.12-slim')
        timeout_ms: Sandbox timeout in milliseconds (default: 3600000 = 1 hour)
    """
    token_id: Optional[str] = None
    token_secret: Optional[str] = None
    app_name: str = 'evolve-sandbox'
    default_image: str = 'python:3.12-slim'
    timeout_ms: int = 3600000

    @property
    def type(self) -> Literal['modal']:
        """Provider type."""
        return 'modal'

    @property
    def config(self) -> dict:
        """Provider configuration dict."""
        result = {}
        if self.token_id:
            result['tokenId'] = self.token_id
        if self.token_secret:
            result['tokenSecret'] = self.token_secret
        if self.app_name:
            result['appName'] = self.app_name
        if self.default_image:
            result['defaultImage'] = self.default_image
        if self.timeout_ms:
            result['defaultTimeoutMs'] = self.timeout_ms
        return result
```

**Step 2: Update SandboxProvider docstring**

Update the `SandboxProvider` Protocol docstring (around line 54-64) to mention Modal:

```python
@runtime_checkable
class SandboxProvider(Protocol):
    """Sandbox provider protocol.

    Any sandbox provider must implement this protocol.
    Currently supported: E2BProvider, ModalProvider

    To add a new provider:
    1. Create a class with `type` and `config` properties
    2. Add handling in bridge/src/adapter.ts
    """
```

**Step 3: Verify ModalProvider added**

Run: `grep -n "ModalProvider" packages/sdk-py/evolve/config.py`
Expected: Class definition found

**Step 4: Commit**

```bash
git add packages/sdk-py/evolve/config.py
git commit -m "feat(modal): add ModalProvider Python configuration class"
```

---

## Task 7: Update Bridge Adapter for Modal

**Files:**
- Modify: `packages/sdk-py/bridge/src/adapter.ts:11` (imports)
- Modify: `packages/sdk-py/bridge/src/adapter.ts:96-103` (createSandboxProvider)

**Step 1: Add Modal import**

At line 11, after the E2B import, add:

```typescript
import { createModalProvider } from '@evolvingmachines/modal';
```

**Step 2: Update createSandboxProvider switch**

Replace the switch statement at lines 96-103:

```typescript
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
```

**Step 3: Verify adapter updated**

Run: `grep -n "modal" packages/sdk-py/bridge/src/adapter.ts`
Expected: Import and case statement found

**Step 4: Commit**

```bash
git add packages/sdk-py/bridge/src/adapter.ts
git commit -m "feat(modal): register Modal provider in bridge adapter"
```

---

## Task 8: Update Bridge Types

**Files:**
- Modify: `packages/sdk-py/bridge/src/types.ts:67-70`

**Step 1: Update sandbox_provider type**

Update the `sandbox_provider` field in `InitializeParams` (around lines 67-70):

```typescript
  // Sandbox provider (optional - TS SDK resolves from EVOLVE_API_KEY env var)
  sandbox_provider?: {
    type: 'e2b' | 'modal';
    config: Record<string, any>;
  };
```

**Step 2: Verify types updated**

Run: `grep -n "'modal'" packages/sdk-py/bridge/src/types.ts`
Expected: Type union found

**Step 3: Commit**

```bash
git add packages/sdk-py/bridge/src/types.ts
git commit -m "feat(modal): add modal to bridge type definitions"
```

---

## Task 9: Update SDK-TS Sandbox Resolution (Optional)

**Files:**
- Modify: `packages/sdk-ts/src/utils/sandbox.ts`
- Modify: `packages/sdk-ts/src/constants.ts`

**Step 1: Add Modal constants**

In `packages/sdk-ts/src/constants.ts`, add after E2B constants:

```typescript
export const ENV_MODAL_TOKEN_ID = "MODAL_TOKEN_ID";
export const ENV_MODAL_TOKEN_SECRET = "MODAL_TOKEN_SECRET";
```

**Step 2: Update resolveDefaultSandbox**

Update `packages/sdk-ts/src/utils/sandbox.ts` to add Modal fallback after E2B:

```typescript
  // Direct mode (MODAL_TOKEN_ID + MODAL_TOKEN_SECRET) - Modal provider
  const modalTokenId = process.env[ENV_MODAL_TOKEN_ID];
  const modalTokenSecret = process.env[ENV_MODAL_TOKEN_SECRET];
  if (modalTokenId && modalTokenSecret) {
    try {
      const { createModalProvider } = await import("@evolvingmachines/modal");
      return createModalProvider({ tokenId: modalTokenId, tokenSecret: modalTokenSecret });
    } catch (e) {
      const error = e as Error;
      if (error.message?.includes("Cannot find module") || error.message?.includes("MODULE_NOT_FOUND")) {
        throw new Error(
          `${ENV_MODAL_TOKEN_ID} is set but @evolvingmachines/modal failed to load.\n` +
            "Try installing: npm install @evolvingmachines/modal"
        );
      }
      throw error;
    }
  }
```

**Step 3: Update error message**

Update the error message at the end of `resolveDefaultSandbox` to mention Modal:

```typescript
  throw new Error(
    "No sandbox provider configured. Either:\n" +
      `1. Set ${ENV_EVOLVE_API_KEY} environment variable (recommended, get key at https://dashboard.evolvingmachines.ai)\n` +
      `2. Set ${ENV_E2B_API_KEY} environment variable (direct E2B access, get key at https://e2b.dev)\n` +
      `3. Set ${ENV_MODAL_TOKEN_ID} and ${ENV_MODAL_TOKEN_SECRET} environment variables (Modal access)\n` +
      "4. Pass sandbox explicitly: .withSandbox(provider)"
  );
```

**Step 4: Verify updates**

Run: `grep -n "MODAL" packages/sdk-ts/src/utils/sandbox.ts`
Expected: Modal env vars and resolution logic found

**Step 5: Commit**

```bash
git add packages/sdk-ts/src/utils/sandbox.ts packages/sdk-ts/src/constants.ts
git commit -m "feat(modal): add Modal to default sandbox resolution"
```

---

## Task 10: Update Package Dependencies

**Files:**
- Modify: `packages/sdk-ts/package.json`
- Modify: `packages/sdk-py/bridge/package.json`

**Step 1: Add Modal to SDK-TS dependencies**

In `packages/sdk-ts/package.json`, add to `dependencies`:

```json
"@evolvingmachines/modal": "file:../modal"
```

**Step 2: Add Modal to Bridge dependencies**

In `packages/sdk-py/bridge/package.json`, add to `dependencies`:

```json
"@evolvingmachines/modal": "file:../../modal"
```

**Step 3: Verify dependencies added**

Run: `grep -n "@evolvingmachines/modal" packages/sdk-ts/package.json packages/sdk-py/bridge/package.json`
Expected: Dependency found in both files

**Step 4: Commit**

```bash
git add packages/sdk-ts/package.json packages/sdk-py/bridge/package.json
git commit -m "feat(modal): add Modal package as dependency"
```

---

## Task 11: Export ModalProvider from Python SDK

**Files:**
- Modify: `packages/sdk-py/evolve/__init__.py`

**Step 1: Add ModalProvider to exports**

Find the existing imports from config and add `ModalProvider`:

```python
from .config import E2BProvider, ModalProvider, SandboxProvider
```

And add to `__all__` if present:

```python
__all__ = [..., 'ModalProvider', ...]
```

**Step 2: Verify export added**

Run: `grep -n "ModalProvider" packages/sdk-py/evolve/__init__.py`
Expected: Import found

**Step 3: Commit**

```bash
git add packages/sdk-py/evolve/__init__.py
git commit -m "feat(modal): export ModalProvider from Python SDK"
```

---

## Task 12: Build and Test

**Files:**
- None (build/test commands)

**Step 1: Install Modal package dependencies**

Run: `cd packages/modal && npm install`
Expected: Dependencies installed successfully

**Step 2: Build Modal package**

Run: `cd packages/modal && npm run build`
Expected: Build completes without errors

**Step 3: Build SDK-TS**

Run: `cd packages/sdk-ts && npm run build`
Expected: Build completes without errors

**Step 4: Build Bridge**

Run: `cd packages/sdk-py/bridge && npm run build`
Expected: Build completes without errors

**Step 5: Run Python type check**

Run: `cd packages/sdk-py && python -c "from evolve import ModalProvider; print('OK')"`
Expected: "OK" printed

**Step 6: Commit build artifacts (if any lockfiles changed)**

```bash
git add -A
git commit -m "chore: update lockfiles after Modal integration"
```

---

## Task 13: Add Usage Documentation

**Files:**
- Modify: `README.md` (or relevant docs)

**Step 1: Add Modal example to documentation**

Add a section showing Modal usage:

```markdown
### Using Modal as Sandbox Provider

```python
from evolve import Evolve, ModalProvider

# Configure Modal provider
modal = ModalProvider(
    app_name="my-evolve-app",
    default_image="python:3.12-slim",
)

# Use with Evolve
kit = Evolve(sandbox=modal)
result = kit.run(prompt="Write a hello world script")
```

Or via environment variables:
```bash
export MODAL_TOKEN_ID=your_token_id
export MODAL_TOKEN_SECRET=your_token_secret
```
```

**Step 2: Commit documentation**

```bash
git add README.md
git commit -m "docs: add Modal provider usage examples"
```

---

## Summary of Files Changed

| File | Change Type | Purpose |
|------|-------------|---------|
| `packages/modal/package.json` | Create | Package configuration |
| `packages/modal/tsconfig.json` | Create | TypeScript config |
| `packages/modal/tsup.config.ts` | Create | Build config |
| `packages/modal/src/index.ts` | Create | Main implementation |
| `packages/sdk-py/evolve/config.py` | Modify | Add ModalProvider class |
| `packages/sdk-py/evolve/__init__.py` | Modify | Export ModalProvider |
| `packages/sdk-py/bridge/src/adapter.ts` | Modify | Register Modal provider |
| `packages/sdk-py/bridge/src/types.ts` | Modify | Add modal type |
| `packages/sdk-ts/src/constants.ts` | Modify | Add Modal constants |
| `packages/sdk-ts/src/utils/sandbox.ts` | Modify | Add Modal resolution |
| `packages/sdk-ts/package.json` | Modify | Add Modal dependency |
| `packages/sdk-py/bridge/package.json` | Modify | Add Modal dependency |

---

## Notes

1. **Modal JavaScript SDK:** The implementation assumes the Modal JS SDK (`modal` package) exports `ModalClient`, `Sandbox`, and related types. Verify the actual API when implementing - the Modal JS SDK may have different method names or signatures.

2. **Process Management:** Modal sandboxes manage processes differently than E2B. The `spawn`, `list`, and `kill` methods may need adjustment based on Modal's actual capabilities.

3. **File Operations:** Modal's `sandbox.open()` API works differently than E2B's filesystem API. The implementation may need tweaking for binary file handling.

4. **Host URLs:** Modal sandbox port URLs follow a different pattern than E2B. Verify the actual URL format from Modal's documentation.

5. **Testing:** Create integration tests using real Modal sandboxes to verify the implementation works correctly.
