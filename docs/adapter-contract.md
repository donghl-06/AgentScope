# Adapter contract (V0)

`@agentscope/adapter-base` defines the provider-neutral boundary. An adapter detects whether its CLI is usable, reports capabilities, and optionally starts or attaches to a provider session. It never writes the database or mutates `SessionState` directly.

## Lifecycle

`AttachedSession` provides both an async event stream and a callback subscription API so Core can choose the delivery model that fits its backpressure policy. Every subscription returns an unsubscribe function. `stop` requests provider termination and accepts a normalized reason; `detach` stops observation without claiming that the provider session finished. Both methods must be safe to call more than once.

## Capability versus confidence

`AgentCapabilities` describes whether an adapter can provide a class of signal at all. Each normalized `AgentEvent` independently carries a confidence value, because an available capability can still produce an inferred or partial event.

## Ownership rules

- AgentScope owns the session id and persisted sequence.
- Provider session ids are optional metadata used only for attach/resume.
- Adapter-specific parser types stay in the provider package.
- Environment maps are input-only and must never be logged by default.
- Core consumes only `@agentscope/protocol` and this contract; it does not import Claude/Codex types.

