# Modal Sandbox Reference for Evolve SDK

This document maps E2B provider features to Modal SDK equivalents for implementing a compatible `ModalProvider`.

## Overview

Modal sandboxes provide secure, isolated containers for running AI agents. Key differences from E2B:

| Feature | E2B | Modal |
|---------|-----|-------|
| File APIs | Native `files.read/write/writeBatch` | Shell workarounds (no native TS file API) |
| GPU Support | ❌ | ✅ T4, L4, A10, A100, L40S, H100, H200, B200 |
| File System API | Full-featured | Alpha (Python only via `sb.open()`) |
| Pause/Resume | ✅ `betaPause()` | ❌ Use filesystem snapshots instead |
| Max Timeout | Varies | 24 hours |

---

## Core API Reference (TypeScript/JavaScript)

### Creating a Client and App

```javascript
const modal = new ModalClient();

// Look up or create an app
const app = await modal.apps.fromName("my-app", {
  createIfMissing: true,
});
```

### Creating a Sandbox

```javascript
// Basic sandbox with default Debian image
const image = modal.images.fromRegistry("python:3.13-slim");
const sb = await modal.sandboxes.create(app, image);

// With timeout (max 24 hours)
const sb = await modal.sandboxes.create(app, image, {
  timeout: 10 * 60 * 1000, // 10 minutes in ms
});

// With idle timeout (auto-terminate on inactivity)
const sb = await modal.sandboxes.create(app, image, {
  idleTimeout: 5 * 60 * 1000, // 5 minutes
});

// With working directory
const sb = await modal.sandboxes.create(app, image, {
  workdir: "/repo",
});
```

### Connecting to Existing Sandbox

```javascript
// Get sandbox ID after creation
const sbId = sb.sandboxId;

// Later, reconnect to the same sandbox
const sb2 = await modal.sandboxes.fromId(sbId);
```

### Terminating a Sandbox

```javascript
await sb.terminate();
```

---

## Commands API

### Running Commands (Blocking)

```javascript
// Simple command
const p = await sb.exec(["echo", "hello"], { timeout: 3000 });
const stdout = await p.stdout.readText();
console.log(stdout); // "hello\n"

// Get exit code
const exitCode = await p.poll(); // Returns number | null (null if still running)
await p.wait(); // Wait for completion

// Python execution
const p = await sb.exec(["python", "-c", "print('hello')"], { timeout: 3000 });
```

### Streaming Output

```javascript
const p = await sb.exec(
  ["bash", "-c", "for i in {1..10}; do date +%T; sleep 0.5; done"],
  { timeout: 5000 }
);

// Stream stdout line by line
for await (const line of p.stdout) {
  process.stdout.write(line);
}
```

### Writing to stdin

```javascript
const p = await sb.exec(["bash", "-c", "while read line; do echo $line; done"]);
p.stdin.write("foo bar\n");
p.stdin.close(); // Signal EOF
await p.wait();
```

---

## File Operations (Shell Workarounds)

Modal's TypeScript SDK lacks native file APIs. Use shell commands instead.

### Reading Files

```javascript
// Read text file
const p = await sb.exec(["cat", "/path/to/file.txt"]);
const content = await p.stdout.readText();

// Read with base64 encoding (for binary safety)
const p = await sb.exec(["base64", "/path/to/file.bin"]);
const base64 = await p.stdout.readText();
const binary = Buffer.from(base64, 'base64');
```

### Writing Files

```javascript
// Write text file using heredoc
await sb.exec(["bash", "-c", `cat > /path/to/file.txt << 'EOF'
file content here
EOF`]);

// Write using echo (escape carefully)
await sb.exec(["bash", "-c", `echo -n 'content' > /path/to/file.txt`]);

// Write binary with base64
const base64 = Buffer.from(binaryData).toString('base64');
await sb.exec(["bash", "-c", `echo '${base64}' | base64 -d > /path/to/file.bin`]);
```

### Batch Upload via Tar Stream

For efficient multi-file upload, create a tar archive and extract in sandbox:

