#!/usr/bin/env python3
"""
Multi-Agent Web App Builder

A 3-agent workflow that:
1. Ideator: Generates creative web app ideas (best of 3)
2. Implementer: Builds the app with iterative improvements
3. Tester: Runs the app, tests it, provides structured feedback

Demonstrates: Evolve, Swarm.best_of, Pydantic schemas, feedback loops

Run: python webapp_builder.py
"""

import asyncio
import os
import json
from typing import Optional
from dataclasses import dataclass
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.markdown import Markdown

from evolve import (
    Evolve,
    Swarm,
    SwarmConfig,
    AgentConfig,
    E2BProvider,
    BestOfConfig,
    save_local_dir,
)

load_dotenv()

console = Console()

# ─────────────────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────────────────

class AppIdea(BaseModel):
    """Schema for the ideator agent's output."""
    name: str = Field(description="Creative name for the web app")
    tagline: str = Field(description="One-line description")
    description: str = Field(description="2-3 sentence description of what the app does")
    features: list[str] = Field(description="5-8 key features including data persistence")
    tech_stack: str = Field(description="Python backend (FastAPI or Flask) + SQLite + vanilla JS frontend")
    database_tables: list[str] = Field(description="Main database tables/models needed")
    api_endpoints: list[str] = Field(description="Key REST API endpoints")


class TestReport(BaseModel):
    """Schema for the tester agent's output."""
    passed: bool = Field(description="Whether the app works correctly overall")
    server_starts: bool = Field(description="Whether the backend server starts without errors")
    api_works: bool = Field(description="Whether the API endpoints respond correctly")
    database_works: bool = Field(description="Whether database CRUD operations work")
    frontend_works: bool = Field(description="Whether the frontend loads and communicates with API")
    errors: list[str] = Field(default_factory=list, description="List of errors encountered")
    suggestions: list[str] = Field(default_factory=list, description="Specific suggestions to fix issues")
    notes: str = Field(default="", description="Additional observations")


# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

SANDBOX = E2BProvider(
    api_key=os.getenv("E2B_API_KEY"),
    timeout_ms=900_000,  # 15 min per agent (longer for Docker builds)
)

# You can use different models for different agents
IDEATOR_CONFIG = AgentConfig(
    type="claude",
    api_key=os.getenv("EVOLVE_API_KEY"),
)

IMPLEMENTER_CONFIG = AgentConfig(
    type="claude",
    api_key=os.getenv("EVOLVE_API_KEY"),
)

TESTER_CONFIG = AgentConfig(
    type="claude",
    api_key=os.getenv("EVOLVE_API_KEY"),
)

# MCP servers for browser testing
MCP_SERVERS = {
    "chrome-devtools": {
        "command": "npx",
        "args": [
            "chrome-devtools-mcp@latest",
            "--headless=true",
            "--isolated=true",
            "--chromeArg=--no-sandbox",
            "--chromeArg=--disable-setuid-sandbox",
            "--chromeArg=--disable-dev-shm-usage",
        ],
        "env": {}
    }
}

MAX_ITERATIONS = 3


# ─────────────────────────────────────────────────────────────────────────────
# Main Workflow
# ─────────────────────────────────────────────────────────────────────────────

