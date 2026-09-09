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
  sequence numbers. The final rerun on Windows native Node `v24.14.1` measured
  event timestamp to WebSocket receipt latency at P50 220 ms, P95 396 ms, and
  maximum 396 ms. An earlier rerun measured P50 163 ms/P95 287 ms; both remain
  below the three-second event-delivery target.
- This is an event-to-WebSocket baseline, not browser paint latency. Slow-client
  backpressure and actual Dashboard paint measurement remain separate items.

## 2026-09-09 V1 release-hardening rerun

- The final local `pnpm release:check` completed after the conservative continuation and
  Dashboard grouping and Codex TTY changes: formatting, fixture sensitivity, lint, all workspace
  typechecks, 55 unit test files (255 tests), 5 integration tests, and the workspace
  build/manifest check all passed.
- `pnpm benchmark:mock -- --iterations 20` completed 80 isolated Mock wrapper
  sessions (20 rounds × 4 fixtures). Every expected terminal status and event
  count was preserved. The run took 36.447 seconds; wrapper latency P50 was
  30.824 seconds and P95 was 34.141 seconds. The temporary database reached
  716,800 bytes; the benchmark orchestrator peak RSS was 57,024,512 bytes and
  user/system CPU was 265/359 ms. These are a repeatable Mock baseline, not a
  supported capacity limit or a Claude provider latency claim.
- `scripts/experiments/event-latency-smoke.mjs 8791` received all 10/10 event
  notifications. The rerun measured event-timestamp-to-WebSocket receipt P50
  173 ms, P95 347 ms, and maximum 347 ms. The experiment now waits for the
  server child cleanup and retries temporary SQLite removal on Windows, so a
  successful measurement also exits cleanly.
- The isolated `ws-reconnect-smoke.mjs` run on port 8792 received `hello` on
  both connections and recovered all 10 events through HTTP cursor catch-up
  (sequence 1–10, status 200). The temporary server and database were removed
  afterward.
- The existing integration suite still covers SQLite busy handling, server
  restart recovery, and WebSocket disconnect recovery. Browser paint latency,
  multi-hour real-provider capacity, and injected machine/terminal shutdown
  remain intentionally unclaimed release-hardening measurements.

## 2026-09-09 Codex interactive TTY implementation smoke

- The CLI now exposes `agent-scope codex [args...]` and records the interactive
  source as `codex-cli` / `codex-cli-tty`, while retaining the existing
  structured `run codex -- ...` path.
- Fake PTY regression covered a Codex `›` ready prompt, ordinary input, output,
  turn completion, observer evidence, and session cleanup. The full unit suite
  passed 256 tests and the integration suite passed 5 tests after this change.
- A Windows native wrapper smoke launched the installed Node `.cmd` shim with
  `codex --no-alt-screen --version` and returned `codex-cli 0.152.1`; the
  temporary SQLite database was removed afterward.
- The explicit `AGENTSCOPE_CODEX_EXECUTABLE` `.cmd` override path was exercised
  with a fake Windows Node shim and now resolves to an argument-safe `node`
  plus script invocation instead of passing a `.cmd` directly to the PTY.
- This does not claim provider-native token/tool/milestone telemetry for the TTY wrapper.
  The separate structured adapter now normalizes the observed usage/tool/native-event
  fields; the structured-vs-TTY capability boundary remains documented in
  `docs/findings/codex-tty.md`.

## 2026-09-09 Codex TTY final user acceptance

- The user completed a real Codex CLI interactive multi-turn smoke through
  `agent-scope codex` and confirmed that native terminal interaction and
  Dashboard monitoring both worked as expected.
- The Codex UI also reported an optional `codex_apps` MCP startup/HTTP error for
  `chatgpt.com/backend-api/ps/mcp`. The main Codex session continued normally;
  the user later confirmed that the warning disappeared after network recovery. This is
  an external optional MCP/account/network capability and is not an AgentScope TTY failure.

## 2026-09-09 Codex structured telemetry normalization

- The Codex JSONL adapter now preserves a redacted `provider_event` for every observed
  record, so the Dashboard can show native event-family/phase counts without retaining
  prompts, command text, or provider message content.
- `command_execution` items now produce both command lifecycle events (for command
  observers/verification) and tool-call lifecycle events (for provider tool totals), with
  item id, status, exit code and duration only.
- `turn.completed.usage` is normalized to input, output, cached-input, reasoning and total
  token fields. Codex cost is not emitted by the observed stream and remains unavailable;
  no cost estimate is fabricated. Native milestones were not observed and remain an explicit
  fallback to AgentScope progress/activity.

## 2026-09-09 bounded concurrency benchmark rerun

- `pnpm benchmark:mock -- --iterations 20 --concurrency 4` completed 80 isolated Mock
  wrapper sessions in 60.232 seconds. All expected terminal statuses and event counts were
  preserved; wrapper latency P50 was 2,507 ms and P95 was 2,995 ms.
- The temporary database reached 700,416 bytes; the benchmark orchestrator peak RSS was
  51,531,776 bytes and user/system CPU was 297/125 ms. These are bounded wrapper/SQLite
  baselines, not browser-paint latency or a supported capacity guarantee.
- The benchmark now limits simultaneous child processes and uses a longer bounded Windows
  SQLite-handle cleanup backoff. This avoids reporting an otherwise successful high-round run
  as failed solely because the OS released a temporary database directory late.

## 2026-09-09 live delivery rerun

- `event-latency-smoke.mjs 8793` received all 10/10 event notifications with no missing
  sequence. Event timestamp to WebSocket receipt latency was P50 219 ms, P95 397 ms, and
  maximum 397 ms.
- The isolated `ws-reconnect-smoke.mjs` run on port 8794 received `hello` on both
  connections and recovered all 10 events through HTTP cursor catch-up (status 200,
  sequence 1–10). Temporary server/database resources were removed afterward.
