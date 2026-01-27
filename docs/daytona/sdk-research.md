# Daytona SDK Research

> Compiled: January 2026
> Purpose: Integration research for Evolve SDK multi-provider support

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [Authentication](#authentication)
4. [Daytona Class (Main Entry Point)](#daytona-class)
5. [Sandbox Class](#sandbox-class)
6. [Process & Code Execution](#process--code-execution)
7. [FileSystem Operations](#filesystem-operations)
8. [Snapshots](#snapshots)
9. [Volumes](#volumes)
10. [Images](#images)
11. [Git Operations](#git-operations)
12. [Daytona vs E2B Comparison](#daytona-vs-e2b-comparison)
13. [API Mapping to Evolve Interfaces](#api-mapping-to-evolve-interfaces)

---

## Overview

Daytona SDK provides TypeScript and Python interfaces for managing cloud-based development sandboxes. Key features:

- **Sub-200ms startup time** (no cold starts)
- **Multiple runtimes**: Node.js, Deno, Bun, browsers, serverless (Cloudflare Workers, AWS Lambda, Azure Functions)
- **Isolation**: OCI/Docker containers (default) or VMs for stronger isolation
- **Persistent storage**: Snapshots and Volumes
- **Full computer access**: Terminal, file system, Git, LSP, browser automation

### Package Info

```
Package: @daytonaio/sdk
NPM: https://www.npmjs.com/package/@daytonaio/sdk
GitHub: https://github.com/daytonaio/sdk (archived, moved to monorepo)
Docs: https://www.daytona.io/docs/en/typescript-sdk/
License: Apache-2.0
```

---

## Installation

```bash
npm install @daytonaio/sdk
# or
yarn add @daytonaio/sdk
```

---

## Authentication

### Environment Variables

```bash
DAYTONA_API_KEY=your-api-key      # Required
DAYTONA_API_URL=https://app.daytona.io/api  # Optional, default
DAYTONA_TARGET=us                 # Optional, region
```

### Programmatic Configuration

```typescript
import { Daytona } from '@daytonaio/sdk'

// Auto-resolve from environment
const daytona = new Daytona()

// Explicit configuration
const daytona = new Daytona({
  apiKey: 'YOUR_API_KEY',
  apiUrl: 'https://app.daytona.io/api',
  target: 'us'
})
```

**Throws**: `DaytonaError` if API key is missing.

---

## Daytona Class

The main entry point for the SDK.

### Constructor

```typescript
new Daytona(config?: DaytonaConfig)
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `snapshot` | `SnapshotService` | Manage Daytona snapshots |
| `volume` | `VolumeService` | Manage Daytona volumes |

### Methods

#### `create(params?, options?): Promise<Sandbox>`

Creates a sandbox from snapshot or image.

```typescript
const sandbox = await daytona.create({
  language: 'typescript',  // 'python' | 'typescript' | 'javascript'
  envVars: { NODE_ENV: 'development' },
  // Optional:
  name: 'my-sandbox',
  labels: { project: 'evolve' },
  resources: { cpu: 2, memory: 4, disk: 10 },
  autoStopInterval: 30,  // minutes
  autoArchiveInterval: 7,  // days
  autoDeleteInterval: -1,  // disabled
  ephemeral: false,  // true = delete on stop
})
```

**Options**:
- `timeout`: Seconds (0 = no timeout, default 60)
- `onSnapshotCreateLogs`: Callback for image build logs

#### `get(sandboxIdOrName: string): Promise<Sandbox>`

Retrieve sandbox by ID or name.

#### `findOne(filter: SandboxFilter): Promise<Sandbox>`

Find first sandbox matching filter (id, name, or labels).

#### `list(labels?, page?, limit?): Promise<PaginatedSandboxes>`

List sandboxes with optional filtering and pagination.

```typescript
interface PaginatedSandboxes {
  items: Sandbox[]
  page: number
  total: number
  totalPages: number
}
```

#### `start(sandbox: Sandbox, timeout?): Promise<void>`

Start a stopped sandbox.

#### `stop(sandbox: Sandbox): Promise<void>`

Stop a running sandbox.

#### `delete(sandbox: Sandbox, timeout?): Promise<void>`

Delete a sandbox (default timeout: 60s).

---

## Sandbox Class

Represents a Daytona sandbox environment.

### Properties

#### Resource Configuration

| Property | Type | Description |
|----------|------|-------------|
| `cpu` | `number` | CPU cores |
| `memory` | `number` | Memory in GiB |
| `gpu` | `number` | GPU count |
| `disk` | `number` | Disk in GiB |

#### Identity

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique identifier |
| `name` | `string` | Sandbox name |
| `user` | `string` | OS user |
| `organizationId` | `string` | Organization ID |
| `target` | `string` | Region |

#### State

| Property | Type | Description |
|----------|------|-------------|
| `state` | `SandboxState` | 'started' \| 'stopped' |
| `errorReason` | `string?` | Error message |
| `recoverable` | `boolean?` | Can recover from error |

#### Configuration

| Property | Type | Description |
|----------|------|-------------|
| `env` | `Record<string, string>` | Environment variables |
| `labels` | `Record<string, string>` | Custom metadata |
| `public` | `boolean` | Public accessibility |
| `networkBlockAll` | `boolean` | Block all network |
| `networkAllowList` | `string?` | Allowed CIDR addresses |

#### Lifecycle Automation

| Property | Type | Description |
|----------|------|-------------|
| `autoStopInterval` | `number?` | Idle timeout (minutes) |
| `autoArchiveInterval` | `number?` | Archive delay (days) |
| `autoDeleteInterval` | `number?` | Delete delay |

#### Tool Interfaces

| Property | Type | Description |
|----------|------|-------------|
| `fs` | `FileSystem` | File operations |
| `git` | `Git` | Version control |
| `process` | `Process` | Command execution |
| `codeInterpreter` | `CodeInterpreter` | Python code execution |
| `computerUse` | `ComputerUse` | Desktop automation |

### Methods

#### Lifecycle

```typescript
// Start/Stop
await sandbox.start(timeout?: number)
await sandbox.stop(timeout?: number)
await sandbox.delete(timeout: number)
await sandbox.archive()
await sandbox.recover(timeout?: number)

// Wait for state
await sandbox.waitUntilStarted(timeout?: number)
await sandbox.waitUntilStopped(timeout?: number)
```

#### Automation

```typescript
await sandbox.setAutostopInterval(minutes: number)  // 0 = disable
await sandbox.setAutoArchiveInterval(days: number)  // 0 = max (30 days)
await sandbox.setAutoDeleteInterval(value: number)  // -1 = disable, 0 = immediate
```

#### Directory Access

```typescript
const homeDir = await sandbox.getUserHomeDir()  // e.g., "/home/daytona"
const workDir = await sandbox.getWorkDir()      // WORKDIR or home
```

#### Metadata

```typescript
await sandbox.setLabels({ key: 'value' })
await sandbox.refreshData()      // Sync with API
await sandbox.refreshActivity()  // Reset idle timer
```

#### Network/Preview

```typescript
const preview = await sandbox.getPreviewLink(port: number)
// Returns: { url: string, token?: string }

const signedUrl = await sandbox.getSignedPreviewUrl(port, expiresInSeconds?)
await sandbox.expireSignedPreviewUrl(port, token)
```

#### SSH Access

```typescript
const ssh = await sandbox.createSshAccess(expiresInMinutes?: number)
const valid = await sandbox.validateSshAccess(token: string)
await sandbox.revokeSshAccess(token: string)
```

#### LSP (Language Server)

```typescript
const lsp = await sandbox.createLspServer(
  languageId: string,      // e.g., "typescript"
  pathToProject: string    // relative to workdir
)
```

---

## Process & Code Execution

### Code Execution (Stateless)

Executes code with a fresh interpreter each time.

```typescript
const response = await sandbox.process.codeRun(
  code: string,
  params?: { argv?: string[], env?: Record<string, string> },
  timeout?: number  // seconds (0 = indefinite)
)
// Returns ExecuteResponse:
// {
//   result: string,           // stdout content
//   exitCode: number,
//   artifacts: {
//     stdout: string,         // same as result
//     charts: ChartMetadata[] // matplotlib charts if any
//   }
// }
```

Supports: Python, TypeScript, JavaScript (based on sandbox language).

### Command Execution

```typescript
const response = await sandbox.process.executeCommand(
  command: string,
  cwd?: string,
  env?: Record<string, string>,
  timeout?: number  // seconds (0 = indefinite)
)
// Returns ExecuteResponse:
// {
//   result: string,    // stdout content
//   exitCode: number,
//   artifacts: { stdout: string, charts: ChartMetadata[] }
// }
```

**Note**: Daytona uses `result` for stdout, not separate `stdout`/`stderr` fields on the main response. Use `artifacts.stdout` for explicit access.

### Sessions (Background Processes)

Long-running processes with persistent state.

```typescript
// Create session
await sandbox.process.createSession(sessionId: string)

// Execute in session
const response = await sandbox.process.executeSessionCommand(
  sessionId: string,
  req: SessionExecuteRequest,
  timeout?: number
)
// Returns: { cmdId, exitCode?, output?, stdout?, stderr? }

// Get session info
const session = await sandbox.process.getSession(sessionId: string)
// Returns: { id, commands: Command[], sessionId }

// List all sessions
const sessions = await sandbox.process.listSessions()

// Get command logs (synchronous - returns snapshot)
const logs = await sandbox.process.getSessionCommandLogs(
  sessionId: string,
  commandId: string
)
// Returns: { output?, stdout?, stderr? }

// Delete session
await sandbox.process.deleteSession(sessionId: string)
```

### Streaming Logs (Critical for Evolve Integration)

**IMPORTANT**: Unlike E2B, Daytona does NOT support `onStdout`/`onStderr` callbacks directly on `executeCommand()`. For streaming, you MUST use Sessions:

```typescript
// 1. Create a session
await sandbox.process.createSession('my-session')

// 2. Execute command in session (returns cmdId)
const response = await sandbox.process.executeSessionCommand('my-session', {
  command: 'npm install',
  // async: true  // for background execution
})
const cmdId = response.cmdId

// 3. Stream logs with callbacks (async method)
const logsTask = sandbox.process.getSessionCommandLogs(
  'my-session',
  cmdId,
  (stdout) => console.log('[STDOUT]:', stdout),  // onStdout callback
  (stderr) => console.log('[STDERR]:', stderr)   // onStderr callback
)

// Continue other work while streaming...

// 4. Wait for streaming to complete
await logsTask

// 5. Clean up
await sandbox.process.deleteSession('my-session')
```

**Two approaches**:
1. **Asynchronous streaming**: Use `getSessionCommandLogs(sessionId, cmdId, onStdout, onStderr)` - returns Promise that resolves when complete
2. **Synchronous snapshot**: Use `getSessionCommandLogs(sessionId, cmdId)` without callbacks - returns `{ stdout, stderr, output }`

**Implication for Evolve**: The `SandboxCommands.run()` implementation will need to:
1. For non-streaming calls: Use `executeCommand()` directly
2. For streaming calls: Create ephemeral session → execute → stream logs → delete session

### PTY (Pseudo-Terminal)

Interactive terminal sessions.

```typescript
// Create PTY
const pty = await sandbox.process.createPty({
  cols?: number,
  rows?: number,
  cwd?: string,
  env?: Record<string, string>
})

// Connect to existing
const pty = await sandbox.process.connectPty(sessionId: string, options?)

// List PTY sessions
const sessions = await sandbox.process.listPtySessions()

// Resize
await sandbox.process.resizePtySession(sessionId, cols, rows)

// Kill
await sandbox.process.killPtySession(sessionId: string)
```

---

## FileSystem Operations

Access via `sandbox.fs`. Paths default to home directory; use `/` prefix for absolute.

### List Files

```typescript
const files = await sandbox.fs.listFiles(path: string)
// Returns: Array<{ name, isDir, size, modTime }>
```

### Create Directory

```typescript
await sandbox.fs.createFolder(path: string, permissions?: string)
```

### Upload Files

```typescript
// Single file
await sandbox.fs.uploadFile(content: Buffer | string, destination: string)

// Multiple files
await sandbox.fs.uploadFiles([
  { content: Buffer, destination: string },
  // ...
])
```

### Download Files

```typescript
// Single file
const buffer = await sandbox.fs.downloadFile(source: string)
// Returns: Buffer

// Multiple files
const files = await sandbox.fs.downloadFiles([
  { source: string },
  // ...
])
```

### Delete Files

```typescript
await sandbox.fs.deleteFile(path: string, recursive?: boolean)
```

### Move/Rename Files

```typescript
await sandbox.fs.moveFiles(source: string, destination: string)
// Works as rename - move file/dir to new path
```

### File Permissions

```typescript
// Get file info
const info = await sandbox.fs.getFileDetails(path: string)

// Set permissions
await sandbox.fs.setFilePermissions(path: string, { mode: string })
```

### Search & Replace

```typescript
// Search
const matches = await sandbox.fs.findFiles({
  path: string,
  pattern: string
})

// Replace
await sandbox.fs.replaceInFiles(
  files: string[],
  pattern: string,
  newValue: string
)
```

### NOT Available in Daytona FileSystem

These E2B features have no Daytona equivalent:

| E2B Method | Daytona Status | Workaround |
|------------|----------------|------------|
| `exists(path)` | ❌ Not available | Parse `listFiles()` parent directory |
| `readStream(path)` | ❌ Not available | Use `downloadFile()` with local path |
| `writeStream(path, stream)` | ❌ Not available | Use `uploadFile()` with local path |
| `uploadUrl(path)` | ❌ Not available | Use `uploadFile()` directly |
| `downloadUrl(path)` | ❌ Not available | Use `downloadFile()` directly |
| `watchDir(path, cb)` | ❌ Not available | Polling with `listFiles()` |

**Note on Streaming**: Daytona's `uploadFile(localPath, remotePath)` and `downloadFile(remotePath, localPath)` use file-path-based streaming internally for large files. This is different from E2B's `ReadableStream`-based API which works with in-memory streams.

---

## Snapshots

Pre-configured sandbox images for fast creation.

### Create Snapshot

```typescript
const snapshot = await daytona.snapshot.create(
  params: {
    name: string,
    image: string | Image,  // Base image or Image builder
    entrypoint?: string[],
    regionId?: string,
    resources?: ResourceConfig
  },
  options: {
    onLogs?: (log: string) => void,
    timeout?: number  // 0 = no timeout
  }
)
```

### List Snapshots

```typescript
const result = await daytona.snapshot.list(page?: number, limit?: number)
// Returns: { items: Snapshot[], page, total, totalPages }
```

### Get Snapshot

```typescript
const snapshot = await daytona.snapshot.get(name: string)
```

### Delete Snapshot

```typescript
await daytona.snapshot.delete(snapshot: Snapshot)
```

### Activate Snapshot

```typescript
const activated = await daytona.snapshot.activate(snapshot: Snapshot)
```

---

## Volumes

Persistent shared storage mountable to sandboxes.

### Create Volume

```typescript
const volume = await daytona.volume.create(name: string)
```

### Get Volume

```typescript
const volume = await daytona.volume.get(
  name: string,
  create?: boolean  // Create if doesn't exist
)
```

### List Volumes

```typescript
const volumes = await daytona.volume.list()
```

### Delete Volume

```typescript
await daytona.volume.delete(volume: Volume)
```

### Mount to Sandbox

Volumes are mounted during sandbox creation via the `volumes` parameter.

---

## Images

Declarative image builder (similar to Dockerfile).

### Factory Methods

```typescript
// From existing base
const image = Image.base('python:3.12-slim-bookworm')

// Debian slim with Python
const image = Image.debianSlim('3.12')  // Supports 3.9-3.13

// From Dockerfile
const image = Image.fromDockerfile('./Dockerfile')
```

### Configuration Methods

All methods return `Image` for chaining:

```typescript
image
  .workdir('/app')
  .env({ NODE_ENV: 'production' })
  .cmd(['node', 'server.js'])
  .entrypoint(['npm', 'start'])
  .runCommands('apt-get update', 'apt-get install -y curl')
  .addLocalFile('./config.json', '/app/config.json')
  .addLocalDir('./src', '/app/src')
  .pipInstall(['numpy', 'pandas'], { indexUrl: '...', pre: true })
  .pipInstallFromRequirements('./requirements.txt')
  .pipInstallFromPyproject('./pyproject.toml', { groups: ['dev'] })
  .dockerfileCommands(['RUN echo "custom"'], './context')
```

### User Management

No explicit `.setUser()` method - use `runCommands` to create users:

```typescript
const image = Image.debianSlim('3.12').runCommands(
  'groupadd -r daytona && useradd -r -g daytona -m daytona',
  'mkdir -p /home/daytona/workspace'
)
```

### Creating Snapshots (Pre-built Images)

```typescript
// Build the image
const image = Image.debianSlim('3.12')
  .pipInstall(['pandas', 'numpy'])
  .workdir('/home/daytona')

// Create and register the snapshot
await daytona.snapshot.create(
  {
    name: 'data-science-snapshot',
    image,
  },
  {
    onLogs: console.log,  // Stream build logs
  }
)

// Use the snapshot
const sandbox = await daytona.create({
  snapshot: 'data-science-snapshot',
})
```

### Evolve-All Equivalent Example

Full example matching the E2B `evolve-all` template:

```typescript
import { Daytona, Image } from '@daytonaio/sdk'

const daytona = new Daytona()

const evolveImage = Image.base('ubuntu:22.04')
  // System packages
  .runCommands(
    'apt-get update && apt-get install -y curl git ripgrep wget gnupg nodejs npm',
    // Google Chrome
    'wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome-keyring.gpg',
    'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list',
    'apt-get update && apt-get install -y google-chrome-stable',
    // UV package manager
    'curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh'
  )
  // AI Coding CLIs
  .runCommands(
    'npm install -g @anthropic-ai/claude-code@latest @openai/codex @google/gemini-cli@latest @qwen-code/qwen-code@latest',
    'npm install -g @zed-industries/claude-code-acp@latest @zed-industries/codex-acp@latest',
    'npm install -g mcp-remote'
  )
  // User setup
  .runCommands(
    'groupadd -r user && useradd -r -g user -m user',
    'mkdir -p /home/user/.evolve/skills /home/user/.claude/skills /home/user/.codex/skills /home/user/.gemini/skills /home/user/.qwen/skills'
  )
  .workdir('/home/user')
  // Skills
  .runCommands(
    'git clone --depth 1 --filter=blob:none --sparse https://github.com/evolving-machines-lab/evolve.git /tmp/evolve && cd /tmp/evolve && git sparse-checkout set skills && mv skills/* /home/user/.evolve/skills/ && rm -rf /tmp/evolve'
  )
  // Gemini settings
  .runCommands(
    'echo \'{"experimental":{"skills":true}}\' > /home/user/.gemini/settings.json',
    'echo y | gemini extensions install https://github.com/gemini-cli-extensions/nanobanana'
  )
  // Browser automation
  .runCommands('npx playwright install chromium')

// Register snapshot
await daytona.snapshot.create(
  { name: 'evolve-all', image: evolveImage },
  { onLogs: console.log }
)
```

---

## Git Operations

Access via `sandbox.git`.

### Clone

```typescript
await sandbox.git.clone(
  url: string,
  path: string,
  branch?: string,
  auth?: { username: string, password: string }  // For private repos
)
```

### Status & Branches

```typescript
const status = await sandbox.git.status(path: string)
// Returns: { branch, ahead, behind, files }

const branches = await sandbox.git.branches(path: string)
```

### Branch Management

```typescript
await sandbox.git.createBranch(path: string, branch: string)
await sandbox.git.checkoutBranch(path: string, branch: string)
await sandbox.git.deleteBranch(path: string, branch: string)
```

### Staging & Committing

```typescript
await sandbox.git.add(path: string, files: string[])  // Use ['.'] for all
await sandbox.git.commit(path: string, message: string, author: string, email: string)
```

### Remote Operations

```typescript
await sandbox.git.push(path: string)
await sandbox.git.pull(path: string)
```

---

## Daytona vs E2B Comparison

| Aspect | Daytona | E2B |
|--------|---------|-----|
| **Startup** | ~200ms | Sub-200ms |
| **Isolation** | OCI/Docker (default), VMs optional | Firecracker microVMs |
| **Session length** | Not specified | Up to 24 hours |
| **Deployment** | Cloud, self-hosted | Cloud, BYOC, on-premises |
| **License** | AGPL-3.0 | Apache-2.0 |
| **GitHub stars** | ~50K | ~10K |
| **Pricing** | $0.067/hr (1 vCPU, 1GB) | $150/mo Pro, $100 free credit |
| **Free tier** | $200 credits | $100 credits |

### Key Differences

1. **Templates vs Snapshots**: E2B uses `templateId`, Daytona uses `snapshot` name or `Image` builder
2. **Resource model**: E2B templates are pre-built; Daytona can build images on-demand
3. **Sessions**: E2B has simpler process model; Daytona has explicit Session management
4. **Volumes**: Daytona has first-class Volume support; E2B uses template-based persistence
5. **LSP**: Daytona has built-in Language Server Protocol support

---

## API Mapping to Evolve Interfaces

### SandboxProvider Interface

| Evolve Interface | Daytona Equivalent |
|------------------|-------------------|
| `providerType` | `"daytona"` |
| `create(options)` | `daytona.create(params)` |
| `connect(sandboxId)` | `daytona.get(sandboxId)` |
| `list(options)` | `daytona.list(labels, page, limit)` |

### SandboxInstance Interface

| Evolve Interface | Daytona Equivalent |
|------------------|-------------------|
| `sandboxId` | `sandbox.id` |
| `commands` | `sandbox.process` (wrapped) |
| `files` | `sandbox.fs` (wrapped) |
| `getHost(port)` | `sandbox.getPreviewLink(port).url` |
| `kill()` | `sandbox.delete()` |
| `pause()` | `sandbox.stop()` + `sandbox.archive()` |
| `isRunning()` | `sandbox.state === 'started'` |
| `getInfo()` | `sandbox` properties |

### SandboxCommands Interface

| Evolve Interface | Daytona Equivalent | Notes |
|------------------|-------------------|-------|
| `run(cmd, opts)` | `executeCommand()` (no streaming) OR session-based (with streaming) | See streaming section |
| `spawn(cmd, opts)` | `createSession()` + `executeSessionCommand({ async: true })` | Returns session ID, not PID |
| `list()` | `listSessions()` | Returns sessions, not processes |
| `connect(pid)` | N/A | Daytona uses session IDs, not PIDs |
| `sendStdin(pid, data)` | PTY only: `createPty()` + `pty.write(data)` | No direct stdin to commands |
| `kill(pid)` | `deleteSession(sessionId)` or `killPtySession(sessionId)` | Different identifier model |

**Critical Difference**: E2B uses numeric PIDs for process identification; Daytona uses string session IDs. The `SandboxCommandHandle.pid` field will need to store a synthetic ID that maps to Daytona session IDs internally.

### SandboxFiles Interface

| Evolve Interface | Daytona Equivalent | Status |
|------------------|-------------------|--------|
| `read(path)` | `downloadFile(remotePath)` | ✅ Returns `Buffer` |
| `write(path, content)` | `uploadFile(buffer, remotePath)` | ✅ |
| `writeBatch(files)` | `uploadFiles(files)` | ✅ |
| `makeDir(path)` | `createFolder(path, mode)` | ✅ |
| `exists(path)` | N/A | ❌ Parse `listFiles()` |
| `list(path)` | `listFiles(path)` | ✅ Returns `FileInfo[]` |
| `remove(path)` | `deleteFile(path, recursive?)` | ✅ |
| `rename(old, new)` | `moveFiles(source, destination)` | ✅ **Available** |
| `readStream(path)` | N/A | ❌ Use file-path download |
| `writeStream(path, stream)` | N/A | ❌ Use file-path upload |
| `uploadUrl(path)` | N/A | ❌ No pre-signed URLs |
| `downloadUrl(path)` | N/A | ❌ No pre-signed URLs |
| `watchDir(path, cb)` | N/A | ❌ Polling workaround |

**Daytona Extra Methods** (not in E2B interface):
- `findFiles(path, pattern)` - search for files
- `searchFiles(path, pattern)` - search file contents
- `replaceInFiles(files, pattern, newValue)` - find & replace
- `getFileDetails(path)` - get file info with permissions
- `setFilePermissions(path, permissions)` - chmod equivalent

### SandboxCreateOptions

| Evolve Field | Daytona Equivalent |
|--------------|-------------------|
| `templateId` | `snapshot` name or `image` (Image builder) |
| `envs` | `envVars` |
| `metadata` | `labels` |
| `timeoutMs` | `timeout` (seconds, not ms) |
| `workingDirectory` | Built-in via `getWorkDir()` |

---

## Key Implementation Notes

1. **Resource Identifier**: Daytona uses `snapshot` names or `Image` objects instead of E2B's `templateId`. The Evolve SDK should abstract this as a generic "resource identifier" that each provider maps to its own concept.

2. **Process Model**: Daytona uses explicit Sessions for background processes (identified by string IDs), while E2B uses PIDs. The adapter needs to map between these models.

3. **Timeout Units**: Daytona uses seconds; E2B uses milliseconds. Conversion needed.

4. **Missing Features**: Daytona lacks:
   - `watchDir` for filesystem watching
   - Pre-signed upload/download URLs (`uploadUrl`, `downloadUrl`)
   - `exists()` method for checking file existence
   - Direct stdin to running process (use PTY with `sendInput()` instead)
   - `ReadableStream`-based streaming (has file-path-based streaming instead)

5. **Authentication**: Daytona uses `DAYTONA_API_KEY`; E2B uses `E2B_API_KEY`. The provider resolution logic should check for the appropriate env var.

6. **Streaming**: Daytona session logs support callbacks for stdout/stderr streaming, similar to E2B.

---

## Implementation Decisions Required

### 1. Resource Identifier Strategy

**Problem**: E2B uses `templateId`, Daytona uses `snapshot` names or `Image` builders.

**Options**:
- A) Keep `templateId` in interface, map to Daytona snapshot name
- B) Rename to generic `resourceId` in core SDK
- C) Move to provider-specific config (each provider defines its own)

**Recommendation**: Option C - cleanest separation of concerns.

### 2. Process ID vs Session ID

**Problem**: Evolve interfaces use numeric `pid`, Daytona uses string `sessionId`.

**Options**:
- A) Generate synthetic numeric IDs, maintain internal mapping
- B) Change interface to use `string` identifiers
- C) Use hash of session ID as numeric PID

**Recommendation**: Option A - maintains E2B compatibility, internal mapping is provider concern.

### 3. Streaming Callbacks

**Problem**: E2B supports `onStdout`/`onStderr` directly on `run()`, Daytona requires session-based streaming.

**Implementation**:
```typescript
async run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult> {
  if (options?.onStdout || options?.onStderr) {
    // Streaming path: use ephemeral session
    const sessionId = `run-${Date.now()}`
    await this.sandbox.process.createSession(sessionId)
    try {
      const resp = await this.sandbox.process.executeSessionCommand(sessionId, { command })
      await this.sandbox.process.getSessionCommandLogs(
        sessionId, resp.cmdId!,
        options.onStdout || (() => {}),
        options.onStderr || (() => {})
      )
      return { exitCode: resp.exitCode ?? 0, stdout: resp.stdout ?? '', stderr: resp.stderr ?? '' }
    } finally {
      await this.sandbox.process.deleteSession(sessionId)
    }
  } else {
    // Non-streaming path: direct executeCommand
    const resp = await this.sandbox.process.executeCommand(command, options?.cwd, options?.envs, options?.timeoutMs)
    return { exitCode: resp.exitCode ?? 0, stdout: resp.stdout ?? '', stderr: resp.stderr ?? '' }
  }
}
```

### 4. Feature Comparison (Evidence-Based)

| Feature | E2B | Daytona | Notes |
|---------|-----|---------|-------|
| `run()` with streaming callbacks | ✅ `onStdout`, `onStderr` | ❌ | Use sessions + `getSessionCommandLogs()` |
| `spawn()` background process | ✅ Returns PID | ✅ Returns session ID | Different identifier model |
| `connect(pid)` to process | ✅ | ❌ | Daytona uses session-based model |
| `sendStdin(pid, data)` | ✅ | ❌ | Use PTY `sendInput()` instead |
| `list()` processes | ✅ Returns PIDs | ✅ Returns sessions | Different data model |
| `kill(pid)` | ✅ | ✅ `deleteSession()` | Maps to session deletion |
| `read()` file | ✅ | ✅ `downloadFile()` | Returns Buffer |
| `write()` file | ✅ | ✅ `uploadFile()` | Accepts Buffer or path |
| `writeBatch()` | ✅ | ✅ `uploadFiles()` | ✅ |
| `readStream()` → ReadableStream | ✅ | ❌ | Daytona uses file-path streaming |
| `writeStream()` from ReadableStream | ✅ | ❌ | Daytona uses file-path streaming |
| `uploadUrl()` pre-signed | ✅ | ❌ | Use `uploadFile()` directly |
| `downloadUrl()` pre-signed | ✅ | ❌ | Use `downloadFile()` directly |
| `makeDir()` | ✅ | ✅ `createFolder()` | ✅ |
| `exists()` | ✅ | ❌ | Parse `listFiles()` parent |
| `list()` directory | ✅ | ✅ `listFiles()` | ✅ |
| `remove()` | ✅ | ✅ `deleteFile()` | ✅ |
| `rename()` | ✅ | ✅ `moveFiles()` | **Daytona HAS this** |
| `watchDir()` | ✅ | ❌ | Polling workaround |
| `getHost(port)` | ✅ | ✅ `getPreviewLink()` | Returns URL |
| `isRunning()` | ✅ | ✅ `state === 'started'` | Property check |
| `getInfo()` | ✅ | ✅ Sandbox properties | ✅ |
| `kill()` sandbox | ✅ | ✅ `delete()` | ✅ |
| `pause()` sandbox | ✅ | ✅ `stop()` / `archive()` | ✅ |

### 5. Timeout Units

- E2B: milliseconds
- Daytona: seconds

All timeout parameters need conversion in the adapter.

---

## Sources

- [TypeScript SDK Reference](https://www.daytona.io/docs/en/typescript-sdk/)
- [Getting Started Guide](https://www.daytona.io/docs/en/getting-started/)
- [Process & Code Execution](https://www.daytona.io/docs/en/process-code-execution/)
- [File System Operations](https://www.daytona.io/docs/en/file-system-operations/)
- [Git Operations](https://www.daytona.io/docs/en/git-operations/)
- [Daytona Class Docs](https://www.daytona.io/docs/en/typescript-sdk/daytona/)
- [Sandbox Class Docs](https://www.daytona.io/docs/en/typescript-sdk/sandbox/)
- [Process Class Docs](https://www.daytona.io/docs/en/typescript-sdk/process/)
- [Image Class Docs](https://www.daytona.io/docs/en/typescript-sdk/image/)
- [NPM Package](https://www.npmjs.com/package/@daytonaio/sdk)
- [GitHub Repository](https://github.com/daytonaio/sdk)
- [Daytona vs E2B Comparison](https://openalternative.co/compare/daytona/vs/e2b)