async def run_webapp_builder(theme: Optional[str] = None):
    """Run the 3-agent web app builder workflow."""

    console.print()
    console.print(Panel.fit(
        "[bold cyan]Web App Builder[/bold cyan]\n"
        "[dim]3-Agent Workflow: Ideator -> Implementer -> Tester[/dim]",
        border_style="cyan",
    ))
    console.print()

    # Build the brief
    brief = "Create a full-stack web application with database persistence."
    if theme:
        brief += f" Theme: {theme}."
    brief += """
Requirements:
- Full-stack app with Python REST API backend (FastAPI or Flask)
- SQLite database for data persistence
- Frontend served by the same Python server (static files)
- Clean architecture with clear separation of concerns
- CRUD operations on at least one main resource
- Be creative with the concept - make it interesting and useful
- Single `python app.py` should start everything
"""

    # =========================================================================
    # PHASE 1: Ideation (Best of 3)
    # =========================================================================

    console.print("[bold]Phase 1: Ideation[/bold]")
    console.print("[dim]Generating 3 ideas and selecting the best one...[/dim]")
    console.print()

    swarm = Swarm(SwarmConfig(
        sandbox=SANDBOX,
        agent=IDEATOR_CONFIG,
        concurrency=3,
        tag="webapp-builder",
    ))

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
    ) as progress:
        task = progress.add_task("Brainstorming ideas...", total=None)

        idea_result = await swarm.best_of(
            item={"brief.txt": brief},
            prompt="""Read the brief and generate a unique, creative full-stack web app idea.
Be inventive - think of something useful, interesting, or solves a real problem.
Avoid generic ideas like "todo list" or "blog". Think of novel applications.

The app should have:
- A clear data model with 2-3 database tables
- RESTful API endpoints for CRUD operations
- A modern, responsive frontend

Write your idea to output/result.json following the schema exactly.""",
            config=BestOfConfig(
                n=3,
                judge_criteria="""Evaluate based on:
1. Creativity and usefulness (35%)
2. Technical feasibility with Docker/DB (35%)
3. Clear data model and API design (30%)
Pick the idea that is most interesting while being realistically implementable.""",
                on_candidate_complete=lambda i, c, s:
                    progress.update(task, description=f"Idea {c+1}/3 {'generated' if s == 'success' else 'failed'}"),
                on_judge_complete=lambda i, w, r:
                    progress.update(task, description=f"Judge selected idea {w+1}"),
            ),
            schema=AppIdea,
        )

        progress.update(task, description="Ideation complete!")

    if idea_result.winner.status != "success" or not idea_result.winner.data:
        console.print("[red]Failed to generate ideas. Exiting.[/red]")
        await swarm.close()
        return None

    idea: AppIdea = idea_result.winner.data

    # Display the winning idea
    idea_table = Table(title=f"[bold green]Selected: {idea.name}[/bold green]", show_header=False, border_style="green")
    idea_table.add_column("Field", style="cyan")
    idea_table.add_column("Value")
    idea_table.add_row("Tagline", idea.tagline)
    idea_table.add_row("Description", idea.description)
    idea_table.add_row("Features", "\n".join(f"- {f}" for f in idea.features[:5]))
    idea_table.add_row("Tech Stack", idea.tech_stack)
    idea_table.add_row("DB Tables", ", ".join(idea.database_tables))
    idea_table.add_row("API Endpoints", "\n".join(idea.api_endpoints[:5]))
    console.print(idea_table)
    console.print()

    console.print(f"[dim]Judge reasoning: {idea_result.judge_reasoning[:200]}...[/dim]")
    console.print()

    # =========================================================================
    # PHASE 2 & 3: Implementation + Testing Loop
    # =========================================================================

    console.print("[bold]Phase 2 & 3: Implementation + Testing[/bold]")
    console.print(f"[dim]Up to {MAX_ITERATIONS} iterations with feedback...[/dim]")
    console.print()

    feedback_history: list[TestReport] = []
    final_files: dict[str, str | bytes] = {}
    success = False

    for iteration in range(MAX_ITERATIONS):
        console.print(Panel(
            f"[bold]Iteration {iteration + 1}/{MAX_ITERATIONS}[/bold]",
            border_style="blue",
        ))

        # Build implementation prompt
        impl_prompt = f"""Implement this full-stack web application:

## App Details
- **Name**: {idea.name}
- **Tagline**: {idea.tagline}
- **Description**: {idea.description}
- **Features**: {', '.join(idea.features)}
- **Tech Stack**: {idea.tech_stack}
- **Database Tables**: {', '.join(idea.database_tables)}
- **API Endpoints**: {', '.join(idea.api_endpoints)}

## Requirements
1. Python backend with REST API (FastAPI preferred, or Flask)
2. SQLite database with proper schema
3. Frontend (HTML/CSS/JS) served as static files
4. Everything runs with: `pip install -r requirements.txt && python app.py`

## Required Files (save ALL to output/ folder)
```
output/
├── app.py              # Main application (API + serves static files)
├── models.py           # SQLAlchemy models
├── requirements.txt    # Python dependencies
├── static/
│   ├── index.html      # Main HTML page
│   ├── style.css       # Styles
│   └── app.js          # Frontend JavaScript (API calls, UI logic)
└── README.md           # How to run instructions
```

## Technical Guidelines
- Use FastAPI with SQLAlchemy and SQLite (or Flask if simpler)
- Serve static files from the same server (FastAPI StaticFiles or Flask static)
- Include CORS middleware for API
- Create database tables on startup if they don't exist
- API should be RESTful: GET, POST, PUT, DELETE
- Frontend should use fetch() to call the API
- Make it visually appealing with good CSS

IMPORTANT: Create ALL files. The app MUST work with just `python app.py` after installing requirements.
"""

        if feedback_history:
            last_feedback = feedback_history[-1]
            impl_prompt += f"""

## PREVIOUS ATTEMPT FAILED - FIX THESE ISSUES:

### Errors:
{chr(10).join(f'- {err}' for err in last_feedback.errors) or '- No specific errors logged'}

### Tester's Suggestions:
{chr(10).join(f'- {s}' for s in last_feedback.suggestions) or '- No suggestions'}

### Notes:
{last_feedback.notes or 'None'}

IMPORTANT: Address ALL the issues above. The same problems must not occur again.
"""

        # ----- IMPLEMENTER AGENT -----
        console.print("[cyan]Implementer[/cyan] is coding...")

        async with Evolve(
            config=IMPLEMENTER_CONFIG,
            sandbox=SANDBOX,
            system_prompt="""You are an expert web developer. Write clean, working code.
Always test your logic mentally before writing. Create complete, runnable applications.
When fixing bugs, carefully read the error messages and fix the root cause.""",
            session_tag_prefix=f"impl-v{iteration+1}",
        ) as implementer:

            result = await implementer.run(prompt=impl_prompt)
            impl_output = await implementer.get_output_files(recursive=True)
            final_files = impl_output.files

            if result.exit_code != 0:
                console.print(f"[yellow]  Warning: Implementer exited with code {result.exit_code}[/yellow]")

            console.print(f"[green]  Created {len(final_files)} files[/green]")
            for name in list(final_files.keys())[:5]:
                console.print(f"[dim]    - {name}[/dim]")
            if len(final_files) > 5:
                console.print(f"[dim]    ... and {len(final_files) - 5} more[/dim]")

        # ----- TESTER AGENT -----
        console.print("[cyan]Tester[/cyan] is testing...")

        async with Evolve(
            config=TESTER_CONFIG,
            sandbox=SANDBOX,
            files=final_files,  # Upload implementer's output
            system_prompt="""You are a thorough QA engineer. Test applications carefully.
Run the app, check for errors, verify functionality works.
Provide specific, actionable feedback when things fail.""",
            schema=TestReport,
            mcp_servers=MCP_SERVERS,
            session_tag_prefix=f"test-v{iteration+1}",
        ) as tester:

            await tester.run(prompt="""Test this full-stack Python application thoroughly:

1. Check the file structure:
   - ls -laR to see all files
   - Verify app.py, models.py, requirements.txt exist
   - Check static/ directory has index.html, style.css, app.js

2. Install dependencies and start the server:
   - pip install -r requirements.txt
   - python app.py &
   - Wait 5 seconds for server to start

3. Test the API:
   - curl http://localhost:8000/docs (if FastAPI) or health endpoint
   - Test CRUD endpoints with curl:
     - POST to create data
     - GET to read data
     - PUT to update data
     - DELETE to remove data
   - Verify data persists in database

4. Test the Frontend:
   - curl http://localhost:8000/ or http://localhost:8000/static/index.html
   - Use chrome-devtools MCP to browse the UI
   - Test that frontend can call the API and display data
   - Test the main user interactions

5. Write your test report to output/result.json with:
   - passed: true/false (overall - true only if everything works)
   - server_starts: did the Python server start without errors?
   - api_works: do all the API endpoints work correctly?
   - database_works: does data persist after create/read/update/delete?
   - frontend_works: does the frontend load and communicate with API?
   - errors: list specific errors found
   - suggestions: specific fixes if it failed
   - notes: observations about the app quality
""")

            test_output = await tester.get_output_files()

        # Process test results
        if test_output.data:
            report: TestReport = test_output.data

            status_color = "green" if report.passed else "red"
            console.print(f"[{status_color}]  Result: {'PASSED' if report.passed else 'FAILED'}[/{status_color}]")
            console.print(f"[dim]    Server starts: {report.server_starts}[/dim]")
            console.print(f"[dim]    API works: {report.api_works}[/dim]")
            console.print(f"[dim]    Database works: {report.database_works}[/dim]")
            console.print(f"[dim]    Frontend works: {report.frontend_works}[/dim]")

            if report.passed:
                success = True
                console.print()
                console.print(Panel(
                    f"[bold green]SUCCESS![/bold green]\n\n"
                    f"Built [cyan]{idea.name}[/cyan] in {iteration + 1} iteration(s).\n\n"
                    f"Run with: [cyan]cd output && pip install -r requirements.txt && python app.py[/cyan]\n\n"
                    f"[dim]{report.notes}[/dim]",
                    border_style="green",
                ))
                break
            else:
                console.print(f"[yellow]  Errors: {', '.join(report.errors[:2]) or 'None logged'}[/yellow]")
                feedback_history.append(report)
        else:
            console.print(f"[yellow]  Tester failed to produce valid report: {test_output.error}[/yellow]")
            feedback_history.append(TestReport(
                passed=False,
                server_starts=False,
                api_works=False,
                database_works=False,
                frontend_works=False,
                errors=["Tester crashed or produced invalid output"],
                suggestions=["Check app.py syntax and requirements.txt dependencies"],
            ))

        console.print()

    await swarm.close()

    # =========================================================================
    # Save Results
    # =========================================================================

    if final_files:
        save_local_dir("output", final_files)
        console.print(f"[green]Saved {len(final_files)} files to output/[/green]")

        # Also save the idea
        with open("output/idea.json", "w") as f:
            json.dump(idea.model_dump(), f, indent=2)
        console.print("[green]Saved idea.json[/green]")

    return {
        "idea": idea,
        "files": final_files,
        "iterations": iteration + 1,
        "success": success,
        "feedback_history": [r.model_dump() for r in feedback_history],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Entry Point
# ─────────────────────────────────────────────────────────────────────────────

async def main():
    """Main entry point with optional theme input."""
    console.print()
    theme = console.input("[bold]Enter a theme (or press Enter for random): [/bold]").strip()

    result = await run_webapp_builder(theme if theme else None)

    if result:
        console.print()
        if result["success"]:
            console.print("[bold green]Build complete![/bold green]")
            console.print(f"[dim]Check the output/ folder for your app.[/dim]")
        else:
            console.print(f"[bold yellow]Build incomplete after {result['iterations']} iterations.[/bold yellow]")
            console.print("[dim]Check output/ for the latest attempt.[/dim]")


if __name__ == "__main__":
    os.makedirs("output", exist_ok=True)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        console.print("\n[dim]Cancelled.[/dim]")
