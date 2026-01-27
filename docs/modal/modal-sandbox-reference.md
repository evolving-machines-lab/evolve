# Modal Sandbox Reference for Evolve SDK

TypeScript-focused reference for implementing `ModalProvider` based on actual SDK usage.

## SDK Feature Requirements

Features actually used by `packages/sdk-ts`:

| Feature | SDK Usage | Modal TS Support |
|---------|-----------|------------------|
| `provider.create()` | ✅ | ✅ `modal.sandboxes.create()` |
| `provider.connect(id)` | ✅ | ✅ `modal.sandboxes.fromId()` |
| `sandbox.sandboxId` | ✅ | ✅ `sb.sandboxId` |
| `commands.run()` | ✅ | ✅ `sb.exec()` + `p.wait()` |
| `commands.spawn()` | ✅ | ✅ `sb.exec()` (returns handle) |
| `run: cwd` | ✅ | ✅ `{ workdir: "/path" }` |
| `run: timeoutMs` | ✅ | ✅ `{ timeout: ms }` |
| `run: onStdout/onStderr` | ✅ | ✅ async iteration |
| `files.read()` | ✅ | ✅ `cat` via stdout (efficient) |
| `files.write()` | ✅ | ✅ `cat` via stdin (efficient) |
| `files.writeBatch()` | ✅ | ✅ `tar` via stdin (efficient) |
| `files.makeDir()` | ✅ | ✅ `mkdir -p` |
| `getHost(port)` | ✅ | ✅ `sb.tunnels()[port].url` |
| `kill()` | ✅ | ✅ `sb.terminate()` |
| `pause()` | ✅ | ❌ Not supported |

**Not used by SDK** (skip implementation):
- `commands.list()`, `commands.connect()`, `commands.sendStdin()`, `commands.kill()`
- `files.exists()`, `files.list()`, `files.remove()`, `files.rename()`, streaming, URLs, watchDir
- `isRunning()`, `getInfo()`, `provider.list()`

---

## TypeScript API Reference

### Installation

```bash
npm install modal
```

### Client Setup

```typescript
import { ModalClient } from "modal";

const modal = new ModalClient();

// Create or get an app (required for sandboxes)
const app = await modal.apps.fromName("evolve-app", {
  createIfMissing: true,
});
```

### Images (Public Docker - Simple Like E2B)

Modal automatically caches images from Docker Hub:
- **First use**: Pulls from registry (~30-60s depending on image size)
- **Subsequent uses**: Uses cached image (fast, ~seconds)

No pre-build or snapshot step required (unlike Daytona).

```typescript
// Any public Docker image works directly - Modal caches automatically
const image = modal.images.fromRegistry("python:3.13-slim");

// With customizations
const image = modal.images
  .fromRegistry("python:3.13-slim")
  .dockerfileCommands([
    "RUN pip install numpy pandas",
    "RUN apt-get update && apt-get install -y git curl",
  ]);

// Other registries
modal.images.fromRegistry("ubuntu:22.04");
modal.images.fromRegistry("node:20-alpine");
modal.images.fromRegistry("nvcr.io/nvidia/pytorch:24.01-py3");
```

### Creating a Sandbox

```typescript
const sb = await modal.sandboxes.create(app, image, {
  timeout: 60 * 60 * 1000,    // 1 hour max (up to 24h)
  workdir: "/workspace",
  secrets: [secret],
  volumes: { "/data": volume },
  gpu: "A100",                // Optional GPU
});

// Get sandbox ID for reconnection
const sandboxId = sb.sandboxId;
```

### Connecting to Existing Sandbox

```typescript
const sb = await modal.sandboxes.fromId(sandboxId);
```

### Terminating

```typescript
await sb.terminate();
```

---

## Commands API

### run() - Blocking Execution

```typescript
// Execute and wait for completion
const p = await sb.exec(["echo", "hello"], { timeout: 30000 });
await p.wait();

// Get output
const stdout = await p.stdout.readText();
const stderr = await p.stderr.readText();

// Exit code (after wait)
const exitCode = await p.wait(); // Returns exit code

// With working directory (cwd equivalent)
const p = await sb.exec(["python", "script.py"], {
  timeout: 60000,
  workdir: "/workspace",
});
await p.wait();
```

