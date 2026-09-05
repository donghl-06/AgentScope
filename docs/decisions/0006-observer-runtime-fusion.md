# ADR-0006: Observer runtime evidence boundary

## Status

Accepted for V0 implementation.

## Context

The provider adapters already emit normalized native events. Process, Git,
filesystem, and known verification-command observers provide objective
fallback signals, but they must not become a second adapter parser or emit
duplicate protocol events. The existing fusion ledger can select one evidence
record for a logical key, while callers still need a lifecycle owner that
starts, stops, and isolates the observers.

## Decision

Introduce a small `@agentscope/observer-runtime` coordinator with these rules:

1. The coordinator owns only observers for the current AgentScope session:
   the wrapper root process, the resolved workspace, Git snapshots, and
   caller-supplied known command boundaries.
2. The caller supplies command start/finish boundaries. The coordinator does
   not parse arbitrary shell strings or inspect provider output.
3. Observer records are emitted as `ObserverEvidence` with explicit source,
   kind, confidence, reason, timestamp, payload, and a deterministic logical
   key. Native adapter events remain untouched.
4. Evidence is offered to the `ObserverEvidenceLedger` before the caller's
   persistence/publish step. The coordinator itself does not write SQLite or
   broadcast WebSocket messages.
5. Git baseline capture and optional change snapshots are asynchronous and
   best-effort. A Git failure, missing repository, or file watcher failure is
   reported through `onError` and does not terminate the provider session.
6. `stop()` is idempotent, closes the filesystem/process observers, clears
   command state, and never emits records after shutdown.

## Evidence keys

| Source | Kind | Key shape | Retention intent |
|---|---|---|---|
| process | lifecycle | `process:<pid>:<started\|finished>` | one lifecycle record per root process |
| git | workspace | `git:<workspace>:<baseline\|snapshot>` | latest snapshot wins |
| filesystem | file | `file:<relative-path>` | latest path observation wins |
| test_observer | command/verification | `command:<id>:<started\|finished>` | one boundary record per known command |

The ledger's native/process/test/git/filesystem/agent priority remains the
source of truth for conflicts. Evidence payloads contain only observer
metadata; file contents, command text, environment variables, and raw provider
records are excluded.

## Consequences

- Provider runners can adopt the coordinator without coupling adapters to
  workspace implementation details.
- The coordinator is unit-testable with injected watch, inspect, Git, and clock
  dependencies.
- A later integration layer must preserve persist-before-publish ordering and
  must not turn every observer record into a duplicate `AgentEvent`.
- The coordinator does not by itself prove the Dashboard E2E gate; that remains
  a later 12.2/12.3 validation step.
