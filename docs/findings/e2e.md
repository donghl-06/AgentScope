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

The repeatable local benchmark entry point is:

```powershell
pnpm benchmark:mock
```

It runs the four fixtures concurrently in an isolated temporary workspace and reports
wall-clock time, per-fixture event counts/status/exit code, temporary database size,
Node version, and platform. The temporary database is deleted after the report. Results
are diagnostic baselines only; they must not be read as a V0 session or event capacity
guarantee.
