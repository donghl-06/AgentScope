# Unified event protocol (V0)

`@agentscope/protocol` is the only event contract consumed by Core, Storage, API, and Dashboard. Provider adapters normalize their own output into this contract before events cross the adapter boundary.

## Event envelope

Every event carries:

- a producer-owned `id` for deduplication;
- an AgentScope-owned `sessionId`;
- a Unix timestamp in milliseconds;
- `source` metadata (`provider`, `client`, `environment`, and `adapter`);
- one of the 18 V0 `type` values;
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

`session_finished` always includes a normalized `reason`. An adapter may additionally provide an exit code and a short provider outcome label; full stdout, prompts, secrets, and token data are not part of the default payload.

## Sequence and ownership

The adapter owns provider correlation identifiers only as optional payload metadata. AgentScope creates its own session id. Core/Storage assign the persisted monotonic sequence later; event timestamps may arrive out of order and must not be used as the sequence key.

