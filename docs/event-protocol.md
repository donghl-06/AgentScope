# Unified event protocol (V0)

`@agentscope/protocol` is the only event contract consumed by Core, Storage, API, and Dashboard. Provider adapters normalize their own output into this contract before events cross the adapter boundary.

## Event envelope

Every event carries:

- a producer-owned `id` for deduplication;
- an AgentScope-owned `sessionId`;
- a Unix timestamp in milliseconds;
- `source` metadata (`provider`, `client`, `environment`, and `adapter`);
- one of the versioned `type` values;
- a typed `payload` selected by event type;
- `confidence` in the inclusive range 0..1;
- an optional `rawRef` pointing to opt-in raw storage rather than embedding provider output.

The protocol does not contain provider-specific event names or payload fields. Unknown provider fields stay inside the adapter or are reduced to safe metadata before normalization.

## Event categories

| Category | Types |
| --- | --- |
| Lifecycle | `session_started`, `session_finished`, `blocked`, `unblocked`, `error` |
| Agent activity | `planning`, `agent_message`, `tool_call_started`, `tool_call_finished` |
| Workspace | `file_read`, `file_write` |
| Commands/tests | `command_started`, `command_finished`, `test_started`, `test_passed`, `test_failed` |
| Planning milestones | `milestone_started`, `milestone_completed` |
| Provider observability | `provider_info`, `provider_event`, `usage_updated` |

`session_finished` always includes a normalized `reason`. An adapter may additionally provide an exit code and a short provider outcome label; full stdout, prompts, secrets, and raw provider usage records are not part of the default payload.

## Provider observability

The provider-observability events are intentionally normalized and additive:

- `provider_info` records safe session metadata such as the provider session id,
  model, CLI version, permission mode, output format, and capability/catalog
  counts. It does not contain prompts, environment values, or credentials.
- `usage_updated` carries cumulative token, cache, thinking/reasoning, cost,
  service-tier, and latency snapshots when the provider emits them. Known Claude
  timing fields include API duration, time-to-first-token, stream TTFT, first
  content frame, queue depth, iterations, speed, provider turn count, permission
  denial count, and terminal mode/error context. Missing fields remain missing;
  the adapter never estimates a provider-reported counter.
- `provider_event` preserves the provider event family and a phase/subtype plus
  a small scalar metadata allow-list. This keeps native event coverage useful for
  diagnostics without persisting raw JSONL, tool input, command text, output,
  transcript content, or private reasoning.

Tool calls are represented by the existing `tool_call_started` and
`tool_call_finished` events. The normalized payload contains the tool name,
optional provider call id, success/error status, and duration; command/input and
full tool output are intentionally excluded. Core also projects started,
finished, and failed tool totals into `SessionState.telemetry`.

Claude's JSONL stream does not currently promise a future completion ETA or a
stable native milestone protocol. AgentScope records all observed timing fields
and maps explicit `milestone_started`/`milestone_completed` records when they are
present. Dashboard ETA remains an explainable estimate unless the provider emits
an actual ETA signal.

## Session state

`SessionState` is the provider-neutral projection maintained by Core. It uses `starting`, `running`, `blocked`, `completed`, `failed`, and `interrupted` statuses. Only terminal statuses may carry `endedAt`; a terminal state cannot be reopened by an ordinary activity event. Progress and ETA results expose a numeric value/range, confidence, and structured `{code, message}` reasons. Verification starts as `unknown` and is updated by objective test/build/typecheck signals.

The canonical normalized fixtures under `tests/fixtures/normalized/protocol/` are validated in the protocol test suite. V0 compatibility is additive: new optional payload fields are accepted, while unknown event types and malformed envelopes are rejected with `ProtocolValidationError`.

## Sequence and ownership

The adapter owns provider correlation identifiers only as optional payload metadata. AgentScope creates its own session id. Core/Storage assign the persisted monotonic sequence later; event timestamps may arrive out of order and must not be used as the sequence key.
