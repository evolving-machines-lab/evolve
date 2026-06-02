# Managed Integrations Cookbook (TypeScript)

Evolve-managed app integrations.

AI agent with access to external services (Gmail, Slack, GitHub, Notion, etc.)

## Setup

```bash
cd cookbooks/typescript/integrations
npm install
cp .env.example .env
# Fill in EVOLVE_API_KEY
```

## Run

```bash
npm start
```

## What Happens

1. Script creates an Evolve-managed integration session
2. Checks which services need authentication
3. Prompts you to connect (opens OAuth links)
4. Agent runs with full access to connected services

## Example Prompts

```
> Send an email to john@acme.com saying "Meeting at 3pm"
> Post to #general on Slack: "Deploy complete"
> Create a GitHub issue in my-org/repo titled "Fix login bug"
> Add a page to my Notion workspace about project updates
```

## Configuration

Edit `agent.ts` to change:

- `USER_ID` - Stable integration user ID
- `ENABLED_APPS` - Which services to enable
