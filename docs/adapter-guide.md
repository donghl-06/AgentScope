# Adapter guide

This guide describes how to add a provider adapter without changing Core, Storage,
the HTTP server, or the Dashboard.

## Boundary

An adapter implements `AgentAdapter` from `@agentscope/adapter-base` and emits only
the provider-neutral `AgentEvent` contract from `@agentscope/protocol`.

The adapter is responsible for:

- detecting the provider executable and reporting a conservative version/capability result;
- starting or attaching to a provider session;
- incrementally parsing provider output, including partial lines and malformed records;
- mapping stable provider signals to normalized lifecycle, command, message, file,
  milestone, and verification events;
- stopping and detaching child processes idempotently;
- redacting prompts, command text, full output, tokens, costs, paths, and credentials
  unless a deliberately enabled diagnostic mode says otherwise.

The adapter must not write SQLite, mutate `SessionState`, import Dashboard/server
modules, or make provider-specific event names part of the shared protocol.

## Minimal implementation

```ts
import type {
  AgentAdapter,
  AgentCapabilities,
  AttachedSession,
  DetectionResult,
  StartAgentRequest,
} from '@agentscope/adapter-base';

export class ExampleAdapter implements AgentAdapter {
  readonly id = 'example';

  async detect(): Promise<DetectionResult> {
    return { available: true, confidence: 0.8, version: 'detected-version' };
  }

  capabilities(): AgentCapabilities {
    return {
      structuredEvents: true,
      toolCalls: false,
      fileEvents: false,
      commandEvents: true,
      tokenUsage: false,
      sessionInfo: true,
      milestones: false,
    };
  }

  async start(request: StartAgentRequest): Promise<AttachedSession> {
    // Spawn the provider with an argument array; never build a shell command string.
    // Return an AttachedSession whose events() yields normalized AgentEvent values.
    throw new Error(`Example only: ${request.sessionId}`);
  }
}
```

The example is intentionally not registered as a production adapter. Registration
belongs in the composition layer, where the CLI selects an adapter by name.

## Lifecycle rules

- AgentScope owns the persisted `sessionId` and event sequence.
- Provider session ids are optional metadata, never the primary database key.
- `session_started` must be emitted once when the provider process is attached.
- `session_finished` must be emitted exactly once for completed, failed, blocked, or
  interrupted terminal paths.
- `stop()` requests provider termination; `detach()` stops observation without
  claiming that the provider finished. Both must be safe to call repeatedly.
- A non-zero command/tool result must not be hidden by a provider-level success
  envelope.
- Unknown provider records and malformed JSON are diagnostic input, not reasons to
  crash the adapter or other sessions.

## Tests and fixtures

Every adapter needs redacted raw fixtures and normalized golden tests covering:

1. success and terminal completion;
2. partial chunks, CRLF, Unicode, and malformed records;
3. unknown provider events;
4. command/tool failure inside an otherwise successful turn;
5. provider error and process non-zero exit;
6. user interruption and cleanup idempotency;
7. payload redaction and absence of secrets/full prompts.

Real CLI smoke should be recorded in `docs/findings/` with versions, mode, host,
known warnings, and limitations. Do not commit raw provider output or credentials.

## Fallbacks

If structured output is unavailable, return the capability as unavailable and let
the composition layer combine process, Git, filesystem, and test observers. A
fallback must be labeled as inferred evidence; it must not be promoted to native
provider events or counted twice with an equivalent adapter event.

See [`adapter-contract.md`](adapter-contract.md), [`event-protocol.md`](event-protocol.md),
and the existing [`claude-code`](../packages/adapters/claude-code/README.md) and
[`codex-cli`](../packages/adapters/codex-cli/README.md) adapters for concrete examples.
