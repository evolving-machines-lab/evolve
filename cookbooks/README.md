## Cookbooks

### Python
- [Quickstart](./python/quickstart) - Minimal examples (8 scripts)
- [CLI Agent](./python/cli-agent) - Sandboxed CLI agent with browser automation
- [HN Time Capsule](./python/hn-time-capsule) - Scrape & analyze 200 Hacker News articles → HTML dashboard
- [CRE Portfolio](./python/cre-portfolio) - Extract & analyze commercial real estate rent rolls → JSON + dashboard

### TypeScript
- [Quickstart](./typescript/quickstart) - Minimal examples (8 scripts)
- [CLI Agent](./typescript/cli-agent) - Sandboxed CLI agent with browser automation
- [HN Time Capsule](./typescript/hn-time-capsule) - Scrape & analyze 200 Hacker News articles → HTML dashboard
- [CRE Portfolio](./typescript/cre-portfolio) - Extract & analyze commercial real estate rent rolls → JSON + dashboard

## Get Started

### 1. Install the SDK

```bash
npm install @evolvingmachines/sdk    # TypeScript
pip install evolve-sdk         # Python
```

**Note:** Requires [Node.js 18+](https://nodejs.org/) (the Python SDK uses a lightweight Node.js bridge).

### 2. Run your first agent

Bring your own keys:
```bash
# .env - Direct (BYOK)
ANTHROPIC_API_KEY=sk-ant-...         # or CLAUDE_CODE_OAUTH_TOKEN (Claude Max), OPENAI_API_KEY, GEMINI_API_KEY
E2B_API_KEY=e2b_...                  # sandbox provider, get at https://e2b.dev
```

Or get your Evolve API key at [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) ([see 3. below](#evolve-gateway)):
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

### 3. Unlock full power with Evolve API key

Sign up at [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai/) and get your **Evolve API key** for:
- Agent execution traces, observability and analytics
- Centralized billing across all providers
- Mix any model with any CLI agent
- $10 FREE CREDITS, no CC required

### 4. Learn more

Check out the [documentation](https://github.com/evolvingmachines/evolve/tree/main/docs) and [cookbooks](https://github.com/evolvingmachines/evolve/tree/main/cookbooks).

## Support + Talk with Founders

- [Community Discord](https://discord.gg/Q36D8dGyNF)
- [Schedule Demo](https://cal.com/brando-magnani/evolve-1-1-onboarding-chat)
- Email: [brandomagnani@evolvingmachines.ai](mailto:brandomagnani@evolvingmachines.ai)

## Reporting Bugs

We welcome your feedback. File a [GitHub issue](https://github.com/evolvingmachines/evolve/issues) to report bugs or request features.

## License

See the [LICENSE](../LICENSE) file for full terms and conditions.
