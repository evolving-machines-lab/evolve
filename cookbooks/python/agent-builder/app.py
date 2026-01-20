#!/usr/bin/env python3
"""
Dynamic Agent Builder - Web Application

A web interface for running AI agents with dynamic UI visualization:
1. User submits a task with optional files
2. Agent 1 executes the task and produces outputs
3. Agent 2 generates a beautiful HTML visualization of the results

Run: python app.py
"""

import asyncio
import os
import json
import uuid
import base64
from pathlib import Path
from typing import Optional
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv

from evolve import Evolve, AgentConfig, E2BProvider

load_dotenv()

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

AGENT_CONFIG = AgentConfig(
    type="claude",
    api_key=os.getenv("EVOLVE_API_KEY"),
)

SANDBOX_CONFIG = E2BProvider(
    api_key=os.getenv("E2B_API_KEY"),
    timeout_ms=600_000,  # 10 minutes
)

# In-memory storage for job results (use Redis/DB in production)
jobs: dict[str, dict] = {}

# ─────────────────────────────────────────────────────────────────────────────
# System Prompts
# ─────────────────────────────────────────────────────────────────────────────

TASK_EXECUTOR_PROMPT = """You are a powerful AI agent that can execute code, analyze data,
browse the web, and solve complex tasks. You have access to a sandboxed environment with
Python, Node.js, and common data science tools.

Your task is to complete the user's request and save all outputs to the output/ folder.
Be thorough, produce high-quality results, and save meaningful output files."""

UI_GENERATOR_PROMPT = """You are a UI visualization expert. Your task is to create beautiful,
interactive HTML + vanilla JavaScript dashboards to visualize data outputs.

## Your Inputs
1. ORIGINAL USER PROMPT - What the user was trying to accomplish
2. OUTPUT FILES - All files produced by the task agent

## Your Task
Create a single index.html file that:
1. Beautifully visualizes ALL relevant output data
2. Is tailored to what the user wanted to achieve
3. Uses modern, clean design with an Anthropic-inspired color palette:
   - Background: #FAF9F7 (warm off-white)
   - Primary text: #1A1915 (warm black)
   - Secondary text: #6B6963 (warm gray)
   - Accent: #D97757 (coral/terracotta)
   - Secondary accent: #9B8AFB (soft purple)
   - Success: #10A37F (green)
   - Cards: #FFFFFF with subtle shadow
4. Is fully self-contained (inline CSS, vanilla JS, no external deps except CDNs)
5. Is responsive and works on mobile

## Design Principles
- Visual hierarchy: Most important insights first
- Use charts/graphs for numerical data (use Chart.js from CDN)
- Use tables for detailed data (sortable, searchable)
- Use cards for key metrics
- Use color meaningfully (red=bad, green=good, etc.)
- Include the raw data in expandable sections
- Add download buttons for data export
- Use Inter or system fonts for clean typography
- Subtle shadows and rounded corners (8-12px border radius)
- Generous whitespace and padding

## Technical Requirements
- Single index.html file with inline <style> and <script>
- Load Chart.js from CDN if needed: https://cdn.jsdelivr.net/npm/chart.js
- Embed data directly in JavaScript (no fetch calls)
- Make charts interactive (hover tooltips, click to filter)
- Include a "View Raw Data" toggle

## Output
Save your visualization to: output/visualization/index.html

Remember: You're creating this for visual learners. Make the data BEAUTIFUL
and IMMEDIATELY understandable. The design should feel premium and professional.
"""

# ─────────────────────────────────────────────────────────────────────────────
# Models
# ─────────────────────────────────────────────────────────────────────────────

class JobStatus(BaseModel):
    job_id: str
    status: str  # pending, executing, generating_ui, completed, failed
    progress: list[str] = []
    raw_files: dict[str, str] = {}  # filename -> base64 content
    visualization_html: Optional[str] = None
    error: Optional[str] = None
    created_at: str
    completed_at: Optional[str] = None

# ─────────────────────────────────────────────────────────────────────────────
# FastAPI App
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    os.makedirs("uploads", exist_ok=True)
    os.makedirs("results", exist_ok=True)
    yield
    # Shutdown - cleanup if needed

