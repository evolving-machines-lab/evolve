# Evolve SDK

Run CLI agents (Claude, Codex, Gemini, Qwen, Kimi, OpenCode, Droid, DeepSeek Harness) in secure sandboxes with built-in observability, and score them against datasets on hosted infrastructure.

## Contributing & branches

All work branches from and PRs into `project-sable` — the active development
trunk. Never target or push `main` (the released line; GitHub's PR dropdown
defaults to it — switch the base). Never push directly to any long-lived
branch; never force-push. Full rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## Repo Structure

```
evolve/
├── packages/
│   ├── sdk-ts/                  # TypeScript SDK (@evolvingmachines/evolve) — PRIMARY
│   │   └── src/
│   │       ├── evolve.ts        # Evolve builder class
│   │       ├── agent.ts         # Agent runtime
│   │       ├── registry.ts      # Agent registry (type → config)
│   │       ├── types.ts         # Shared types
│   │       ├── constants.ts     # Constants
│   │       ├── index.ts         # Public exports
│   │       ├── cli/             # The `evolve` CLI binary (src/cli/index.ts; skills.ts serves the bundled skills)
│   │       ├── hosted/          # Hosted evals client (datasets/agents/jobs/trials/auth)
│   │       ├── parsers/         # CLI output parsers (claude, codex, gemini, qwen, kimi, opencode, droid, dsh)
│   │       ├── integrations.ts  # Managed integration helpers
│   │       ├── managed-secrets.ts   # Dashboard-stored secrets attached by name
│   │       ├── provider-secrets.ts  # Managed BYO provider keys + runtime tokens
│   │       ├── browser.ts, browser-credentials.ts, browser-profiles.ts
│   │       ├── sandbox-artifacts.ts # Artifact collection from a sandbox
│   │       ├── sessions/        # Historical sessions + trace download
│   │       ├── mcp/             # MCP server config (json, toml, yaml for dsh, validation)
│   │       ├── swarm/           # Swarm (map/filter/reduce/bestOf/verify, semaphore)
│   │       ├── pipeline/        # Pipeline (fluent chaining)
│   │       ├── storage/         # Cloud-backed filesystem (S3 snapshots)
│   │       ├── observability/   # Session logger + dashboard integration
│   │       ├── prompts/         # Agent & user prompt templates (agent_md/, user/)
│   │       └── utils/           # Config, files, retry, sandbox, schema helpers
│   ├── sdk-py/                  # Python SDK (evolvingmachines-evolve) — bridges to TS via JSON-RPC
│   │   ├── evolve/              # Python package (agent, bridge, integrations, pipeline, swarm, schema)
│   │   ├── bridge/              # Node.js bridge subprocess (bundle.mjs)
│   │   └── tests/
│   ├── sdk-alias/               # The old npm name of the SDK: re-exports @evolvingmachines/evolve at the same version
│   ├── sdk-py-alias/            # The old PyPI name of the SDK: depends on evolvingmachines-evolve at the same version, no module
│   ├── e2b/                     # E2B sandbox provider (@evolvingmachines/e2b)
│   │   └── src/
│   ├── daytona/                 # Daytona sandbox provider (@evolvingmachines/daytona)
│   │   └── src/
│   └── modal/                   # Modal sandbox provider (@evolvingmachines/modal)
│       └── src/
├── assets/                      # Sandbox templates & build scripts
│   ├── e2b/                     # E2B template (build.ts, template.ts)
│   ├── daytona/                 # Daytona template (build.ts, template.ts)
│   ├── modal/                   # Modal template (build.ts, template.ts)
│   ├── docker/                  # Docker image (Dockerfile, build.ts)
│   ├── build.sh                 # Master build script
│   └── README.md
├── skills/                      # The skills: what `evolve skills` serves and the npm package ships (packages/sdk-ts/skills/ is a staged copy, gitignored)
│   ├── evolve/SKILL.md          # The pointer (hand-written): the one skill an agent installs; it reads the content from `evolve skills get`
│   ├── evolve-evals/            # GENERATED from docs-evals/ (index from docs.json + readable Markdown pages under references/); served as `evals`
│   ├── evolve-agents/           # GENERATED from docs-agents/SKILL.source.md + the chapters; NOT served by the CLI, installs with `npx skills add … --skill evolve-agents`
│   └── create-task/, rewardkit/, create-adapter/, publish/   # hand-written task-authoring skills, ported from Harbor; metadata.internal so only the pointer installs
├── cookbooks/                   # Example applications
│   ├── typescript/
│   └── python/
├── docs-evals/                  # The hosted-evals docs site (Mintlify; SOURCE OF TRUTH — edit here only)
│   ├── docs.json                # Site config; its description is also the evals skill's description
│   └── getting-started/, core-concepts/, cli-reference/, sdk-reference/, dashboard/, sdk/, snippets/
├── docs-agents/                 # The managed-agents docs (SOURCE OF TRUTH — edit here only)
│   ├── SKILL.source.md          # Hand-written skill behind skills/evolve-agents/SKILL.md: front matter + the guide and chapter index
│   ├── index.md                 # Landing page
│   ├── typescript/              # TS SDK reference (chapters + index)
│   └── python/                  # Python SDK reference (chapters + index)
├── .claude/
│   └── skills/evolve/           # GENERATED mirror of the pointer (scripts/generate-skills.ts); an agent in this repo reads skills/<name>/SKILL.md directly
├── .github/workflows/
│   ├── sync-docs-to-skill.yml   # Regenerates skills/evolve-evals, skills/evolve-agents, .claude/skills/; validates every skill against the spec (--check on PRs)
│   └── publish.yml              # NPM + PyPI publish (owns versioning)
├── logo/                        # Brand assets (PNG, GIF, 3D HTML)
├── package.json                 # Monorepo root
└── tsconfig.json                # Root TS config
```

