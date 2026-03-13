# Sandbox Modes

Evolve supports 6 sandbox modes spanning three categories: **remote cloud** (E2B, Modal, Daytona), **local container** (Docker), and **on-device** (OS Sandbox, Local). This guide helps you choose the right mode and understand the trade-offs.

## When to Use Which Mode

```
Is this production / untrusted code?
├── Yes → Do you need cloud scaling?
│   ├── Yes → E2B, Modal, or Daytona
│   └── No  → Docker
└── No (dev/testing/trusted)
    ├── Need filesystem/network isolation?
    │   ├── Yes → OS Sandbox
    │   └── No  → Local
    └── Need container-level isolation?
        └── Yes → Docker
```

**Quick picks:**
- **Production, untrusted code:** E2B (fastest), Modal, or Daytona
- **Local development, need isolation:** Docker or OS Sandbox
- **Fast iteration, trusted code:** Local
- **CI/CD, semi-trusted:** OS Sandbox

## Comparison Matrix

| Dimension | Local | OS Sandbox | Docker | E2B | Modal | Daytona |
|-----------|-------|------------|--------|-----|-------|---------|
| **Security** | None | Strong (kernel + SOCKS5) | Strong (container) | Strong (microVM) | Strong (container) | Strong (microVM) |
| **Memory overhead** | ~0 MB | ~5 MB (proxy) | ~50-100 MB | Cloud | Cloud | Cloud |
| **Startup time** | <1ms | ~100ms | ~2-5s | ~3-8s | ~5-15s | ~5-15s |
| **Platform** | All | macOS + Linux | macOS/Linux/Win | Any | Any | Any |
| **Dependencies** | None | sandbox-runtime | Docker Desktop | npm pkg | npm pkg | npm pkg |
| **Network isolation** | No | SOCKS5 domain filter | Docker networking | microVM | Container | microVM |
| **Filesystem isolation** | No | Deny/allow lists | Full container fs | Full microVM | Full | Full |
| **Use case** | Dev/testing | Semi-trusted, CI | Untrusted, local | Production | Production | Production |

## Feature Comparison

| Feature | Local | OS Sandbox | Docker | Remote (E2B/Modal/Daytona) |
|---------|-------|------------|--------|---------------------------|
| Setup complexity | Zero | Minimal | Docker install | API key |
| Startup time | Instant | ~100ms | ~2-5s | ~3-15s |
| Filesystem isolation | None | Kernel-enforced | Container | Full |
| Network isolation | None | SOCKS5 proxy | Docker network | Cloud |
| Process isolation | None | Partial (sandbox) | Full (container) | Full |
| Credential protection | None | denyRead lists | Container boundary | Cloud boundary |
| Resource limits | None | OS limits | Container limits | Provider limits |
| Port forwarding | localhost | localhost | Docker ports | Provider URLs |
| Pause/resume | No | No | Yes | Yes |
| Snapshot/checkpoint | No | No | Docker commit | Provider-native |

## On-Device Modes

### Local

Direct subprocess execution. Commands run via `bash -c` on the host. File operations use `node:fs/promises`.

**Best for:** Rapid iteration, debugging, testing trusted code.

```ts
import { createLocalProvider } from "@evolvingmachines/local";

const provider = createLocalProvider({
  workingDirectory: "./my-project",
});
```

**Security model:** None. Commands execute with the same permissions as the Node.js process.

### OS Sandbox

Kernel-enforced isolation via `@anthropic-ai/sandbox-runtime`:
- **macOS:** Seatbelt (`sandbox-exec`) profiles
- **Linux:** bubblewrap (`bwrap`) namespaces
- **Network:** SOCKS5 proxy with domain allow/deny lists

**Best for:** Semi-trusted code, CI pipelines, development with credential protection.

```ts
import { createOSSandboxProvider } from "@evolvingmachines/sandbox";

const provider = createOSSandboxProvider({
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", "*.pem", "*.key"],
  },
  network: {
    allowedDomains: ["api.github.com", "registry.npmjs.org"],
  },
});
```

**Security model:** Kernel-level enforcement. Even if the sandboxed process attempts to bypass restrictions, the OS blocks unauthorized access at the syscall level.

### Docker

Local container execution via Docker CLI. Full container isolation with its own filesystem and network namespace.

**Best for:** Running untrusted code locally, matching production environments, testing container-dependent workflows.

```ts
import { createDockerProvider } from "@evolvingmachines/docker";

const provider = createDockerProvider({
  imageName: "evolve-all",
});
```

**Security model:** Container boundary. Process runs in an isolated namespace with its own filesystem root.

## Configuration Reference

### Environment Variables

| Variable | Mode | Values |
|----------|------|--------|
| `E2B_API_KEY` | E2B | API key string |
| `DAYTONA_API_KEY` | Daytona | API key string |
| `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` | Modal | Token pair |
| `EVOLVE_SANDBOX_DOCKER` | Docker | `true` or `1` |
| `EVOLVE_SANDBOX_MICROVM` | MicroVM | `true` or `1` |
| `EVOLVE_SANDBOX_OS` | OS Sandbox | `true` or `1` |
| `EVOLVE_SANDBOX_LOCAL` | Local | `true` or `1` |
| `EVOLVE_API_KEY` | Gateway (E2B) | API key string |

### Resolution Priority

The SDK resolves providers in this order (first match wins):

1. `E2B_API_KEY` → E2B (direct)
2. `DAYTONA_API_KEY` → Daytona (direct)
3. `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` → Modal (direct)
4. `EVOLVE_SANDBOX_DOCKER=true` → Docker
5. `EVOLVE_SANDBOX_MICROVM=true` → MicroVM
6. `EVOLVE_SANDBOX_OS=true` → OS Sandbox
7. `EVOLVE_SANDBOX_LOCAL=true` → Local
8. `EVOLVE_API_KEY` → Gateway (E2B fallback)

You can always override auto-resolution with `.withSandbox(provider)`.

## Security Model Deep Dive

### Isolation Approaches

**No isolation (Local):** Commands run as your user. Fast but no protection. Only appropriate when you fully trust the code being executed.

**OS-level isolation (OS Sandbox):** The kernel enforces restrictions:
- **Filesystem:** Deny/allow lists checked at the VFS layer. Cannot be bypassed from userspace.
- **Network:** SOCKS5 proxy intercepts all outbound connections. Domain-level allow/deny filtering.
- **Process:** Sandbox profile restricts available syscalls (macOS Seatbelt) or namespaces (Linux bubblewrap).

**Container isolation (Docker):** Full namespace isolation:
- Separate PID, network, mount, and user namespaces.
- Own root filesystem (from Docker image).
- Network isolation via Docker bridge/host networking.

**MicroVM isolation (E2B, Daytona):** Strongest isolation:
- Hardware-virtualized boundary.
- Separate kernel instance.
- No shared kernel attack surface.

### Choosing a Security Level

| Scenario | Recommended Mode |
|----------|-----------------|
| Your own code in dev | Local |
| CI/CD for your repos | OS Sandbox |
| Code from PRs/contributors | Docker or OS Sandbox |
| User-submitted code | E2B, Modal, or Daytona |
| Multi-tenant production | E2B, Modal, or Daytona |
