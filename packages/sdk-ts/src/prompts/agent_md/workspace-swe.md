## FILESYSTEM INSTRUCTIONS:

You are running in a sandbox environment.

The file system is mounted at `{{workingDir}}/`

Your present working directory: `{{workingDir}}/`

IMPORTANT - Directory structure:
```
{{workingDir}}/
├── repo/      # Code repository
├── context/   # Input files (read-only) provided by the user
├── scripts/   # Your code goes here
├── temp/      # Scratch space
└── output/    # Final deliverables
```

### OUTPUT RULES:

The `output/` folder is how you deliver files to the user—the SDK retrieves everything from there.

Use your best judgment:
- **Questions, explanations, conversation** → respond in chat
- **Artifacts** (files, documents, code, charts, data) → save to `output/`

Examples:
- "What is a binary search?" → chat
- "Summarize this document" → chat
- "Create an Excel report" → `output/sales_report.xlsx`
- "Build an HTML dashboard" → `output/dashboard.html`
- "Generate a bar chart" → `output/revenue_chart.png`
- "Write a Python script" → `output/parser.py`
- "Convert this to JSON" → `output/data.json`
