# V0 Remaining Work

This is the actionable view of the remaining roadmap items. The unchecked
checkbox count in `ROADMAP.md` is larger because it also contains original
design items, experimental capabilities, and V1 backlog. The list below is
the smaller set that still affects a V0 sign-off.

## Blocked by the user's environment or an external provider

1. **Real Claude interactive Ctrl+C.** The Kimi-compatible endpoint returned
   HTTP 403 concurrent-request-limit errors twice, including after a
   one-minute retry. Once the limit clears, run one long-lived harmless Claude
   task and interrupt it; then verify `interrupted` and the absence of an
   orphan process.

## Remaining engineering measurements

1. **UI end-to-end latency.** Cross-process event-to-WebSocket delivery is now
   measured (final smoke P50 220 ms, P95 396 ms), and the
   server polls external CLI writers. Browser event-to-paint latency is still
   not measured.
2. **WebSocket backpressure — baseline closed in this cycle.** Cursor catch-up,
   real disconnect/reconnect, 250-event multi-page timeline pagination, and a
   bounded slow-client disconnect regression now pass. Long-duration capacity
   and browser paint measurements remain outside this baseline. Turns and
   observer-evidence also expose bounded cursor-page endpoints; the existing
   array endpoints remain compatible for the current Dashboard.
3. **SQLite busy/fault injection — closed in this cycle.** A two-connection
   file-backed regression now holds an `IMMEDIATE` write lock and verifies the
   second append is normalized to `StorageBusyError`; evidence is in
   `docs/findings/e2e.md`.
4. **Lightweight diagnostics — baseline closed in this cycle.** `GET
   /api/diagnostics` now exposes request correlation IDs, WebSocket client and
   delivery/error counters, duplicate/busy storage counters, and aggregate event
   write latency. Long-term metrics retention and a full dropped-event taxonomy
   remain outside the V0 surface.

## Deliberately not required for the current V0 path

- Full interactive TTY/PTY passthrough, terminal resize, and every provider
  approval-screen behavior.
- A general raw-log opt-in/retention feature.
- A packaged production Dashboard bundle launched by `agent-scope start`.
- ML/statistical ETA, token/cost reporting, remote execution, accounts, and
  other V1+ backlog items.

## Already closed in this cycle

- One-command server + Dashboard startup and Windows Dashboard process-tree
  cleanup.
- Dashboard refresh/reconnect acceptance and HTTP cursor catch-up.
- Repeated 32-sample Mock performance baseline.
- Windows native Unicode/space path and process-tree smoke.
- Known Issues, V0 acceptance matrix, and local release-prep documentation.
- WSL2 isolated Linux dependency install and Mock CLI smoke; Node22/pnpm user
  environment and the Node22 CLI entry guard are verified.
- WSL2 real Claude provider plus same-database Dashboard relay was manually
  confirmed by the user on 2026-09-07. Full interactive TTY/PTY behavior is
  intentionally still experimental and is not included in that confirmation.
