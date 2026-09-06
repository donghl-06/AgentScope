# End-to-end and capacity findings

## Windows native Mock concurrency

- Date: 2026-09-06.
- Environment: Windows native PowerShell, Node `v24.14.1`, repository-local SQLite.
- Workload: four concurrent Mock sessions using `basic-success`, `test-failure`,
  `blocked-then-resumed`, and `low-signal` fixtures, with runtime observer evidence
  enabled.
- Result: all four wrapper processes exited; the database remained readable and
  accepted the concurrent writes without a lock error. The resulting sessions kept
  separate event streams and terminal projections; event counts were 10, 6, 5, and
  3 respectively.
- Wall-clock observation: 3.923 seconds for the four CLI jobs; event counts were 10,
  6, 5, and 3, and the temporary database reached 118,784 bytes. Per-fixture elapsed
  times were 2.453s, 1.878s, 2.134s, and 1.846s respectively. This is a smoke
  baseline, not a throughput or P95 claim.
- The first observer-enabled run exposed `SQLITE_BUSY` during concurrent event
  projection writes. `StorageRepository.appendEvent` now uses an IMMEDIATE transaction
  and the default busy timeout is 30 seconds; the rerun completed without lock errors.

This evidence does not establish a supported maximum session count, high-frequency
filesystem capacity, WebSocket backpressure limits, or resource usage. Those require
a dedicated benchmark with defined sampling and retention rules.

## SQLite busy fault injection

- Date: 2026-09-06.
- The storage regression opens two repository connections to the same file-backed
  database, holds an `BEGIN IMMEDIATE` write lock on the first connection, and
  attempts an event append through the second connection with a 1 ms busy timeout.
- Result: the append fails deterministically as `StorageBusyError`; the lock is
  rolled back and both clients close cleanly. The transaction-start boundary is
  normalized in the same way as insert/update busy errors, so callers do not see a
  driver-specific `SQLITE_BUSY` exception.

## Server restart recovery

- Date: 2026-09-06.
- The live AgentScope server on `127.0.0.1:8787` was stopped and restarted with the
  same repository-local SQLite database. `/healthz` returned `status=ok` afterward,
  and all 34 persisted sessions remained queryable.
- Representative real-provider sessions retained their terminal status and counts:
  Codex completed (8 events, 8 evidence records), Claude completed (5 events, 31
  evidence records), and Codex interrupted (3 events, 4 evidence records). No new
  duplicate events were created by the restart.
- Browser visual refresh, WebSocket reconnect, and HTTP cursor catch-up remain a
  separate manual acceptance item; this check establishes server/SQLite/API recovery.

## One-command server + Dashboard startup

- Date: 2026-09-06.
- Command: `node .\apps\cli\bin\agent-scope.mjs start --port 8788
  --dashboard-port 5174 --database :memory:`.
- Environment: Windows native PowerShell, Node `v24.14.1`, isolated ports so the
  user's existing 8787/5173 services were not disturbed.
- Result: AgentScope printed server `http://127.0.0.1:8788` and Dashboard
  `http://127.0.0.1:5174`; Vite reported the requested 5174 local URL.
- Ctrl+C result: the outer command exited with the expected interrupt code; post-checks
  found no listener on 8788/5174 and no matching pnpm/Vite child process. This verifies
  Dashboard process-tree cleanup, but does not claim that every Windows console host
  can persist a provider terminal event before killing the outer CLI.

The repeatable local benchmark entry point is:

```powershell
pnpm benchmark:mock
```

It runs the four fixtures concurrently in an isolated temporary workspace and reports
wall-clock time, per-fixture event counts/status/exit code, temporary database size,
Node version, and platform. The temporary database is deleted after the report. Results
are diagnostic baselines only; they must not be read as a V0 session or event capacity
guarantee.

## Repeated wrapper performance baseline

- Date: 2026-09-06.
- Command: `pnpm benchmark:mock -- --iterations 8`.
- Environment: Windows native PowerShell, Node `v24.14.1`, 32 wrapper samples
  (eight concurrent rounds of the four standard fixtures).
- Result: all 32 samples preserved their expected terminal statuses and event counts.
  Total wall-clock time was 20.728 seconds; wrapper latency P50 was 13.392 seconds
  and P95 was 18.740 seconds.
- SQLite growth: the temporary database reached 331,776 bytes after 32 sessions.
- Resource observation: the benchmark orchestrator used 125 ms user CPU and 172 ms
  system CPU, with a peak RSS of 58,392,576 bytes. These are orchestrator-only
  measurements; they are not a whole-process CPU/memory ceiling.
- Interpretation: this establishes a repeatable wrapper/SQLite baseline, not a UI
  event-latency SLO, WebSocket backpressure limit, or supported capacity guarantee.

The benchmark accepts `--iterations <1..100>` and emits the latency/resource fields
above while continuing to delete its temporary database.

## WebSocket disconnect and cursor catch-up

- Date: 2026-09-06.
- Tool: `scripts/experiments/ws-reconnect-smoke.mjs`, isolated server port 8790.
- The first and second WebSocket connections both received the protocol `hello`
  message. The connection was closed before a Mock session ran; after reconnecting,
  the HTTP events endpoint returned status 200 and all 10 events for the completed
  session, with sequence range 1–10.
- This confirms the intended recovery contract: WebSocket carries live updates and
  HTTP `after=<lastSeq>` catch-up supplies events missed while disconnected.
- The temporary server, listener, and database were removed after the smoke.

## Diagnostics and large timeline pagination

- The V0 server now exposes a read-only `/api/diagnostics` snapshot with an
  `x-request-id` response header, WebSocket client/delivery/error counters, and
  aggregate normalized-event write latency. The snapshot is process-lifetime
  state and contains no provider payload or secret.
- A storage regression appends 250 events and reads them in pages of 17 using the
  event cursor. It observed exactly sequence numbers 1–250 once each, covering
  the large-timeline pagination path without duplicates or gaps.
- These checks close the diagnostics baseline and cursor pagination correctness.
  A LiveHub regression also bounds a slow client's buffered amount and disconnects
  it for cursor-based recovery; long-duration capacity and browser paint latency
  remain separate release-hardening measurements.

## Cross-process live updates and event-to-client latency

- Date: 2026-09-06.
- A server process was started on isolated port 8791 while a separate CLI
  process ran the `basic-success` Mock fixture against the same SQLite file.
  Before this check, the server could read the external writes after refresh but
  its in-process repository subscription could not broadcast them to WebSocket
  clients.
- The server now polls external SQLite writers at a bounded 250 ms interval,
  tracks per-session event cursors, and publishes only newly observed session or
  event notifications. Existing history is hydrated without replaying it to new
  clients, and all session list cursor pages are covered.
- The isolated smoke received all 10 of 10 event notifications with no missing
  sequence numbers. Event timestamp to WebSocket receipt latency was P50 163 ms,
  P95 287 ms, maximum 287 ms on Windows native Node `v24.14.1`.
- This is an event-to-WebSocket baseline, not browser paint latency. Slow-client
  backpressure and actual Dashboard paint measurement remain separate items.
