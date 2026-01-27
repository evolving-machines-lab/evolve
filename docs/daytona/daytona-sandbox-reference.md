# Daytona Sandbox Reference for Evolve SDK

This document provides the Daytona SDK reference for the `DaytonaProvider` implementation.

## Overview

Daytona provides cloud development environments with native file APIs and session-based command execution.

| Feature | E2B | Daytona |
|---------|-----|---------|
| File APIs | Native | Native (`fs.uploadFile`, `fs.downloadFile`) |
| Batch Upload | `writeBatch()` | `fs.uploadFiles()` |
| GPU Support | ❌ | ❌ |
| Pause/Resume | `betaPause()` | `stop()` / snapshots |
| Sessions | ❌ | ✅ Process sessions |
| Resource Config | ❌ | ✅ CPU/Memory/Disk |

---

## Core API Reference (TypeScript)

### Creating a Client

```typescript
import { Daytona } from "@daytonaio/sdk";

const client = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
  apiUrl: "https://app.daytona.io/api", // optional
  target: "us", // optional region
});
```

### Creating a Sandbox

```typescript
// From Docker image
const sandbox = await client.create({
  image: "evolvingmachines/evolve-all:latest",
  envVars: { MY_VAR: "value" },
  labels: { purpose: "testing" },
  autoStopInterval: 0, // never auto-stop
  resources: {
    cpu: 4,      // CPU cores
    memory: 4,   // GB
    disk: 10,    // GB
  },
}, {
  timeout: 3600, // seconds
  onSnapshotCreateLogs: (log) => console.log(log),
});

// From existing snapshot (faster)
const sandbox = await client.create({
  snapshot: "my-snapshot-name",
  envVars: { MY_VAR: "value" },
  labels: { purpose: "testing" },
  autoStopInterval: 0,
}, {
  timeout: 3600,
});
```

### Connecting to Existing Sandbox

```typescript
// Get sandbox by ID
const sandbox = await client.get(sandboxId);
```

### Listing Sandboxes

```typescript
// List with filters
const result = await client.list(
  { purpose: "testing" }, // labels filter
  1,    // page
  100   // limit
);

for (const sandbox of result.items) {
  console.log(sandbox.id, sandbox.state);
}
```

### Sandbox Lifecycle

```typescript
// Get sandbox state
console.log(sandbox.state); // "started" | "stopped" | "starting" | "stopping" | "unknown"

// Stop sandbox (preserves state)
await sandbox.stop();

// Start stopped sandbox
await sandbox.start();

// Delete sandbox
await sandbox.delete();
```

---

## Commands API

Daytona uses session-based command execution.

### Running Commands (Blocking)

```typescript
// Simple command execution
const result = await sandbox.process.executeCommand(
  "echo hello",   // command
  "/workspace",   // cwd (optional)
  { MY_VAR: "x" }, // env (optional)
  60              // timeout in seconds (optional)
);

console.log(result.exitCode);
console.log(result.result); // stdout
```

### Session-Based Commands

```typescript
// Create a session for command execution
const sessionId = `session-${Date.now()}`;
await sandbox.process.createSession(sessionId);

// Execute command in session (sync)
const resp = await sandbox.process.executeSessionCommand(sessionId, {
  command: "python script.py",
  runAsync: false, // wait for completion
}, 60); // timeout in seconds

console.log(resp.exitCode);
console.log(resp.stdout);
console.log(resp.stderr);

// Delete session when done
await sandbox.process.deleteSession(sessionId);
```

### Background Commands (Async)

```typescript
// Execute command asynchronously
const resp = await sandbox.process.executeSessionCommand(sessionId, {
  command: "python long_running.py",
  runAsync: true,
});

const cmdId = resp.cmdId;

// Poll for completion
while (true) {
  const cmd = await sandbox.process.getSessionCommand(sessionId, cmdId);
  if (cmd.exitCode !== undefined) {
    console.log("Completed with exit code:", cmd.exitCode);
    break;
  }
  await new Promise(r => setTimeout(r, 500));
}
```

### Streaming Output

```typescript
// Stream command logs
await sandbox.process.getSessionCommandLogs(
  sessionId,
  cmdId,
  (stdout) => process.stdout.write(stdout), // onStdout
  (stderr) => process.stderr.write(stderr)  // onStderr
);
```

### List Sessions

```typescript
const sessions = await sandbox.process.listSessions();
for (const session of sessions) {
  console.log(session.sessionId);
}
```

---

## File Operations

Daytona has native file APIs (unlike Modal).

### Reading Files

```typescript
// Download file as Buffer
const buffer = await sandbox.fs.downloadFile("/path/to/file.txt");
const content = buffer.toString("utf-8");

// For binary files
const binaryBuffer = await sandbox.fs.downloadFile("/path/to/image.png");
const uint8Array = new Uint8Array(binaryBuffer);
```

### Writing Files

```typescript
// Upload single file
const content = Buffer.from("file content", "utf-8");
await sandbox.fs.uploadFile(content, "/path/to/file.txt");

// Upload with timeout
await sandbox.fs.uploadFile(content, "/path/to/file.txt", 60);
```

### Batch Upload

```typescript
// Upload multiple files at once
await sandbox.fs.uploadFiles([
  { source: Buffer.from("content1"), destination: "/path/file1.txt" },
  { source: Buffer.from("content2"), destination: "/path/file2.txt" },
  { source: binaryBuffer, destination: "/path/image.png" },
]);
```

