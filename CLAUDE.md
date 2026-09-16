# Evolve SDK

Run CLI agents (Claude, Codex, Gemini, Qwen, Kimi, OpenCode, Droid) in secure sandboxes with built-in observability, and score them against datasets on hosted infrastructure.

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
│   │       ├── parsers/         # CLI output parsers (claude, codex, gemini, qwen, kimi, opencode, droid)
│   │       ├── integrations.ts  # Managed integration helpers
│   │       ├── managed-secrets.ts   # Dashboard-stored secrets attached by name
│   │       ├── provider-secrets.ts  # Managed BYO provider keys + runtime tokens
│   │       ├── browser.ts, browser-credentials.ts, browser-profiles.ts
│   │       ├── sandbox-artifacts.ts # Artifact collection from a sandbox
│   │       ├── sessions/        # Historical sessions + trace download
│   │       ├── mcp/             # MCP server config (json, toml, validation)
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
├── skills/
│   ├── evolve/SKILL.md          # The pointer skill (hand-written): the one skill an agent installs; it reads the content from `evolve skills get`
│   └── create-task/, rewardkit/, create-adapter/, publish/   # hand-written task-authoring skills, ported from Harbor; metadata.internal so only the pointer installs
├── cookbooks/                   # Example applications
│   ├── typescript/
│   └── python/
├── docs-evals/                  # The hosted-evals docs site (Mintlify) AND the `evals` skill the CLI serves; pages read in place
│   ├── docs.json                # Site config; its description is the skill's description
│   ├── SKILL.md                 # GENERATED index of the site (scripts/generate-skills.ts from docs.json)
│   └── getting-started/, core-concepts/, cli-reference/, sdk-reference/, dashboard/, sdk/, snippets/
├── docs-agents/                 # The managed-agents docs AND the `agents` skill the CLI serves
│   ├── SKILL.source.md          # Hand-written: front matter + the guide and chapter index
│   ├── SKILL.md                 # GENERATED from SKILL.source.md
│   ├── index.md                 # Landing page
│   ├── typescript/              # TS SDK reference (6 chapters + index)
│   └── python/                  # Python SDK reference (6 chapters + index)
├── .claude/
│   └── skills/evolve/           # GENERATED mirror of the pointer (scripts/generate-skills.ts); an agent in this repo reads docs-evals/SKILL.md directly
├── .github/workflows/
│   ├── sync-docs-to-skill.yml   # Regenerates the two SKILL.md files and .claude/skills/; validates every skill against the spec (--check on PRs)
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

- **The docs folders are the skills.** `docs-evals/` is the Mintlify site and the `evals` skill; `docs-agents/` is the managed-agents docs and the `agents` skill; the CLI reads their pages in place, nothing is copied anywhere. Edit the pages, `docs-evals/docs.json`, `docs-agents/SKILL.source.md` and `skills/*/SKILL.md`; `docs-evals/SKILL.md`, `docs-agents/SKILL.md` and `.claude/skills/` are generated by `npm run generate:skills` (`scripts/generate-skills.ts`), which `.github/workflows/sync-docs-to-skill.yml` checks on pull requests and regenerates on push, then validates every skill folder against the Agent Skills specification. Hand-editing a generated file gets overwritten and loses the change. Every skill but the pointer carries `metadata.internal: true`, so `npx skills add` installs only the pointer; the pointer stays under 500 words with only `name`, `description` and `allowed-tools`.
- **`docs-agents/typescript/` and `docs-agents/python/` are exact mirrors of each other.** Same sections, same order, same facts, same caveats — only the code differs. A change to one chapter is not finished until the other says the same thing.
