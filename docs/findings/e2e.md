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
