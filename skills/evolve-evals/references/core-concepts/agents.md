---
title: "Agents"
description: "Choose a built-in coding-agent harness or register your own."
---

An evaluation arm pairs an **agent harness** with a **model**. The harness reads the instruction, calls tools, and manages the conversation. The model supplies its decisions.

```text
One arm
├── Harness: -a codex
└── Model: -m gpt-5.6-luna
```

## Built-in harnesses

| CLI name | Harness |
| --- | --- |
| `claude` | Claude Code |
| `codex` | Codex |
| `gemini` | Gemini CLI |
| `qwen` | Qwen Code |
| `kimi` | Kimi Code |
| `opencode` | OpenCode |
| `droid` | Droid |
| `pi` | pi |
| `prime-agent` | Prime Agent |

```bash
evolve run -d harbor-examples@1.0 -i hello-world \
  -a codex -m gpt-5.6-luna \
  --max-trial-spend 1 --max-retries 0 --watch
```

Use `-a name@version` to pin a harness release. Without a version, Evolve resolves one at job creation and uses that version across the job. The trial records it in `agent_info.version`.

## Configure an arm

| Option | Purpose |
| --- | --- |
| `--effort <value>` | Set supported reasoning effort |
| `--preset no-internet` | Disable vendor server-side web tools |
| `--preset pinned-context` | Set the supported context window to 200,000 tokens |
| `--ak config=<path-or-JSON>` | Supply a native harness configuration |

Presets and native config are supported on Claude Code and Codex. The platform applies routing settings over your config, and preset settings take precedence where they overlap. Routing, billing, credential, and environment overrides are rejected.

The live [capability document](/sdk-reference/meta) lists each harness's supported options. Unsupported effort or configuration is rejected when the job is created.

**Note:**

`no-internet` disables the harness's server-side web tools. The task's [network policy](/core-concepts/task-config#network-access) controls network access from the sandbox.

## Register a custom agent

Register an installation source and a command. The name then works with `-a`.

```bash
evolve agent add my-agent \
  --install-script ./install.sh \
  --run "my-agent --headless"
```

Use `--dir` instead of `--install-script` to upload a directory. The install runs with internet access and no secrets; place executables in `$PREFIX/bin`.

### Execution contract

1. Install the agent from its registered source.

2. Prepare the instruction file and gateway environment.

3. Start `run_command` with `sh -c` in the task working directory, with the instruction on stdin.

4. Route model calls through the supplied gateway credentials.

5. Collect outputs and run the task verifier.

| Input | Meaning |
| --- | --- |
| Standard input | Task instruction |
| `EVOLVE_INSTRUCTION_FILE` | Path to the same instruction |
| `EVOLVE_MODEL` | Model selected for this arm |
| `EVOLVE_GATEWAY_BASE_URL` | OpenAI-compatible URL, including `/v1` |
| `EVOLVE_GATEWAY_API_KEY` | Gateway credential |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY` | Aliases for the same gateway values |

Your agent must use these gateway settings for metered model calls. If it requires a config file, write that file from these values inside `run_command`.

`--agent-env KEY=VALUE` adds non-secret runtime settings to the registration. It cannot override the contract variables or declare credential-like names. Attach [job secrets](/core-concepts/secrets) for credentials the task needs.

### Custom-agent differences

Custom agents do not have a built-in live trace parser or the shared `--effort` option. Put implementation-specific reasoning flags in the run command. Harness version pins are not accepted for registrations.

Registrations belong to a user and an organization. Members can use them; the owner manages them. Deleting one preserves historical job records.

**[Agent commands](/cli-reference/agent)**

Register, inspect, and remove a custom agent.