### spawn() - Background Execution

```typescript
// Start background process
const p = await sb.exec(["python", "server.py"], { timeout: 3600000 });

// Don't await - process runs in background
// Later, can check or wait:
const exitCode = await p.wait();
```

### Streaming Output

```typescript
const p = await sb.exec(["python", "script.py"], { timeout: 60000 });

// Stream stdout
for await (const line of p.stdout) {
  process.stdout.write(line);
}
```

### stdin

```typescript
const p = await sb.exec(["bash", "-c", "while read line; do echo $line; done"]);
p.stdin.write("hello\n");
p.stdin.write_eof(); // Signal EOF
await p.wait();
```

---

## File Operations (Via stdin/stdout - Efficient)

Modal TS SDK has no native file APIs. Use `sb.exec()` with stdin/stdout piping for efficient binary-safe transfers.

### files.read()

```typescript
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".tar", ".gz",
  ".exe", ".bin", ".pkl", ".parquet", ".sqlite", ".db"
]);

function isBinaryFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

async function read(path: string): Promise<string | Uint8Array> {
  if (isBinaryFile(path)) {
    // Binary: use base64 encoding
    const p = await sb.exec(["base64", path], { timeout: 300000 });
    await p.wait();
    const b64 = await p.stdout.readText();
    return new Uint8Array(Buffer.from(b64.trim(), "base64"));
  }
  // Text: read directly
  const p = await sb.exec(["cat", path], { timeout: 300000 });
  await p.wait();
  return await p.stdout.readText();
}
```

### files.write() - Via Stdin (Efficient)

```typescript
async function write(
  path: string,
  content: string | Buffer | Uint8Array
): Promise<void> {
  const data = typeof content === "string"
    ? Buffer.from(content, "utf-8")
    : Buffer.from(content);

  // Pipe directly via stdin - no escaping or base64 needed
  const p = await sb.exec(["bash", "-c", `cat > '${path}'`]);
  p.stdin.write(data);
  p.stdin.write_eof();
  await p.wait();
}
```

This matches E2B's efficiency - binary safe, no encoding overhead.

### files.writeBatch() - Tar via Stdin (Efficient)

E2B uses native `files.write(entries)` - single API call. For Modal, pipe tar via stdin (no base64 overhead):

```typescript
import { pack } from "tar-stream";

async function writeBatch(
  files: Array<{ path: string; data: string | Uint8Array }>
): Promise<void> {
  // Create tar archive
  const tarPack = pack();
  const chunks: Buffer[] = [];

  for (const file of files) {
    const data = typeof file.data === "string"
      ? Buffer.from(file.data)
      : Buffer.from(file.data);
    tarPack.entry({ name: file.path }, data);
  }
  tarPack.finalize();

  for await (const chunk of tarPack) {
    chunks.push(chunk);
  }
  const tarBuffer = Buffer.concat(chunks);

  // Pipe tar directly via stdin (no base64 overhead)
  const p = await sb.exec(["tar", "-xf", "-", "-C", "/"]);
  p.stdin.write(tarBuffer);
  p.stdin.write_eof();
  await p.wait();
}
```

**Efficiency comparison:**
| Method | E2B | Modal (base64) | Modal (stdin) |
|--------|-----|----------------|---------------|
| API calls | 1 native | 1 exec | 1 exec |
| Size overhead | 0% | +33% base64 | 0% |
| Binary safe | ✅ | ✅ | ✅ |

### files.makeDir()

```typescript
async function makeDir(path: string): Promise<void> {
  await sb.exec(["mkdir", "-p", path], { timeout: 10000 });
}
```

---

## Networking (getHost)

```typescript
// Create sandbox with port forwarding
const sb = await modal.sandboxes.create(app, image, {
  encryptedPorts: [8080],
});

// Start a server
await sb.exec(["python", "-m", "http.server", "8080"]);

// Get public URL
const tunnels = await sb.tunnels();
const url = tunnels[8080].url;  // https://xxx.modal.run
```

---

## GPU Support