```javascript
import { pack } from 'tar-stream';

// Create tar archive from FileMap
async function createTarBuffer(files: Record<string, string | Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const tarPack = pack();

  for (const [path, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    tarPack.entry({ name: path }, data);
  }
  tarPack.finalize();

  for await (const chunk of tarPack) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Upload and extract
const tarBuffer = await createTarBuffer(files);
const base64Tar = tarBuffer.toString('base64');
await sb.exec([
  "bash", "-c",
  `echo '${base64Tar}' | base64 -d | tar -xf - -C /workspace`
]);
```

### Directory Operations

```javascript
// Create directory
await sb.exec(["mkdir", "-p", "/path/to/dir"]);

// List directory
const p = await sb.exec(["ls", "-la", "/path/to/dir"]);
const listing = await p.stdout.readText();

// Check if file exists
const p = await sb.exec(["test", "-f", "/path/to/file", "&&", "echo", "exists"]);
const exists = (await p.stdout.readText()).includes("exists");

// Remove file/directory
await sb.exec(["rm", "-rf", "/path/to/remove"]);

// Rename/move
await sb.exec(["mv", "/old/path", "/new/path"]);
```

---

## GPU Configuration

```javascript
// Create image with GPU support
const image = modal.images
  .fromRegistry("python:3.13-slim")
  .dockerfileCommands(["RUN pip install torch"]);

// Create sandbox with GPU
const sb = await modal.sandboxes.create(app, image, {
  gpu: "A100",        // T4, L4, A10, A100, L40S, H100, H200, B200
  // gpu: "H100:8",   // Multiple GPUs
});
```

Available GPU types:
- `T4` - Entry-level inference
- `L4` - Cost-effective inference
- `A10` - Up to 4 GPUs (96 GB total)
- `A100` / `A100-40GB` / `A100-80GB` - Training/inference
- `L40S` - Recommended for inference (48 GB)
- `H100` / `H200` - High-performance (up to 8 GPUs)
- `B200` - Latest Blackwell architecture

---

## Environment Variables and Secrets

```javascript
// Create inline secret
const secret = modal.secrets.fromObject({
  MY_SECRET: "hello",
  API_KEY: process.env.API_KEY,
});

// Create sandbox with secrets
const sb = await modal.sandboxes.create(app, image, {
  secrets: [secret],
});

// Access in commands
const p = await sb.exec(["bash", "-c", "echo $MY_SECRET"]);
```

---

## Custom Images

```javascript
// From registry
const image = modal.images.fromRegistry("python:3.13-slim");

// With pip packages
const image = modal.images
  .fromRegistry("python:3.13-slim")
  .dockerfileCommands([
    "RUN pip install pandas numpy torch",
    "RUN apt-get update && apt-get install -y git",
  ]);

// Add local files to image (at build time)
// Note: TypeScript SDK may have limited support for this
```

---

## Volumes (Persistent Storage)

```javascript
// Create/get named volume
const volume = modal.volumes.fromName("my-volume");

// Attach to sandbox
const sb = await modal.sandboxes.create(app, image, {
  volumes: { "/data": volume },
});

// Files written to /data persist across sandbox restarts
```

---

## Networking (Tunnels / getHost)

```javascript
// Create sandbox with port forwarding
const sb = await modal.sandboxes.create(app, image, {
  entrypoint: ["python", "-m", "http.server", "8080"],
  encryptedPorts: [8080],  // or unencryptedPorts
});

// Get public URL for port
const tunnels = await sb.tunnels();
const url = tunnels[8080].url;  // https://xxxx.modal.run
```

For authenticated access:

```javascript
// Create connect token for secure HTTP/WebSocket access
const creds = await sb.createConnectToken({
  userMetadata: { userId: "foo" },
});

// Use in requests
fetch(creds.url, {
  headers: { Authorization: `Bearer ${creds.token}` },
});
```

---

## E2B to Modal Feature Mapping

### SandboxProvider Interface

| E2B Method | Modal Equivalent |
|------------|------------------|
| `create(options)` | `modal.sandboxes.create(app, image, options)` |
| `connect(sandboxId)` | `modal.sandboxes.fromId(sandboxId)` |
| `list(options)` | Not directly available (use App API) |

### SandboxInstance Interface

