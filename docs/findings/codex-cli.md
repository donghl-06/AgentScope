# Codex CLI capability findings

## Test context

- Observed version: `codex-cli 0.152.1`.
- Host: Windows native PowerShell, disposable repository, non-interactive `codex exec` mode.
- Structured command used: `codex exec --json --ephemeral`.
- Authentication was already configured on the host; no credentials or account details are recorded here.
- Public reference: [Codex CLI reference](https://developers.openai.com/codex/cli/reference).

## Observed event stream

Codex `--json` emits JSONL records. The observed event families were:

| Event family | Observation | V0 classification |
| --- | --- | --- |
| `thread.started` | Contains a provider thread id. | stable enough as an optional metadata field |
| `turn.started` | Marks the beginning of a model turn. | public structured event |
| `item.started` / `item.completed` | Represents work items, including `command_execution`; completion includes status and exit code. | public structured event; primary parser input |
| `agent_message` item | Final/user-facing response is represented as an item with text. | public structured event; redact text |
| `turn.completed` | Contains usage counters in the observed stream. | terminal envelope; usage is out of V0 scope |

The command-failure run emitted a completed command item with `status=failed` and `exit_code=1`, while the overall structured turn completed. AgentScope must inspect item-level command status instead of treating a completed turn as task success.

## Capability matrix entry

| Capability | Status | Evidence / limitation | Fallback |
| --- | --- | --- | --- |
| Structured events | observed | `--json` JSONL stream from `codex exec` | parse documented item envelopes |
| Tool/command calls | observed | `command_execution` items expose start/completion and exit code | ProcessObserver/TestObserver |
| File events | indirect | file creation was observed as a command/file-change item, not a dedicated workspace event | FileObserver |
| Session info | observed | `thread.started.thread_id` is available | AgentScope generates its own session id |
| Resume/session id | CLI surface present | `exec resume` and `fork` subcommands are documented; detailed compatibility needs a separate spike | provider id as optional metadata |
| Token/cost | observed-but-out-of-scope | `turn.completed.usage` contains counters; no cost contract assumed | ignore by default |
| User interruption | pending | no reliable structured Ctrl+C fixture was captured in this spike | process signal handling in Phase 5 |
| TTY/resize | unavailable | this spike used non-interactive exec; interactive resize behavior remains unverified | document non-interactive V0 path |

## I/O and lifecycle observations

- `--json` is suitable for machine-readable stdout capture; stderr contained host/runtime warnings and must not be parsed as protocol events.
- `--ephemeral` avoids persisting the provider session during the spike; production resume policy remains an AgentScope decision.
- The CLI can report a command failure at item level without making the enclosing turn fail. Adapter normalization therefore needs separate provider-outcome and workspace-verification signals.
- Codex CLI help exposed a stable `exec` command and an experimental `app-server` command; V0 uses `exec` and does not depend on app-server.

## Fixture policy

`tests/fixtures/raw/codex-cli/` contains redacted representative event shapes only. It excludes prompts, command text, absolute paths, thread UUIDs, usage values, and full agent messages. A real interrupted fixture remains a Phase 0 follow-up item.