app = FastAPI(title="Agent Builder", lifespan=lifespan)

# Serve static frontend
static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

# ─────────────────────────────────────────────────────────────────────────────
# Agent Execution
# ─────────────────────────────────────────────────────────────────────────────

async def run_agent_pipeline(
    job_id: str,
    prompt: str,
    files: dict[str, bytes],
    websocket: Optional[WebSocket] = None,
    parent_context: dict[str, bytes] = None,
    original_prompt: str = None,
    skip_visualization: bool = False
):
    """Run the two-agent pipeline: Task Executor -> UI Generator

    If parent_context is provided, this is a follow-up request that modifies
    an existing agent. The parent's output files are uploaded as context.

    If skip_visualization is True, only run the task executor (faster).
    """

    job = jobs[job_id]
    is_follow_up = parent_context and len(parent_context) > 0

    async def send_update(message: str, status: Optional[str] = None):
        job["progress"].append(message)
        if status:
            job["status"] = status
        if websocket:
            try:
                await websocket.send_json({
                    "type": "progress",
                    "message": message,
                    "status": job["status"],
                    "progress": job["progress"]
                })
            except:
                pass

    try:
        # ═══════════════════════════════════════════════════════════════════
        # AGENT 1: Task Executor
        # ═══════════════════════════════════════════════════════════════════

        await send_update("Starting task executor...", "executing")

        # Build a context-aware system prompt for follow-ups
        system_prompt = TASK_EXECUTOR_PROMPT
        if is_follow_up:
            system_prompt += f"""

## Follow-up Context
This is a MODIFICATION request. The user previously asked:
"{original_prompt}"

You have their previous output files in the context/ folder. Review these files
and apply the requested changes. Save your modified outputs to the output/ folder.
Preserve what works and only change what the user requests."""

        async with Evolve(
            config=AGENT_CONFIG,
            sandbox=SANDBOX_CONFIG,
            system_prompt=system_prompt,
            session_tag_prefix=f"agent-builder-{job_id[:8]}",
        ) as executor:

            # Upload parent context files if this is a follow-up
            if is_follow_up and parent_context:
                await send_update(f"Loading {len(parent_context)} previous file(s) as context...")
                context_files = {f"context/{name}": content for name, content in parent_context.items()}
                await executor.upload_context(context_files)

            # Upload user files if any
            if files:
                await send_update(f"Uploading {len(files)} file(s)...")
                await executor.upload_context(files)

            # Set up streaming handler (sync callback that schedules async work)
            def handle_event(event: dict):
                update = event.get("update", {})
                event_type = update.get("sessionUpdate")

                if event_type == "tool_call":
                    title = update.get("title", "")
                    if title and "todo" not in title.lower():
                        asyncio.create_task(send_update(f"Tool: {title}"))
                elif event_type == "agent_message_chunk":
                    content = update.get("content", {})
                    if content.get("type") == "text":
                        text = content.get("text", "")
                        if text and len(text) > 50:
                            asyncio.create_task(send_update(f"Agent: {text[:100]}..."))

            executor.on("content", handle_event)

            # Build the execution prompt
            execution_prompt = prompt
            if is_follow_up:
                execution_prompt = f"""Previous request: {original_prompt}

User's modification request: {prompt}

Review the files in context/ folder and apply the requested changes. Save outputs to output/ folder."""

            await send_update("Executing task...")
            result = await executor.run(prompt=execution_prompt)

            await send_update("Downloading output files...")
            output = await executor.get_output_files(recursive=True)
            raw_files = output.files or {}

            if not raw_files:
                await send_update("Warning: No output files generated")
            else:
                await send_update(f"Generated {len(raw_files)} file(s)")
                for name in list(raw_files.keys())[:5]:
                    await send_update(f"  - {name}")

        # Store raw files as base64
        job["raw_files"] = {}
        for name, content in raw_files.items():
            if isinstance(content, bytes):
                job["raw_files"][name] = base64.b64encode(content).decode('utf-8')
            else:
                job["raw_files"][name] = base64.b64encode(content.encode('utf-8')).decode('utf-8')

        # ═══════════════════════════════════════════════════════════════════
        # AGENT 2: UI Generator (optional)
        # ═══════════════════════════════════════════════════════════════════

        if raw_files and not skip_visualization:
            await send_update("Starting UI generator...", "generating_ui")

            async with Evolve(
                config=AGENT_CONFIG,
                sandbox=SANDBOX_CONFIG,
                system_prompt=UI_GENERATOR_PROMPT,
                session_tag_prefix=f"agent-builder-ui-{job_id[:8]}",
            ) as visualizer:

                # Prepare context: original prompt + output files
                context = {
                    "original_prompt.txt": prompt.encode('utf-8') if isinstance(prompt, str) else prompt,
                }
                for name, content in raw_files.items():
                    if isinstance(content, bytes):
                        context[f"outputs/{name}"] = content
                    else:
                        context[f"outputs/{name}"] = content.encode('utf-8')

                await visualizer.upload_context(context)

                await send_update("Generating visualization...")

                viz_prompt = """Create a beautiful HTML visualization for the outputs in the
outputs/ folder. The original user prompt is in original_prompt.txt.

Analyze all the output files and create a compelling, interactive dashboard that:
1. Highlights the key results and insights
2. Uses appropriate visualizations (charts, tables, cards)
3. Follows the Anthropic-inspired design system
4. Is self-contained in a single index.html file

Save your visualization to: output/visualization/index.html"""

                await visualizer.run(prompt=viz_prompt)

                await send_update("Downloading visualization...")
                viz_output = await visualizer.get_output_files(recursive=True)

                # Find the visualization HTML
                viz_html = None
                for name, content in (viz_output.files or {}).items():
                    if name.endswith('.html'):
                        if isinstance(content, bytes):
                            viz_html = content.decode('utf-8')
                        else:
                            viz_html = content
                        break

                if viz_html:
                    job["visualization_html"] = viz_html
                    await send_update("Visualization generated successfully!")
                else:
                    await send_update("Warning: No visualization HTML generated")

        # ═══════════════════════════════════════════════════════════════════
        # Complete
        # ═══════════════════════════════════════════════════════════════════

        job["status"] = "completed"
        job["completed_at"] = datetime.utcnow().isoformat()
        await send_update("Task completed!", "completed")

        if websocket:
            await websocket.send_json({
                "type": "complete",
                "job": {
                    "job_id": job_id,
                    "status": job["status"],
                    "raw_files": list(job["raw_files"].keys()),
                    "has_visualization": job["visualization_html"] is not None,
                }
            })

    except Exception as e:
        job["status"] = "failed"
        job["error"] = str(e)
        job["completed_at"] = datetime.utcnow().isoformat()
        await send_update(f"Error: {str(e)}", "failed")

        if websocket:
            await websocket.send_json({
                "type": "error",
                "error": str(e)
            })