## Development

- **Commits**: Conventional (`feat:`, `fix:`, `docs:`, `chore:`), single line, no co-authors
- **Code**: TypeScript SDK is primary (Python wraps via bridge), registry-based (agent differences = data)
- **Edit existing files**, don't create new ones unless necessary
- **Versioning is the publish workflow's job.** Do not hand-edit `version` in `packages/sdk-ts/package.json` or `packages/sdk-py/pyproject.toml`.

### Build and test

```bash
npm run build              # all packages (e2b, daytona, modal, sdk, python bridge)
npm run test:ts:unit       # TypeScript unit tests
npm run test:py:unit       # Python unit tests (builds the bridge first)
npm run test:ts:integration  # TypeScript integration tests (needs live credentials)
```

The API contract (`spec/openapi.yaml`) lives in the private platform repo, not here, so the tests that read it print SKIP in a normal checkout — including all of `test_hosted_spec_gate.py` and both `hosted-spec-gate` / typing gates. That is the expected result, not a failure. To actually run them, point `EVOLVE_OPENAPI_SPEC_PATH` at a local copy of the contract:

```bash
EVOLVE_OPENAPI_SPEC_PATH=/path/to/swarm_dashboard/spec/openapi.yaml npm run test:py:unit
```

### Documentation rules

- **`docs-evals/` and `docs-agents/` are the only places documentation is edited.** `skills/evolve-evals/` and `skills/evolve-agents/` are generated from them (`npm run generate:skills`, `scripts/generate-skills.ts`: the evals index from `docs-evals/docs.json` with every page rendered as readable Markdown under `references/`; the agents skill from `docs-agents/SKILL.source.md` with the chapters), as is the `.claude/skills/evolve/` mirror of the pointer; `.github/workflows/sync-docs-to-skill.yml` checks them on pull requests, regenerates them on push, and validates every folder under `skills/` against the Agent Skills specification. Hand-editing a generated copy gets overwritten and loses the change. The pointer (`skills/evolve/SKILL.md`, under 500 words, only `name`, `description`, `allowed-tools`) and the four hand-written skills are edited in place under `skills/`. Every skill but the pointer carries `metadata.internal: true`, so `npx skills add evolving-machines-lab/evolve` installs only the pointer; the CLI serves `skills/` minus `evolve-agents` (the SDK skill installs with `--skill evolve-agents`).
- **`docs-agents/typescript/` and `docs-agents/python/` are exact mirrors of each other.** Same sections, same order, same facts, same caveats — only the code differs. A change to one chapter is not finished until the other says the same thing.