| E2B Method | Modal Equivalent |
|------------|------------------|
| `sandboxId` | `sb.sandboxId` |
| `commands` | `sb.exec()` |
| `files` | Shell commands (see above) |
| `getHost(port)` | `sb.tunnels()[port].url` |
| `isRunning()` | `sb.poll() !== null` or check status |
| `getInfo()` | Not directly available |
| `kill()` | `sb.terminate()` |
| `pause()` | Use filesystem snapshots |

### SandboxCommands Interface

| E2B Method | Modal Equivalent |
|------------|------------------|
| `run(cmd, opts)` | `sb.exec(cmd, { timeout }); await p.wait()` |
| `spawn(cmd, opts)` | `sb.exec(cmd, opts)` (returns handle) |
| `list()` | Not available |
| `connect(pid)` | Not available |
| `sendStdin(pid, data)` | `p.stdin.write(data)` |
| `kill(pid)` | Not available (terminate sandbox) |

### SandboxFiles Interface

| E2B Method | Modal Shell Workaround |
|------------|------------------------|
| `read(path)` | `sb.exec(["cat", path])` |
| `write(path, content)` | `sb.exec(["bash", "-c", "echo ... > path"])` |
| `writeBatch(files)` | Tar stream (see above) |
| `makeDir(path)` | `sb.exec(["mkdir", "-p", path])` |
| `exists(path)` | `sb.exec(["test", "-e", path])` |
| `list(path)` | `sb.exec(["ls", "-la", path])` |
| `remove(path)` | `sb.exec(["rm", "-rf", path])` |
| `rename(old, new)` | `sb.exec(["mv", old, new])` |
| `readStream(path)` | Not available |
| `writeStream(path, stream)` | Not available |
| `uploadUrl(path)` | Not available |
| `downloadUrl(path)` | Not available |
| `watchDir(path, cb)` | Not available |

---

## Filesystem Snapshots (Alternative to Pause)

Since Modal doesn't support pause/resume, use filesystem snapshots:

```javascript
// Create snapshot of current filesystem state
const snapshotImage = await sb.snapshotFilesystem();
await sb.terminate();

// Later, restore from snapshot
const sb2 = await modal.sandboxes.create(app, snapshotImage);
```

---

## Complete Example

```javascript
import ModalClient from 'modal';

async function runAgent() {
  const modal = new ModalClient();

  // Setup
  const app = await modal.apps.fromName("evolve-agent", { createIfMissing: true });
  const image = modal.images.fromRegistry("python:3.13-slim")
    .dockerfileCommands(["RUN pip install numpy"]);
  const secret = modal.secrets.fromObject({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  });

  // Create sandbox with GPU
  const sb = await modal.sandboxes.create(app, image, {
    timeout: 60 * 60 * 1000, // 1 hour
    gpu: "A100",
    secrets: [secret],
    workdir: "/workspace",
  });

  try {
    // Upload workspace files via tar
    const tarBase64 = createTarBase64(workspaceFiles);
    await sb.exec(["bash", "-c", `echo '${tarBase64}' | base64 -d | tar -xf - -C /workspace`]);

    // Run agent command
    const p = await sb.exec(
      ["claude", "--print", "--dangerously-skip-permissions", "-p", prompt],
      { timeout: 30 * 60 * 1000 }
    );

    // Stream output
    for await (const line of p.stdout) {
      console.log(line);
    }

    await p.wait();

    // Download results
    const result = await sb.exec(["cat", "/workspace/output.json"]);
    return await result.stdout.readText();

  } finally {
    await sb.terminate();
  }
}
```

---

## References

- [Modal Sandboxes Guide](https://modal.com/docs/guide/sandboxes)
- [Running Commands](https://modal.com/docs/guide/sandbox-spawn)
- [File Access](https://modal.com/docs/guide/sandbox-files)
- [Networking](https://modal.com/docs/guide/sandbox-networking)
- [GPU Acceleration](https://modal.com/docs/guide/gpu)
- [JavaScript/Go SDKs](https://modal.com/docs/guide/sdk-javascript-go)
- [API Reference](https://modal.com/docs/reference)
