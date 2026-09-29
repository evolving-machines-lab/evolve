# pi 0.87.1 `--mode json` captures

Real streams from pi 0.87.1 run against the Evolve LiteLLM gateway on 2026-09-25 (model `openrouter/deepseek/deepseek-v4.1-flash`, one provider entry in `models.json` named `evolve-gateway`), one file per test, read by `tests/unit/pi-parser.test.ts`.

| file | what the run did | exit code |
| --- | --- | --- |
| `tool-use.jsonl` | write `hello.txt`, read it back, answer (tools `write`, `read`) | 0 |
| `resume.jsonl` | the same session resumed with `--session-id`: only the new user turn streams | 0 |
| `model-error-no-retry.jsonl` | one HTTP 500 with retry disabled: `stopReason: "error"`, `agent_end.willRetry: false`, exit 0 | 0 |
| `model-error-retries.jsonl` | a 429 then 500s with retry on: three `auto_retry_start`, `entry_appended` (context_edit), `auto_retry_end.success: false`, exit 0 | 0 |
| `tool-error.jsonl` | `bash` runs `exit 3`: `tool_execution_update` then `tool_execution_end.isError: true` | 0 |
| `cancelled.jsonl` | SIGINT while a `bash` loop ran: the stream ends on `tool_execution_update`, no `turn_end`/`agent_end` | 130 |
| `mcp.jsonl` | pi-mcp-adapter 2.37.0 (`--extension`): five `mcp` proxy calls, the first answered `details.error: "tool_not_found"` with `isError: false` | 0 |
| `skills.jsonl` | a skill in `~/.agents/skills`: loaded with a plain `read` of its `SKILL.md` | 0 |

Edits made to the captured bytes, and nothing else:

- paths: the capture host's scratch working directory is `/work`, its scratch home `/root`, its install prefixes `/opt/<name>`;
- `agent_end.messages` is `[]` (the messages already streamed as their own lines);
- the system message's `sections` is `{}` (pi's system prompt text);
- the streamed fragments of an assistant message (`text_delta`, `thinking_delta`, `toolcall_delta`) are re-cut from that message's scrubbed final block: the same number of fragments, joining to the same text as `message_end` (a scratch path had been split across fragments);
- `thinkingSignature` strings over 80 characters are `"[elided]"`.

The gateway host never appeared in these streams and no file carries a key.
