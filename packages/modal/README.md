# @evolvingmachines/modal

Modal sandbox provider for the Evolve SDK. Provides GPU-enabled cloud sandboxes for running AI agents.

## Installation

```bash
npm install @evolvingmachines/modal
```

## Prerequisites

1. Install Modal CLI and authenticate:
```bash
pip install modal
modal setup
```

This sets up authentication for both Python and JS SDKs.

## Usage

```typescript
import { createModalProvider } from "@evolvingmachines/modal";
import { Agent } from "@evolvingmachines/sdk";

const provider = createModalProvider({
  appName: "my-app",  // Optional, defaults to "evolve"
  encryptedPorts: [3000],  // Ports to expose via HTTPS
});

const agent = new Agent({
  type: "claude",
  sandbox: provider,
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const result = await agent.run("Build a web server");
```

## GPU Support

Modal's killer feature is GPU access:

```typescript
const provider = createModalProvider();

const sandbox = await provider.create({
  image: "nvidia/cuda:12.1.0-base-ubuntu22.04",
  gpu: "T4",           // Single T4 GPU
  // gpu: "A100-80GB:4", // 4x A100 GPUs
  resources: {
    cpu: 8,
    memory: 32,  // GB
  },
});
```

Available GPUs:
- `T4` - Entry-level, good for inference
- `L4` - Balanced performance
- `A10G` - High memory bandwidth
- `A100-40GB` / `A100-80GB` - Training workloads
- `H100` - Cutting edge

## Fast File Operations

The provider uses optimized batch uploads via tar streaming:

```typescript
// Single file
await sandbox.files.write("/app/main.py", "print('hello')");

// Batch upload (uses tar for speed)
await sandbox.files.writeBatch([
  { path: "/app/main.py", data: "..." },
  { path: "/app/utils.py", data: "..." },
  { path: "/app/config.json", data: "..." },
  // ... hundreds of files
]);
```

## Comparison with E2B/Daytona

| Feature | E2B | Daytona | Modal |
|---------|:---:|:-------:|:-----:|
| GPU Support | - | - | T4, A100, H100 |
| File API | Native | Native | Shell-based |
| Pause/Resume | Yes | Yes | No |
| Fast Batch Upload | Native | Native | Tar streaming |

## Configuration

```typescript
interface ModalConfig {
  /** Modal app namespace. Default: "evolve" */
  appName?: string;

  /** Default sandbox timeout in ms. Default: 3600000 (1 hour) */
  defaultTimeoutMs?: number;

  /** Ports to expose via HTTPS */
  encryptedPorts?: number[];

  /** HTTP/2 ports */
  h2Ports?: number[];
}
```

## Limitations

- **No pause()**: Modal doesn't support pausing sandboxes
- **No reconnect**: Cannot reconnect to existing sandboxes
- **No list()**: Cannot list running sandboxes
- **File ops via shell**: Slightly slower than native APIs

These limitations are acceptable because the primary use case is running AI agents with GPU acceleration.