```typescript
const sb = await modal.sandboxes.create(app, image, {
  gpu: "A100",      // Single GPU
  // gpu: "H100:4", // Multiple GPUs
});
```

Available: `T4`, `L4`, `A10`, `A100`, `A100-40GB`, `A100-80GB`, `L40S`, `H100`, `H200`, `B200`

---

## Environment Variables / Secrets

```typescript
const secret = modal.secrets.fromObject({
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  MY_VAR: "value",
});

const sb = await modal.sandboxes.create(app, image, {
  secrets: [secret],
});
```

---

## Volumes (Persistent Storage)

```typescript
const volume = await modal.volumes.fromName("my-volume", {
  createIfMissing: true,
});

const sb = await modal.sandboxes.create(app, image, {
  volumes: { "/data": volume },
});
```

---

## pause() - Not Supported

Modal doesn't support pause/resume. Options:

1. **Throw error** (recommended for now):
```typescript
async pause(): Promise<void> {
  throw new Error("Modal does not support pause. Use kill() instead.");
}
```

2. **Future: Filesystem snapshots** (Python-only currently):
```python
# Python only - not available in TS SDK yet
image = sb.snapshot_filesystem()
sb.terminate()
# Later: modal.Sandbox.create(image=image, app=app)
```

---

## Complete ModalProvider Implementation Outline

```typescript
import { ModalClient } from "modal";

class ModalProvider implements SandboxProvider {
  readonly providerType = "modal";
  private modal: ModalClient;
  private app: App;

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    const image = this.modal.images.fromRegistry(options.image);
    const secret = options.envs
      ? this.modal.secrets.fromObject(options.envs)
      : undefined;

    const sb = await this.modal.sandboxes.create(this.app, image, {
      timeout: options.timeoutMs,
      workdir: options.workingDirectory,
      secrets: secret ? [secret] : undefined,
    });

    return new ModalSandboxInstance(sb);
  }

  async connect(sandboxId: string): Promise<SandboxInstance> {
    const sb = await this.modal.sandboxes.fromId(sandboxId);
    return new ModalSandboxInstance(sb);
  }
}

class ModalSandboxInstance implements SandboxInstance {
  readonly commands: ModalCommands;
  readonly files: ModalFiles;

  get sandboxId(): string {
    return this.sb.sandboxId;
  }

  async getHost(port: number): Promise<string> {
    const tunnels = await this.sb.tunnels();
    return tunnels[port].url;
  }

  async kill(): Promise<void> {
    await this.sb.terminate();
  }

  async pause(): Promise<void> {
    throw new Error("Modal does not support pause");
  }
}
```

---

## Image Caching

Modal automatically caches images after first use. You can also eagerly pre-build images using the `.build(app)` method:

```typescript
// Option 1: Lazy caching (image pulled on first sandbox creation)
const image = modal.images.fromRegistry("evolvingmachines/evolve-all:latest");
const sb = await modal.sandboxes.create(app, image, { ... }); // First call is slow

// Option 2: Eager pre-build (recommended for setup)
const image = await modal.images.fromRegistry("evolvingmachines/evolve-all:latest").build(app);
console.log(`Image ID: ${image.imageId}`); // Image is now cached
const sb = await modal.sandboxes.create(app, image, { ... }); // Fast!
```

The `.build(app)` method eagerly pulls and caches the image, so subsequent sandbox creations are fast.

**Comparison:**
| Provider | First Use | Subsequent Uses | Pre-build Method |
|----------|-----------|-----------------|------------------|
| E2B | Template build | Instant | `e2b template build` |
| Daytona | Snapshot build | Instant | Build script |
| Modal | Pull from registry | Cached | `image.build(app)` |

For even faster pulls, Modal supports [estargz compression](https://modal.com/docs/guide/fast-pull-from-registry) which downloads layers on-demand.

---

## References

- [Modal JS SDK (npm)](https://www.npmjs.org/package/modal)
- [Modal JS API Reference](https://modal-labs.github.io/libmodal/)
- [Modal Sandboxes Guide](https://modal.com/docs/guide/sandboxes)
- [Running Commands](https://modal.com/docs/guide/sandbox-spawn)
- [GPU Acceleration](https://modal.com/docs/guide/gpu)