# ─────────────────────────────────────────────────────────────────────────────
# API Routes
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def root():
    """Serve the main HTML page"""
    html_path = Path(__file__).parent / "static" / "index.html"
    if html_path.exists():
        return HTMLResponse(content=html_path.read_text())
    return HTMLResponse(content="<h1>Agent Builder</h1><p>Static files not found</p>")


@app.post("/api/jobs")
async def create_job(
    prompt: str = Form(...),
    files: list[UploadFile] = File(default=[]),
    parent_job_id: Optional[str] = Form(default=None),
    skip_visualization: bool = Form(default=False)
):
    """Create a new job and return the job ID

    If parent_job_id is provided, this is a follow-up request that should
    use the parent job's output files as context.

    If skip_visualization is True, only run the task executor (faster).
    """
    job_id = str(uuid.uuid4())

    # Read uploaded files
    uploaded_files = {}
    for f in files:
        content = await f.read()
        uploaded_files[f.filename] = content

    # If this is a follow-up, get parent job context
    parent_context = {}
    original_prompt = None
    if parent_job_id and parent_job_id in jobs:
        parent_job = jobs[parent_job_id]
        original_prompt = parent_job.get("prompt", "")
        # Get parent's output files as context
        for name, b64_content in parent_job.get("raw_files", {}).items():
            parent_context[name] = base64.b64decode(b64_content)

    # Initialize job
    jobs[job_id] = {
        "job_id": job_id,
        "status": "pending",
        "progress": [],
        "raw_files": {},
        "visualization_html": None,
        "error": None,
        "created_at": datetime.utcnow().isoformat(),
        "completed_at": None,
        "prompt": prompt,
        "uploaded_files": uploaded_files,
        "parent_job_id": parent_job_id,
        "parent_context": parent_context,
        "original_prompt": original_prompt,
        "skip_visualization": skip_visualization,
    }

    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    """Get job status and results"""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[job_id]
    return {
        "job_id": job_id,
        "status": job["status"],
        "progress": job["progress"],
        "raw_files": list(job["raw_files"].keys()),
        "has_visualization": job["visualization_html"] is not None,
        "error": job.get("error"),
        "created_at": job["created_at"],
        "completed_at": job.get("completed_at"),
    }


