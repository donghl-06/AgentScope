# AgentScope V0 Architecture

Status: Baseline for Phase 0

## 1. Architectural objective

AgentScope is a local-first observability layer for AI coding agents. The V0 architecture must preserve a trustworthy path from provider and workspace signals to a recoverable user-facing state:

```text
Agent process / workspace
  -> provider adapter and scoped observers
  -> validated AgentEvent
  -> durable append + deterministic reduction
  -> SessionState + Progress + ETA
  -> HTTP snapshot/catch-up + WebSocket live updates
  -> React Dashboard
```

The system values truthful degradation over fabricated uniformity. An adapter may expose partial capabilities; missing native data is represented through capability and confidence rather than guessed provider behavior.

## 2. V0 deployment model

- One local user and one local AgentScope server.
- Server binds to loopback by default.
- SQLite is the durable source of truth.
- CLI wrappers start Claude Code CLI, Codex CLI, or MockAdapter sessions.
- The Dashboard is served locally and consumes HTTP plus WebSocket.
- No cloud control plane, user account, remote execution, or GUI scraping.

## 3. Components and responsibilities

### 3.1 Applications

#### `apps/cli`

- Exposes `start`, `run`, `sessions`, and `show`.
- Preserves the wrapped process argument boundary, stdio behavior, and exit semantics.
- Selects an adapter and registers a session with the server/core composition layer.
- Does not parse provider events itself.

#### `apps/server`

- Composes protocol, core, storage, estimators, and realtime delivery.
- Owns HTTP and WebSocket transport behavior.
- Persists accepted events before publishing realtime notifications.
- Does not contain provider-specific parsing or UI state logic.

#### `apps/dashboard`

- Presents project overview, session cards, details, timeline, verification, progress, and ETA.
- Uses HTTP for snapshots and cursor catch-up.
- Uses WebSocket only as a live notification path.
- Represents confidence, capability, and inferred/native provenance explicitly.

### 3.2 Packages

#### `packages/protocol`

Owns public and cross-boundary contracts: AgentEvent, SessionState, capabilities, payload schemas, API DTOs, realtime envelopes, protocol version, and runtime validation.

It must not depend on Core, adapters, storage, server, CLI, or React.

#### `packages/core`

Owns the EventBus, event acceptance rules, sequence assignment contract, deterministic SessionState reducer, lifecycle transitions, and session orchestration interfaces.

It may depend on Protocol and narrow Shared utilities. It must not depend on provider adapters, SQLite/ORM details, HTTP, CLI, or React.

#### `packages/adapters/*`

Each adapter detects and starts/attaches to one provider, declares capabilities, parses only public or experimentally confirmed outputs, and emits normalized AgentEvent values.

Provider-specific fields and types remain inside the adapter. Adapters do not write the database and do not mutate SessionState.

#### `packages/observers/*`

Observers collect objective scoped signals from the wrapped process and its workspace. They may emit inferred AgentEvent values with explicit source and reduced confidence.

Observers must not inspect unrelated processes or files outside the resolved workspace.

#### `packages/progress`

Computes deterministic `value/confidence/reasons` from state and evidence. It cannot mark required-but-unverified work successful.

#### `packages/eta`

Computes `minSeconds/maxSeconds/confidence/reasons` from elapsed time, progress, failures, blockers, replanning, and signal quality. It never exposes an internal center as a precise promise.

#### `packages/storage`

Owns SQLite schema, migrations, repositories, transactions, restart recovery, and cursor queries. Provider payloads enter storage only after Protocol validation.

#### `packages/shared`

Contains only small infrastructure utilities that truly cross multiple layers and do not belong in Protocol. New additions require a clear reason to avoid a dependency dumping ground.

## 4. Dependency direction

```text
protocol <- core <- server composition
protocol <- adapters
protocol <- observers
protocol <- progress
protocol <- eta
protocol <- storage

server composition -> core/storage/progress/eta/adapters/observers
cli -> protocol + server/client orchestration
dashboard -> protocol transport DTOs
```

Forbidden dependencies:

- Core -> provider adapter implementation.
- Core -> React, Fastify, CLI framework, or ORM.
- Adapter -> storage or Dashboard.
- Observer -> unrelated machine-wide process/file enumeration.
- Dashboard -> raw provider event formats.
- Protocol -> any application package.

