# Composio Cookbook (TypeScript)

Evolve + Composio Tool Router integration.

AI agent with access to 500+ external services (Gmail, Slack, GitHub, Notion, etc.)

## Setup

```bash
cd cookbooks/typescript/composio
npm install
cp .env.example .env
# Fill in EVOLVE_API_KEY and COMPOSIO_API_KEY
```

## Run

```bash
npx tsx swarm.ts
```

## What Happens

1. Script creates Composio session with filtered toolkits
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

Edit `swarm.ts` to change:

- `USER_ID` - Unique ID for user's Composio session
- `ENABLED_TOOLKITS` - Which services to enable (or `[]` for all 500+)
