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
2. **WSL2 smoke.** WSL2 is installed, but Ubuntu currently exposes Linux Node
   18.19.0 and a pnpm command that resolves to a Windows Corepack shim. Install
   Linux Node 22+ and Linux pnpm before running the second-environment smoke.

## Remaining engineering measurements

1. **UI end-to-end latency.** The repeated Mock benchmark now reports wrapper
   latency P50/P95, SQLite growth, and orchestrator CPU/RSS. It does not measure
   event-to-Dashboard paint latency.
2. **WebSocket backpressure and timeline pagination.** Cursor catch-up and a
   real disconnect/reconnect smoke pass, but sustained slow-client/backpressure
   behavior and large timeline pagination still need measurement.
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
