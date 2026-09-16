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
│   ├── sdk-ts/                  # TypeScript SDK (@evolvingmachines/sdk) — PRIMARY
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
│   ├── sdk-py/                  # Python SDK (evolve-sdk) — bridges to TS via JSON-RPC
│   │   ├── evolve/              # Python package (agent, bridge, integrations, pipeline, swarm, schema)
│   │   ├── bridge/              # Node.js bridge subprocess (bundle.mjs)
│   │   └── tests/
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
│   └── evolve/SKILL.md          # The pointer skill (hand-written): the one skill an agent installs; it reads the content from `evolve skills get`
├── skill-data/                  # The content the CLI serves and the npm package ships (packages/sdk-ts/skill-data/ is a staged copy, gitignored)
│   ├── evolve-evals/            # GENERATED from docs-mintlify/ (index + every page byte for byte under references/)
│   ├── evolve-agents/           # GENERATED from docs/evolve-agents.SKILL.md + docs/*/01-05
│   ├── evolve/                  # GENERATED copy of the pointer (what `evolve skills install` writes; hidden from `skills list`)
│   └── create-task/, rewardkit/, create-adapter/, publish/   # hand-written, ported from Harbor; edited in place
├── cookbooks/                   # Example applications
│   ├── typescript/
│   └── python/
├── docs/                        # Documentation (SOURCE OF TRUTH — edit here only)
│   ├── _meta.ts                 # Nextra navigation config
│   ├── index.md                 # Docs landing page
│   ├── evolve-agents.SKILL.md   # Hand-written SKILL.md of the evolve-agents skill (front matter + index of chapters 01–05)
│   ├── evolve-evals.SKILL.md    # Hand-written front matter of the evolve-evals skill (its body is generated from docs-mintlify/)
│   ├── typescript/              # TS SDK reference (6 chapters + index)
│   └── python/                  # Python SDK reference (6 chapters + index)
├── .claude/
│   └── skills/evolve/           # GENERATED mirror of the pointer (scripts/generate-skills.ts); an agent in this repo reads skill-data/ directly
├── .github/workflows/
│   ├── sync-docs-to-skill.yml   # Regenerates skill-data/, .claude/skills/, skills-lock.json from docs/ + docs-mintlify/ + skills/evolve/ (--check on PRs)
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

- **`docs/`, `docs-mintlify/` and `skills/evolve/SKILL.md` are the only places documentation is edited.** `skill-data/evolve-agents/`, `skill-data/evolve-evals/`, `skill-data/evolve/`, `.claude/skills/` and `skills-lock.json` are generated by `npm run generate:skills` (`scripts/generate-skills.ts`); `.github/workflows/sync-docs-to-skill.yml` checks them on pull requests and regenerates them on push. Hand-editing a generated copy gets overwritten and loses the change. The four hand-written skills (`create-task`, `rewardkit`, `create-adapter`, `publish`) are edited in place under `skill-data/`. The pointer stays under 500 words and carries only `name`, `description` and `allowed-tools`; the generator refuses anything else.
- **`docs/typescript/` and `docs/python/` are exact mirrors of each other.** Same sections, same order, same facts, same caveats — only the code differs. A change to one chapter is not finished until the other says the same thing.