@app.get("/api/jobs/{job_id}/files/{filename:path}")
async def get_file(job_id: str, filename: str):
    """Get a specific output file"""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[job_id]
    if filename not in job["raw_files"]:
        raise HTTPException(status_code=404, detail="File not found")

    content = base64.b64decode(job["raw_files"][filename])

    # Determine content type
    ext = Path(filename).suffix.lower()
    content_types = {
        ".json": "application/json",
        ".csv": "text/csv",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".html": "text/html",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".pdf": "application/pdf",
    }
    content_type = content_types.get(ext, "application/octet-stream")

    return JSONResponse(
        content={
            "filename": filename,
            "content": job["raw_files"][filename],
            "content_type": content_type,
        }
    )


@app.get("/api/jobs/{job_id}/visualization")
async def get_visualization(job_id: str):
    """Get the generated visualization HTML"""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[job_id]
    if not job["visualization_html"]:
        raise HTTPException(status_code=404, detail="Visualization not available")

    return HTMLResponse(content=job["visualization_html"])


@app.websocket("/ws/{job_id}")
async def websocket_endpoint(websocket: WebSocket, job_id: str):
    """WebSocket endpoint for real-time updates"""
    await websocket.accept()

    if job_id not in jobs:
        await websocket.send_json({"type": "error", "error": "Job not found"})
        await websocket.close()
        return

    job = jobs[job_id]

    # If job is already completed, send the result immediately
    if job["status"] in ("completed", "failed"):
        await websocket.send_json({
            "type": "complete" if job["status"] == "completed" else "error",
            "job": {
                "job_id": job_id,
                "status": job["status"],
                "raw_files": list(job["raw_files"].keys()),
                "has_visualization": job["visualization_html"] is not None,
                "error": job.get("error"),
            }
        })
        await websocket.close()
        return

    # Start keepalive task to prevent connection timeout
    async def keepalive():
        while True:
            await asyncio.sleep(30)  # Send ping every 30 seconds
            try:
                await websocket.send_json({"type": "ping"})
            except:
                break

    keepalive_task = asyncio.create_task(keepalive())

    # Start the agent pipeline
    try:
        prompt = job.get("prompt", "")
        files = job.get("uploaded_files", {})
        parent_context = job.get("parent_context", {})
        original_prompt = job.get("original_prompt")
        skip_visualization = job.get("skip_visualization", False)

        await run_agent_pipeline(
            job_id, prompt, files, websocket,
            parent_context=parent_context,
            original_prompt=original_prompt,
            skip_visualization=skip_visualization
        )

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "error": str(e)})
        except:
            pass
    finally:
        keepalive_task.cancel()
        try:
            await websocket.close()
        except:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Entry Point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    PORT = int(os.getenv("PORT", 8003))

    print("\n" + "="*60)
    print("  Agent Builder - Dynamic AI Visualization")
    print("="*60)
    print(f"\n  Open http://localhost:{PORT} in your browser\n")

    uvicorn.run(app, host="0.0.0.0", port=PORT)