Import-boundary lint rules will encode these constraints during Phase 1.

## 5. Event acceptance and consistency

1. Adapter or observer emits a candidate event.
2. Protocol runtime schema validates the candidate.
3. Core verifies session ownership, timestamp bounds, and event identity.
4. Storage appends the event and updates the session projection in one transaction.
5. The accepted event receives a session-scoped monotonically increasing sequence.
6. Only after commit does the server publish WebSocket notifications.
7. Dashboard detects sequence gaps and uses HTTP `after=<cursor>` to recover.

Consequences:

- WebSocket is not the source of truth.
- A transaction failure cannot create a realtime-only “ghost event.”
- Reducers must be deterministic so a timeline can rebuild the same state.
- Event timestamp and accepted sequence are separate: timestamps may arrive out of order; sequence is the durable delivery order.

## 6. Session lifecycle

```text
starting -> running -> completed
                    -> failed
                    -> interrupted
running <-> blocked
```

- Spawn failure becomes `failed`.
- A user interrupt becomes `interrupted`, not `failed`.
- A zero process exit is not sufficient for successful completion when required verification failed.
- Terminal sessions cannot be reopened by ordinary late activity events.
- Cleanup is explicit and idempotent for processes, streams, watchers, sockets, timers, and database handles.

The exact transition table will be part of Protocol/Core tests in Phase 2 and Phase 3.

## 7. Evidence and confidence

Evidence priority for conflicting claims:

1. Validated provider-native structured events.
2. Wrapped process lifecycle and recognized command/test results.
3. Git and filesystem observations scoped to the workspace.
4. Agent self-reported plan, milestone, or progress.

Priority does not make a source infallible. Each event has confidence, each adapter declares capabilities, and derived Progress/ETA includes reasons. Duplicate evidence from an adapter and observer must be correlated rather than counted twice.

## 8. Recovery and failure isolation

- SQLite uses migrations, foreign keys, WAL, busy timeout, and short transactions.
- On startup, non-terminal sessions are replayed or checked against stored projections.
- A process left running across an AgentScope crash is handled by an explicit stale-session policy; it is not silently considered completed.
- Parser failure in one adapter cannot terminate other sessions.
- Slow or disconnected WebSocket clients cannot block event persistence.
- Malformed provider records are diagnosed with redacted metadata and skipped or downgraded according to adapter policy.

## 9. Security boundaries

- Server listens on loopback unless the user explicitly changes the bind address.
- General process execution uses `spawn(executable, args)`, never shell-string concatenation.
- File observation resolves and enforces a workspace root and ignores symlink/path traversal escapes.
- Environment variables, credentials, tokens, full prompts, private reasoning, and raw output are not stored by default.
- Privacy and retention details are defined in `docs/privacy.md`.

## 10. Performance posture

V0 optimizes correctness before scale, while preventing obvious unbounded behavior:

- Debounce/coalesce filesystem events.
- Avoid repeated full Git diffs.
- Use cursor pagination for timelines.
- Apply WebSocket backpressure and message-size limits.
- Snapshot ETA only on meaningful change or throttled intervals.
- Establish measured limits with four concurrent Mock sessions during Phase 12.

## 11. Extension points

- A new provider implements the Adapter contract and fixtures without changing Core/Storage/Dashboard control flow.
- Future remote collectors transport AgentEvent envelopes; they do not bypass validation.
- Codex App remains a future capability spike and must not introduce OCR/UI scraping into V0.
- Historical/ML ETA can replace the estimator behind the same range/confidence/reasons contract.

## 12. Open architectural items

| Item | Owner | Close condition |
|---|---|---|
| SQLite driver | Phase 1 implementer | Windows install/build smoke compares stable `better-sqlite3` with `node:sqlite`; driver must support the declared Node baseline |
| PTY requirement | Phase 0.4 | Real Claude/Codex interactive and structured-mode experiments determine whether inherited/piped stdio is sufficient |
| Restart handling of surviving child processes | Phase 5 | Process spike documents safe attach/mark-interrupted behavior per target OS |
| Projection strategy | Phase 4 | Integration test compares transactionally stored projection with deterministic replay |
