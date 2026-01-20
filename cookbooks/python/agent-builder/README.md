# Agent Builder

A dynamic AI agent web application that executes tasks and generates beautiful visualizations.

## Features

- **Task Execution**: Submit natural language tasks with optional file uploads
- **Sandboxed Execution**: Safe code execution in E2B cloud sandbox
- **Auto-Visualization**: AI generates custom HTML dashboards for results
- **Real-time Streaming**: WebSocket-based progress updates
- **Tabbed Interface**: View visualizations, raw files, and execution logs

## Quick Start

1. **Set up environment variables** in `.env` (parent directory):
   ```
   EVOLVE_API_KEY=your_key
   ```

2. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Run the application**:
   ```bash
   python app.py
   ```

4. **Open in browser**: http://localhost:8000

## Architecture

```
User Prompt + Files
        ↓
┌───────────────────┐
│  Agent 1: Task    │  Executes the task in sandbox
│    Executor       │  Produces output files
└───────────────────┘
        ↓
┌───────────────────┐
│  Agent 2: UI      │  Analyzes outputs
│    Generator      │  Creates HTML visualization
└───────────────────┘
        ↓
   Tabbed Results
   (Viz | Files | Log)
```

## API Endpoints

- `POST /api/jobs` - Create a new job
- `GET /api/jobs/{id}` - Get job status
- `GET /api/jobs/{id}/files/{filename}` - Get output file
- `GET /api/jobs/{id}/visualization` - Get generated visualization
- `WS /ws/{id}` - WebSocket for real-time updates
