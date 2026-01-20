# Evolve SDK Reference

## Installation
```bash
pip install evolve-sdk fastapi uvicorn python-dotenv
```

## Environment Variables (.env file)
```
EVOLVE_API_KEY=your_evolve_api_key
```

## Basic Usage Pattern

```python
import asyncio
import os
from dotenv import load_dotenv
from evolve import Evolve, AgentConfig

load_dotenv()

# Configure the agent
agent = Evolve(
    config=AgentConfig(
        type="claude",  # or "gemini", "codex"
        api_key=os.getenv("EVOLVE_API_KEY"),
    ),
    system_prompt="You are an expert developer. Write clean, working code.",
)

async def main():
    # Run the agent with a prompt
    result = await agent.run(prompt="Create a simple HTML page with a counter button")

    # Get output files the agent created
    output = await agent.get_output_files(recursive=True)

    # Access the files
    for filename, content in output.files.items():
        print(f"Generated: {filename}")
        # content is bytes or str

    # Clean up
    await agent.kill()

asyncio.run(main())
```

## FastAPI Integration Example

```python
from fastapi import FastAPI, Form
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import asyncio
import os
import base64
from dotenv import load_dotenv
from evolve import Evolve, AgentConfig

load_dotenv()

app = FastAPI()

# Store results in memory (use Redis in production)
results = {}

AGENT_CONFIG = AgentConfig(
    type="claude",
    api_key=os.getenv("EVOLVE_API_KEY"),
)

@app.post("/api/generate")
async def generate_app(prompt: str = Form(...)):
    """Generate an app from a natural language prompt"""

    async with Evolve(
        config=AGENT_CONFIG,
        system_prompt="""You are an expert web developer.
Generate beautiful, complete, self-contained HTML applications.
Always save your output to: output/index.html
Use inline CSS and JavaScript. Make the design modern and polished.""",
    ) as agent:

        await agent.run(prompt=f"Create this app: {prompt}")
        output = await agent.get_output_files(recursive=True)

        # Find the HTML file
        html_content = None
        for name, content in (output.files or {}).items():
            if name.endswith('.html'):
                if isinstance(content, bytes):
                    html_content = content.decode('utf-8')
                else:
                    html_content = content
                break

        return JSONResponse({
            "success": True,
            "html": html_content,
            "files": list(output.files.keys()) if output.files else []
        })

@app.get("/", response_class=HTMLResponse)
async def home():
    return """
    <!DOCTYPE html>
    <html>
    <head><title>App Generator</title></head>
    <body>
        <h1>Describe your app</h1>
        <form action="/api/generate" method="post">
            <textarea name="prompt" rows="4" cols="50"></textarea>
            <button type="submit">Generate</button>
        </form>
    </body>
    </html>
    """

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

## Key Points

1. **Always use async/await** - Evolve is async-first
2. **Use context manager** - `async with Evolve(...) as agent:` handles cleanup
3. **Output files** - Agent saves files to `output/` folder, retrieve with `get_output_files()`
4. **System prompt** - Customize agent behavior with system_prompt parameter
5. **Environment variables** - Always load API keys from .env file using python-dotenv
