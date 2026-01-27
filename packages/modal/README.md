# @evolvingmachines/modal

Modal sandbox provider for the Evolve SDK. Provides cloud sandboxes for running AI agents.

## Installation

```bash
npm install @evolvingmachines/modal
```

## Prerequisites

Get Modal tokens from [modal.com/settings/tokens](https://modal.com/settings/tokens) and set:

```bash
export MODAL_TOKEN_ID=ak_xxxxxxxx
export MODAL_TOKEN_SECRET=as_xxxxxxxx
```

## Usage

```typescript
import { createModalProvider } from "@evolvingmachines/modal";

const provider = createModalProvider({
  appName: "my-app",  // Optional, defaults to "evolve-sandbox"
});

const sandbox = await provider.create({
  image: "evolvingmachines/evolve-all:latest",
  workingDirectory: "/home/user",
});

// Run commands
const result = await sandbox.commands.run("claude --version");
console.log(result.stdout);

// File operations
await sandbox.files.write("/tmp/hello.txt", "Hello World");
const content = await sandbox.files.read("/tmp/hello.txt");

// Cleanup
await sandbox.kill();
```

## With Evolve SDK

```typescript
import { Evolve, createModalProvider } from "@evolvingmachines/sdk";

// Auto-detect from env (if MODAL_TOKEN_ID + MODAL_TOKEN_SECRET set)
const result = await Evolve.create("claude").run("Build a web server");

// Or explicit
const result = await Evolve.create("claude")
  .withSandbox(createModalProvider())
  .run("Build a web server");
```

## Features

### Commands
```typescript
// Blocking execution
const result = await sandbox.commands.run("echo hello");
console.log(result.stdout, result.stderr, result.exitCode);

// Background process
const handle = await sandbox.commands.spawn("sleep 60");
await handle.wait();  // or handle.kill()

// With options
await sandbox.commands.run("pwd", {
  cwd: "/tmp",
  envs: { MY_VAR: "value" },
  timeoutMs: 30000,
});
```

### File Operations
```typescript
// Read/write text
await sandbox.files.write("/tmp/file.txt", "content");
const text = await sandbox.files.read("/tmp/file.txt");

// Read/write binary
await sandbox.files.write("/tmp/image.png", imageBuffer);
const binary = await sandbox.files.read("/tmp/image.png");

// Batch upload (optimized with tar)
await sandbox.files.writeBatch([
  { path: "/app/main.py", data: "print('hello')" },
  { path: "/app/config.json", data: '{"key": "value"}' },
]);

// Directory operations
await sandbox.files.makeDir("/tmp/nested/dir");
await sandbox.files.list("/tmp");
await sandbox.files.exists("/tmp/file.txt");
await sandbox.files.rename("/tmp/old.txt", "/tmp/new.txt");
await sandbox.files.remove("/tmp/file.txt");
```

### Streaming
```typescript
// Stream read
const stream = await sandbox.files.readStream("/tmp/large.bin");

// Stream write
await sandbox.files.writeStream("/tmp/output.bin", dataStream);
```

### Provider Methods
```typescript
// Create sandbox
const sandbox = await provider.create({ image: "python:3.12" });

// Reconnect to existing sandbox
const sandbox = await provider.connect("sb-xxxxx");

// List sandboxes
const sandboxes = await provider.list({ limit: 10 });
```

## Configuration

```typescript
interface ModalConfig {
  /** Modal app namespace. Default: "evolve-sandbox" */
  appName?: string;

  /** Default sandbox timeout in ms. Default: 3600000 (1 hour) */
  defaultTimeoutMs?: number;
}
```

## Comparison with E2B/Daytona

| Feature | E2B | Daytona | Modal |
|---------|:---:|:-------:|:-----:|
| File API | Native | Native | Shell-based |
| Batch Upload | Native | Native | Tar streaming |
| Pause/Resume | Yes | Yes | No |
| Pre-signed URLs | Yes | Yes | No |
| Watch Directory | Yes | Yes | No |
| Port Tunneling | Yes | Yes | Yes |

## Limitations

Methods that throw (not supported by Modal):
- `pause()` - Use `kill()` instead
- `files.uploadUrl()` / `files.downloadUrl()` - Use streaming instead
- `files.watchDir()` - Not available
- `commands.connect()` / `commands.sendStdin()` - Modal's isolated exec model

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MODAL_TOKEN_ID` | Modal API token ID (required) |
| `MODAL_TOKEN_SECRET` | Modal API token secret (required) |
