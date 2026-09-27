# Prime Agent v0.9.6 `--mode json` captures

Real streams from Prime Agent v0.9.6 (release tarballs) run against the Evolve LiteLLM gateway on 2026-09-25 (model `openrouter/deepseek/deepseek-v4.1-flash`, one provider entry in `models.json` named `evolve`), one file per test, read by `tests/unit/prime-agent-parser.test.ts`.

| file | what the run did | exit code |
| --- | --- | --- |
| `tool-use.jsonl` | one `ipython` cell writes and prints `hello.txt`; the kernel bootstrap streams as `tool_execution_update` with `details.status: "starting"` | 0 |
| `resume.jsonl` | the same session resumed with `-r`: only the new user turn streams | 0 |
| `model-error-401.jsonl` | a 401: `stopReason: "error"`, one retry, `auth_stale`, `auto_retry_end.success: false`, exit 0 | 0 |
| `model-error-retries.jsonl` | a 429 then 500s: two `auto_retry_start`, `auto_retry_end.success: false`, exit 0 | 0 |
| `tool-error.jsonl` | a cell raising `CalledProcessError`: `details.status: "error"` while `isError` stays false | 0 |
| `cancelled.jsonl` | SIGINT while a blocking cell ran: the stream ends on `tool_execution_update`, no `tool_execution_end`/`agent_end` | 130 |
| `mcp.jsonl` | MCP through Python (`await mcp.call_tool(...)`): five `ipython` cells, no MCP event of its own | 0 |
| `skills.jsonl` | a project skill read inside an `ipython` cell | 0 |
| `subagents.jsonl` | `await rlm.spawn(...)` / `rlm.collect(...)`: twelve `rlm_child_update`, five `session_action_update`, the child's reply as a `custom` message of type `agent_message` | 0 |

Edits made to the captured bytes, and nothing else:

- paths: the capture host's scratch working directory is `/work`, its scratch home `/root`, its install prefixes `/opt/<name>`;
- `agent_end.messages` is `[]` (the messages already streamed as their own lines);
- the `harness_digest` custom message's `content` is `"[harness-digest]"` and its `details` `{}` (Prime's injected memory preamble, ~2.6 KB per run);
- `message_update.message` keeps only `role`, `model`, `timestamp`, `usage`, `provider` and `api` (Prime repeats the whole cumulative message on every delta; the parser reads only those fields);
- the streamed fragments of an assistant message (`text_delta`, `thinking_delta`, `toolcall_delta`) are re-cut from that message's scrubbed final block: the same number of fragments, joining to the same text as `message_end` (a scratch path had been split across fragments);
- `thinkingSignature` strings over 80 characters and `diagnostics[].error.stack` are `"[elided]"`.

The gateway host never appeared in these streams and no file carries a key.