### Directory Operations

```typescript
// Create directory
await sandbox.fs.createFolder("/path/to/dir", "755");

// List directory
const files = await sandbox.fs.listFiles("/path/to/dir");
for (const file of files) {
  console.log(file.name, file.isDir ? "dir" : "file", file.size);
}

// Delete file or directory
await sandbox.fs.deleteFile("/path/to/file.txt", false); // not recursive
await sandbox.fs.deleteFile("/path/to/dir", true);       // recursive

// Move/rename
await sandbox.fs.moveFiles("/old/path", "/new/path");
```

---

## Networking

### Get Preview URL

```typescript
// Get public URL for a port
const preview = await sandbox.getPreviewLink(8080);
console.log(preview.url);   // https://xxx.daytona.app
console.log(preview.token); // optional auth token
```

---

## Snapshots

Daytona supports saving sandbox state as snapshots for fast restarts.

```typescript
// Get existing snapshot
const snapshot = await client.snapshot.get("my-snapshot");
console.log(snapshot.state); // "active" | "pending" | etc.

// Create sandbox from snapshot
const sandbox = await client.create({
  snapshot: "my-snapshot",
});
```

---

## E2B to Daytona Feature Mapping

### SandboxProvider Interface

| E2B Method | Daytona Equivalent |
|------------|-------------------|
| `create(options)` | `client.create({ image, envVars, resources })` |
| `connect(sandboxId)` | `client.get(sandboxId)` |
| `list(options)` | `client.list(labels, page, limit)` |

### SandboxInstance Interface

| E2B Method | Daytona Equivalent |
|------------|-------------------|
| `sandboxId` | `sandbox.id` |
| `commands` | `sandbox.process.*` |
| `files` | `sandbox.fs.*` |
| `getHost(port)` | `sandbox.getPreviewLink(port).url` |
| `isRunning()` | `sandbox.state === "started"` |
| `getInfo()` | `sandbox.id`, `sandbox.name`, `sandbox.labels` |
| `kill()` | `sandbox.delete()` |
| `pause()` | `sandbox.stop()` |

### SandboxCommands Interface

| E2B Method | Daytona Equivalent |
|------------|-------------------|
| `run(cmd, opts)` | `sandbox.process.executeCommand(cmd, cwd, env, timeout)` |
| `spawn(cmd, opts)` | `sandbox.process.executeSessionCommand(id, { command, runAsync: true })` |
| `list()` | `sandbox.process.listSessions()` |
| `connect(pid)` | N/A (use getSessionCommand) |
| `sendStdin(pid, data)` | N/A |
| `kill(pid)` | `sandbox.process.deleteSession(sessionId)` |

### SandboxFiles Interface

| E2B Method | Daytona Equivalent |
|------------|-------------------|
| `read(path)` | `sandbox.fs.downloadFile(path)` |
| `write(path, content)` | `sandbox.fs.uploadFile(buffer, path)` |
| `writeBatch(files)` | `sandbox.fs.uploadFiles([{ source, destination }])` |
| `makeDir(path)` | `sandbox.fs.createFolder(path, "755")` |
| `exists(path)` | List parent dir and check for name |
| `list(path)` | `sandbox.fs.listFiles(path)` |
| `remove(path)` | `sandbox.fs.deleteFile(path, recursive)` |
| `rename(old, new)` | `sandbox.fs.moveFiles(old, new)` |
| `readStream(path)` | N/A |
| `writeStream(path)` | N/A |
| `uploadUrl(path)` | N/A |
| `downloadUrl(path)` | N/A |
| `watchDir(path, cb)` | N/A |

---

## Complete Example

```typescript
import { Daytona } from "@daytonaio/sdk";

async function runAgent() {
  const client = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
  });

  // Create sandbox with resources
  const sandbox = await client.create({
    image: "evolvingmachines/evolve-all:latest",
    envVars: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
    resources: {
      cpu: 4,
      memory: 8,
      disk: 20,
    },
  }, {
    timeout: 3600,
  });

  try {
    // Upload workspace files
    await sandbox.fs.uploadFiles([
      { source: Buffer.from("# README"), destination: "/workspace/README.md" },
      { source: Buffer.from("print('hello')"), destination: "/workspace/main.py" },
    ]);

    // Create directory
    await sandbox.fs.createFolder("/workspace/output", "755");

    // Run agent command with streaming
    const sessionId = `agent-${Date.now()}`;
    await sandbox.process.createSession(sessionId);

    const resp = await sandbox.process.executeSessionCommand(sessionId, {
      command: "cd /workspace && python main.py",
      runAsync: false,
    }, 1800);

    console.log("Exit code:", resp.exitCode);
    console.log("Output:", resp.stdout);

    // Download results
    const output = await sandbox.fs.downloadFile("/workspace/output/result.txt");
    console.log("Result:", output.toString());

    await sandbox.process.deleteSession(sessionId);

  } finally {
    await sandbox.delete();
  }
}
```

---

## References

- [Daytona SDK](https://www.npmjs.com/package/@daytonaio/sdk)
- [Daytona Dashboard](https://app.daytona.io)
- [API Keys](https://app.daytona.io/dashboard/keys)
