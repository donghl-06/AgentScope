# Claude Code CLI capability findings

## Test context

- Observed version: `2.1.259 (Claude Code)`.
- Follow-up manual smoke on 2026-09-05 observed `2.1.261 (Claude Code)` with the configured compatible endpoint/model. The minimal `--bare -p` request completed successfully through AgentScope; no raw output is stored because it contained thinking signatures, usage/cost fields and provider diagnostics.
- Host: Windows native PowerShell, disposable repository, non-interactive `--bare -p` mode.
- Structured command used: `--output-format stream-json --verbose`.
- The provider endpoint/model were supplied through the local experiment environment and are intentionally not recorded here.
- The observation target is the local Claude Code CLI process, not Anthropic's API account. The CLI may use a compatible alternate endpoint and model; capability claims are therefore scoped to the tested CLI version, mode, endpoint configuration, and model combination.
- Public reference: [Claude Code CLI usage](https://docs.anthropic.com/en/docs/claude-code/cli-usage).

## Observed event stream

The stream is JSONL. The observed event families were:

| Event family | Observation | V0 classification |
| --- | --- | --- |
| `system/init` | Includes provider session id, working directory, model label, permission mode, CLI version and capability labels. | observed-but-unstable; use only a small allow-list |
| `system/thinking_tokens` | Incremental estimated-token telemetry was emitted. | public output shape observed; not a V0 product signal |
| `assistant` | Contains `thinking`, `text`, and `tool_use` content blocks. | structured event; provider-specific parser input |
| `user` | Tool-result messages can follow a tool call. | structured event; provider-specific parser input |
| `result` | Includes `subtype`, `is_error`, `num_turns`, `duration_ms`, and sometimes cost metadata. | terminal envelope; inspect nested tool outcomes too |

The successful minimal run produced a `result` with `subtype=success`, one turn, and no tool call. A second run created a file and ran a deliberately failing test command. Its process completed and its top-level `result` was still `success`, while the command result represented the test failure. Therefore an adapter must not infer task success from the top-level `result` alone.

## Capability matrix entry

| Capability | Status | Evidence / limitation | Fallback |
| --- | --- | --- | --- |
| Structured events | observed | JSONL stream is available in print mode | parse `assistant`/`user`/`result` allow-list |
| Tool calls | observed | `assistant.message.content[].type=tool_use` was emitted | process + workspace observers |
| File events | indirect | file modification was visible through a Bash tool call, not a dedicated file event | FileObserver |
| Command events | observed | Bash tool call and tool result were emitted | ProcessObserver/TestObserver |
| Session info | observed | `system/init` exposes a provider session id | AgentScope generates its own session id |
| Resume/session id | CLI surface present | `--continue`, `--resume`, and background attach are documented by `--help`; resume semantics still need a dedicated spike | treat provider id as optional metadata |
| Hooks | CLI surface present | hooks are documented by the CLI, but no hook contract was made a V0 dependency | process/workspace observers |
| Token/cost | observed-but-out-of-scope | telemetry may appear in terminal result; privacy and stability are insufficient for V0 | ignore by default |
| User interruption | pending | interactive trust-screen cancellation was observed, but no reliable structured Ctrl+C fixture was captured | process signal handling in Phase 5 |

## I/O and lifecycle observations

- Structured output was emitted to stdout as JSONL; CLI diagnostics/warnings were emitted separately on stderr.
- Unicode and path details were not promoted into the fixture because absolute user paths must not leave the experiment machine.
- The CLI accepted non-interactive print mode with `--bare`; the interactive mode has a workspace trust gate.
- The observed tool/test failure demonstrates that AgentScope needs its own lifecycle mapping based on command outcomes, exit code, and interruption signals.
- The current experiment did not establish a stable public contract for every `system` field. Unknown fields must be ignored and retained only inside the adapter boundary when needed for diagnostics.
- The follow-up smoke emitted a non-fatal `unrecognized_model` diagnostic during session-title generation, then returned a normal assistant response and terminal success. AgentScope persisted the session as `completed` with progress `0.35`, confidence `0.55`, and a completion-unverified reason because no test/build/typecheck verification occurred; this is the expected V0 safety cap, not a parser failure. The persisted normalized timeline contained exactly `session_started → agent_message → session_finished` (3 events).

## Fixture policy

`tests/fixtures/raw/claude-code/` contains only representative, redacted event shapes. It deliberately excludes prompts, command text, working directories, session UUIDs, API metadata, and full tool output. A real interrupted fixture remains a Phase 0 follow-up item.
