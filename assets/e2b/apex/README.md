# APEX Benchmark E2B Template

E2B template for running APEX-Agents benchmark (480 tasks, 33 worlds).

## What's Included

- **Base**: `evolve-all` (Claude Code, Codex, Gemini CLI, Qwen Code)
- **MCP Servers**: mail, calendar, chat, documents, spreadsheets, pdfs, presentations
- **System Packages**: LibreOffice, proot, zip/unzip
- **Pre-cached Data**: All 33 APEX worlds from HuggingFace (~9GB)

## Directory Structure

```
/opt/mcp/                    # MCP servers
├── mail/
├── calendar/
├── chat/
├── documents/
├── spreadsheets/
├── pdfs/
└── presentations/

/opt/apex/dataset/           # Pre-cached HuggingFace dataset
└── world_files_zipped/
    ├── world_abc.zip
    └── ...

/.apps_data/                 # MCP server state (runtime)
├── mail/
├── calendar/
└── chat/

/home/user/workspace/        # Agent workspace
├── context/                 # World files extracted here
└── output/                  # Agent output
```

## Build

Requires `evolve-all` template to be built first.

```bash
# From evolve repo root
npx tsx assets/e2b/apex/build.ts
```

Build time: ~30-60 minutes (mostly downloading 9GB of worlds)

## Usage

```python
from evolve import Evolve, E2BProvider

evolve = Evolve(
    sandbox=E2BProvider(template='apex-benchmark'),
    mcp_servers={
        "mail": {
            "command": "uv",
            "args": ["run", "python", "mcp_servers/mail_server/main.py"],
            "cwd": "/opt/mcp/mail",
            "env": {"APP_MAIL_DATA_ROOT": "/.apps_data/mail"}
        },
        # ... other servers
    }
)
```

## MCP Server Configuration

| Server | Entry Point | Environment Variable |
|--------|-------------|---------------------|
| mail | `/opt/mcp/mail/mcp_servers/mail_server/main.py` | `APP_MAIL_DATA_ROOT=/.apps_data/mail` |
| calendar | `/opt/mcp/calendar/mcp_servers/calendar_server/main.py` | `APP_CALENDAR_DATA_ROOT=/.apps_data/calendar` |
| chat | `/opt/mcp/chat/mcp_servers/chat_server/main.py` | `STATE_LOCATION=/.apps_data/chat`, `HAS_STATE=true` |
| documents | `/opt/mcp/documents/mcp_servers/docs_server/main.py` | `APP_DOCS_ROOT=/home/user/workspace/context` |
| spreadsheets | `/opt/mcp/spreadsheets/mcp_servers/sheets_server/main.py` | `APP_SHEETS_ROOT=/home/user/workspace/context` |
| pdfs | `/opt/mcp/pdfs/mcp_servers/pdf_server/main.py` | `APP_PDF_ROOT=/home/user/workspace/context` |
| presentations | `/opt/mcp/presentations/mcp_servers/slides_server/main.py` | `APP_SLIDES_ROOT=/home/user/workspace/context` |
