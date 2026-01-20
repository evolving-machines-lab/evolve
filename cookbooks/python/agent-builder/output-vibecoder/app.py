from fastapi import FastAPI, Form, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import os
import asyncio
from dotenv import load_dotenv
from evolve import Evolve, AgentConfig, E2BProvider

load_dotenv()

app = FastAPI(title="VibeCoder", description="AI App Builder")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/generate")
async def generate(prompt: str = Form(...)):
    """Generate an HTML app from a natural language description."""
    try:
        async with Evolve(
            config=AgentConfig(type="claude", api_key=os.getenv("EVOLVE_API_KEY")),
            sandbox=E2BProvider(api_key=os.getenv("E2B_API_KEY"), timeout_ms=300000),
            system_prompt="You are an expert web developer. Create beautiful, complete HTML apps with inline CSS/JS. Save to output/index.html",
        ) as agent:
            await agent.run(prompt=prompt)
            output = await agent.get_output_files(recursive=True)
            html = None
            for name, content in (output.files or {}).items():
                if name.endswith('.html'):
                    html = content.decode('utf-8') if isinstance(content, bytes) else content
                    break
            return JSONResponse(content={"html": html or "<p>No output generated</p>"})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Mount static files (must be after API routes)
app.mount("/", StaticFiles(directory="static", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=9000)

