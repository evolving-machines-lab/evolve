<p align="center">
  <img src="assets/logo/evolve-logo.png" alt="Evolve SDK" height="200">
</p>

<p align="center">
  Run, deploy and monitor CLI agents in secure Cloud sandboxes.
</p>

<br>

- Run any CLI agent ([Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Qwen Code](https://github.com/QwenLM/qwen-code)) in secure cloud sandboxes
- Persistent filesystem for infinite context
- Full computer access: terminal, browser, MCP tools
- [Agent skills](https://agentskills.io/home): extend agents with custom capabilities (PDF, dev-browser, etc.)
- 500+ integrations (Gmail, GitHub, Slack, Notion & more) via [Composio](https://github.com/ComposioHQ/composio)
- Functional programming abstractions (map, filter, reduce) for massively parallel workloads
- Streaming and structured output
- Built-in [agent observability and analytics dashboard](https://dashboard.evolvingmachines.ai/)
- Much more coming...

Add the [`evolve-dev`](skills/evolve-dev/SKILL.md) SKILL to your favorite coding agent and start building with Evolve SDK:

```bash
git clone https://github.com/evolving-machines-lab/evolve.git
cp -r evolve/skills/evolve-dev ~/.claude/skills/       # Claude Code
cp -r evolve/skills/evolve-dev ~/.codex/skills/        # Codex
cp -r evolve/skills/evolve-dev ~/.gemini/skills/       # Gemini CLI
cp -r evolve/skills/evolve-dev ~/.qwen-code/skills/    # Qwen Code
```

## Get Started

### 1. Install the SDK

```bash
npm install @evolvingmachines/sdk    # TypeScript
pip install evolve-sdk    # Python
```

**Note:** Requires [Node.js 18+](https://nodejs.org/) (the Python SDK uses a lightweight Node.js bridge).

### 2. Run your first agent

Bring your own keys:
```bash
# .env - Direct (BYOK)
ANTHROPIC_API_KEY=sk-ant-...         # or CLAUDE_CODE_OAUTH_TOKEN (Claude Max), OPENAI_API_KEY, GEMINI_API_KEY
E2B_API_KEY=e2b_...                  # sandbox provider, get at https://e2b.dev
```

Or get your Evolve API key at [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) ([see 4. below](#evolve-gateway)):
```bash
# .env - Gateway
EVOLVE_API_KEY=sk-...
```

Then run:
```typescript
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve();  // auto-resolves env variables
await evolve.run({ prompt: "Create hello.txt with 'Hello World'" });
const output = await evolve.getOutputFiles();  // output.files
```

```python
from evolve import Evolve

evolve = Evolve()  # auto-resolves env variables
await evolve.run(prompt="Create hello.txt with 'Hello World'")
output = await evolve.get_output_files()  # output.files
```

<a id="evolve-gateway"></a>

### 3. Sandbox Providers

Evolve supports multiple sandbox providers for running agents in secure cloud environments.

#### E2B (Default)

[E2B](https://e2b.dev) is the default sandbox provider:

```bash
# .env
E2B_API_KEY=e2b_...  # get at https://e2b.dev
```

#### Modal

[Modal](https://modal.com) provides high-performance cloud compute with GPU support:

```bash
# .env
MODAL_TOKEN_ID=your_token_id
MODAL_TOKEN_SECRET=your_token_secret
```

```typescript
import { Evolve, ModalProvider } from "@evolvingmachines/sdk";

// Configure Modal provider
const modal = new ModalProvider({
  appName: "my-evolve-app",
  defaultImage: "python:3.12-slim",
});

// Use with Evolve
const kit = new Evolve({ sandbox: modal });
const result = await kit.run({ prompt: "Write a hello world script" });
```

```python
from evolve import Evolve, ModalProvider

# Configure Modal provider
modal = ModalProvider(
    app_name="my-evolve-app",
    default_image="python:3.12-slim",
)

# Use with Evolve
kit = Evolve(sandbox=modal)
result = await kit.run(prompt="Write a hello world script")
```

### 4. Unlock full power with Evolve API key

Sign up at [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai/) and get your **Evolve API key** for:
- Agent execution traces, observability and analytics
- Centralized billing across all providers
- Mix any model with any CLI agent
- $10 FREE CREDITS, no CC required

### 5. Learn more

Check out the [documentation](./docs) and [cookbooks](./cookbooks).

## Documentation

- [TypeScript SDK](./docs/typescript-sdk.md)
- [Python SDK](./docs/python-sdk.md)
- [Cookbooks](./cookbooks)
- [Skills](./skills)

## Support + Talk with Founders

- [Community Discord](https://discord.gg/Q36D8dGyNF)
- [Schedule Demo](https://cal.com/brando-magnani/evolve-1-1-onboarding-chat)
- Email: [brandomagnani@evolvingmachines.ai](mailto:brandomagnani@evolvingmachines.ai)

## Reporting Bugs

We welcome your feedback. File a [GitHub issue](https://github.com/evolving-machines-lab/evolve/issues) to report bugs or request features.

## License

See the [LICENSE](./LICENSE) file for full terms and conditions.
