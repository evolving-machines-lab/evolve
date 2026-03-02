# Evolve SDK

Run CLI agents (Claude, Codex, Gemini, Qwen) in secure sandboxes with built-in observability.

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
│   │       ├── parsers/         # CLI output parsers (claude, codex, gemini, qwen, kimi, opencode)
│   │       ├── composio/        # Composio integration (auth, session, types)
│   │       ├── mcp/             # MCP server config (json, toml, validation)
│   │       ├── swarm/           # Swarm (map/filter/reduce/bestOf/verify, semaphore)
│   │       ├── pipeline/        # Pipeline (fluent chaining)
│   │       ├── storage/         # Cloud-backed filesystem (S3 snapshots)
│   │       ├── observability/   # Session logger + dashboard integration
│   │       ├── prompts/         # Agent & user prompt templates (agent_md/, user/)
│   │       └── utils/           # Config, files, retry, sandbox, schema helpers
│   ├── sdk-py/                  # Python SDK (evolve-sdk) — bridges to TS via JSON-RPC
│   │   ├── evolve/              # Python package (agent, bridge, composio, pipeline, swarm, schema)
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
├── skills/                      # Agent skills (43 total)
│   ├── pdf, docx, pptx, xlsx   # Document processing
│   ├── agent-browser, dev-browser, webapp-testing  # Browser automation
│   ├── frontend-design, shadcn-webapp-design, web-design-guidelines  # Design
│   ├── evolve, evolve-orchestrator  # SDK development
│   ├── skill-creator, skill-share, template-skill  # Skill tooling
│   ├── remotion, slides-as-code, canvas-design  # Media & presentations
│   ├── mcp-builder              # MCP server builder
│   └── ...                      # content-research, lead-research, invoice, image-enhancer, etc.
├── cookbooks/                   # Example applications
│   ├── typescript/
│   └── python/
├── docs/                        # Documentation (source of truth)
│   ├── _meta.ts                 # Nextra navigation config
│   ├── index.md                 # Docs landing page
│   ├── changelog.md             # Symlink → ../CHANGELOG.md
│   ├── typescript/              # TS SDK reference (5 chapters + index)
│   └── python/                  # Python SDK reference (5 chapters + index)
├── docs-site/                   # Nextra docs site (Next.js 16 + Nextra 4.6)
│   ├── src/app/                 # Next.js app (layout, page)
│   ├── tests/                   # Unit, integration, e2e, visual tests
│   ├── next.config.mjs          # Next.js config (basePath: /evolve)
│   └── package.json             # Workspace: docs-site
├── .claude/
│   └── skills/evolve/           # Evolve skill (auto-synced from docs/)
├── .github/workflows/
│   ├── docs.yml                 # Build + test + deploy docs to GitHub Pages
│   ├── sync-docs-to-skill.yml   # Sync docs/ → skills/ + .claude/skills/
│   └── publish.yml              # NPM publish
├── logo/                        # Brand assets (PNG, GIF, 3D HTML)
├── package.json                 # Monorepo root
└── tsconfig.json                # Root TS config
```

## Development

- **Commits**: Conventional (`feat:`, `fix:`, `docs:`, `chore:`), single line, no co-authors
- **Code**: TypeScript SDK is primary (Python wraps via bridge), registry-based (agent differences = data)
- **Edit existing files**, don't create new ones unless necessary
