# Codex CLI capability findings

## Test context

- Observed version: `codex-cli 0.152.1`.
- Follow-up local detection on 2026-09-06 reports `codex-cli 0.152.1`. The npm Windows shim uses Node plus `codex.js`; the adapter now resolves that form with `shell: false` instead of trying to spawn the `.cmd` name directly.
- After the shim fix, the current local smoke returned `OK` through AgentScope and persisted a `completed` Codex session with `thread.started`, `planning`, `agent_message`, and `session_finished` events.
- Real local smoke on 2026-09-06 ran `agent-scope run codex -- "Reply with OK only"` through the `codex exec --json --ephemeral` path. Codex emitted `thread.started`, `turn.started`, an `agent_message` item containing `OK`, and `turn.completed`; the AgentScope session completed successfully and is now stored with `provider=codex`, `adapter=codex-cli`. Host/runtime warnings were observed on stderr and were not parsed as protocol events.
- Structured telemetry normalization on 2026-09-09 now retains a redacted `provider_event` for
  every JSONL record, normalizes `command_execution` items to both command and tool-call
  lifecycle events, and maps `turn.completed.usage` to the shared usage snapshot. Command
  text, prompts, agent message text, and other free-form provider content remain excluded.
- The provider-runner regression on 2026-09-09 exercised the real Windows process/shim path
  with a redacted JSONL fixture and reopened the resulting SQLite database. It confirmed that
  capabilities, usage counters, native event-family counts, tool-call totals, command failure
  status, and the terminal `session_finished` event survive the full adapter-to-storage path.
- Parallel smoke on 2026-09-06 ran Codex beside a Claude Code session against the same AgentScope database. Codex returned `OK` and completed independently; the two sessions retained separate provider labels and timelines.
- Workspace-evidence smoke on 2026-09-06 created/read/deleted a temporary file and ran two successful commands. AgentScope persisted command start/finish evidence (both exit code `0`), filesystem deletion evidence, process lifecycle evidence, and a `completed` session; the workspace and Git tree were clean afterward.
- A real Windows PowerShell Ctrl+C smoke on 2026-09-06 terminated the outer CLI with exit code `1` while Codex was in `Start-Sleep -Seconds 30`. The provider child process ended and process evidence was captured, but the outer CLI could not append a terminal event after console termination, leaving the session temporarily `running`. Running `agent-scope recover` recovered exactly that stale session as `interrupted`. This is the supported Windows recovery path; direct console Ctrl+C still needs a wrapper/console-control improvement before it can be claimed as an atomic terminal transition.
- Host: Windows native PowerShell, disposable repository, non-interactive `codex exec` mode.
- Structured command used: `codex exec --json --ephemeral`.
- Authentication was already configured on the host; no credentials or account details are recorded here.
- Public reference: [Codex CLI reference](https://developers.openai.com/codex/cli/reference).

## Observed event stream

Codex `--json` emits JSONL records. The observed event families were:

| Event family | Observation | V0 classification |
| --- | --- | --- |
| `thread.started` | Contains a provider thread id. | stable enough as an optional metadata field; also counted as a native provider event |
| `turn.started` | Marks the beginning of a model turn. | public structured event; normalized to planning plus a native provider event |
| `item.started` / `item.completed` | Represents work items, including `command_execution`; completion includes status and exit code. | public structured event; normalized to command/tool lifecycle and counted natively |
| `agent_message` item | Final/user-facing response is represented as an item with text. | public structured event; redact text |
| `turn.completed` | Contains usage counters in the observed stream. | terminal envelope; usage is normalized, while cost remains unavailable |

The command-failure run emitted a completed command item with `status=failed` and `exit_code=1`, while the overall structured turn completed. AgentScope must inspect item-level command status instead of treating a completed turn as task success.

## Capability matrix entry

| Capability | Status | Evidence / limitation | Fallback |
| --- | --- | --- | --- |
| Structured events | observed | `--json` JSONL stream from `codex exec` | parse documented item envelopes |
| Tool/command calls | normalized | `command_execution` items expose start/completion, item id, status and exit code; command text is redacted | ProcessObserver/TestObserver |
| File events | indirect | file creation was observed as a command/file-change item, not a dedicated workspace event | FileObserver |
| Session info | observed | `thread.started.thread_id` is available | AgentScope generates its own session id |
| Resume/session id | CLI surface present | `exec resume` and `fork` subcommands are documented; detailed compatibility needs a separate spike | provider id as optional metadata |
| Token usage | normalized | `turn.completed.usage` exposes input/output/cached-input/reasoning counters; `usage_updated` and Dashboard provider telemetry are populated | omit fields not emitted by Codex |
| Token cost | unavailable | no stable cost field was observed in Codex JSONL | do not estimate or infer cost |
| Native event families | normalized | every JSONL record produces a redacted `provider_event`; reducer counts family and phase | safe scalar metadata only |
| Native milestones | not observed | Codex stream fixtures and real smoke did not expose a stable milestone contract | AgentScope progress/activity fallback |
| User interruption | observed with recovery | Ctrl+C during an in-progress command terminated the CLI with process exit code 1; no JSONL terminal event was emitted. AgentScope captured child-process exit and `agent-scope recover` normalized the stale session to `interrupted`. | process/console signal forwarding and atomic terminal persistence remain a V0 hardening item |
| TTY/resize | AgentScope wrapper implemented | `codex-cli-tty` uses the shared node-pty/ConPTY runner; fake PTY covers the `›` prompt and turn boundaries, while authenticated provider/terminal-host acceptance remains pending | use `agent-scope codex`; use structured exec for native JSONL |

## I/O and lifecycle observations

- `--json` is suitable for machine-readable stdout capture; stderr contained host/runtime warnings and must not be parsed as protocol events.
- `--ephemeral` avoids persisting the provider session during the spike; production resume policy remains an AgentScope decision.
- The CLI can report a command failure at item level without making the enclosing turn fail. Adapter normalization therefore needs separate provider-outcome and workspace-verification signals.
- The structured adapter now emits both command and tool-call lifecycle events for each
  `command_execution` item. The duplicate-looking pair is intentional: command events feed
  verification observers, while tool events feed provider telemetry totals.
- During the real Ctrl+C experiment, the process exited with code 1 while the JSONL stream ended after an in-progress command item. The provider child was gone and the observer recorded `process finished`, but the outer CLI was also terminated before it could persist `session_finished`; `agent-scope recover` then marked the stale session `interrupted`. Absence of `turn.completed` is therefore not itself a provider failure.
- Codex CLI help exposed a stable `exec` command and an experimental `app-server` command; V0 uses `exec` and does not depend on app-server.
- The interactive wrapper is deliberately separate from the structured adapter: it forwards
  Codex's native TTY and derives only conservative local turn/observer signals.
- The TTY wrapper does not claim the structured-only usage/tool/milestone fields; use
  `agent-scope run codex -- ...` when provider-native JSONL telemetry is required.

## Fixture policy

`tests/fixtures/raw/codex-cli/` contains redacted representative event shapes only. It excludes prompts, command text, absolute paths, thread UUIDs, real usage values, and full agent messages. The interrupted fixture intentionally ends at an in-progress command because no provider terminal record was emitted.
