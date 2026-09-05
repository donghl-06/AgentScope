# End-to-end and capacity findings

## Windows native Mock concurrency

- Date: 2026-09-06.
- Environment: Windows native PowerShell, Node `v24.14.1`, repository-local SQLite.
- Workload: four concurrent Mock sessions using `basic-success`, `test-failure`,
  `blocked-then-resumed`, and `low-signal` fixtures.
- Result: all four wrapper processes exited; the database remained readable and
  accepted the concurrent writes without a lock error. The resulting sessions kept
  separate event streams and terminal projections; event counts were 10, 6, 5, and
  3 respectively.
- Wall-clock observation: approximately 2.4 seconds for the four CLI jobs. This is
  a smoke baseline, not a throughput or P95 claim.

This evidence does not establish a supported maximum session count, high-frequency
filesystem capacity, WebSocket backpressure limits, or resource usage. Those require
a dedicated benchmark with defined sampling and retention rules.
