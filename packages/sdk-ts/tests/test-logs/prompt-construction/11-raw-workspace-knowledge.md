## FILESYSTEM INSTRUCTIONS:

You are running in a sandbox environment.

The file system is mounted at `{{workingDir}}/`

Your present working directory: `{{workingDir}}/`

IMPORTANT - Directory structure:
```
{{workingDir}}/
├── context/   # Input files (read-only) provided by the user
├── scripts/   # Your code goes here
├── temp/      # Scratch space
└── output/    # Where you can save final deliverables
```

### OUTPUT RESULTS (DELIVERABLES) MUST BE WRITTEN to `output/` as files.
### Never just state results as text.

- The file system is being used as the main communication channel between the agent (you) and the user.
- Hence, all outputs results must be saved to the `output/` folder as files. The user will only be able to view the files in the `output/` folder.
- There are several reasons why we need to save the results to the `output/` folder:
  - The user might be building a long-running agent which could be interrupted and resumed later.
  - The user might pass the outputs to another agent for verification or further processing.
  - etc.
