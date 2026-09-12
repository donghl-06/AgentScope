# Changelog

All notable changes to AgentScope are recorded here.

## Unreleased

- Added reversible Session hiding and permanent terminal-session deletion in the
  Dashboard/API. Running or starting Sessions cannot be cleaned up, hidden
  Sessions remain available through an explicit filter, and permanent deletion
  cascades turns, events, milestones, ETA snapshots, and observer evidence.
- Completed Sessions now report 100% execution progress even when no verification
  signal is applicable; verification remains a separate Unknown/Passed/Failed
  projection instead of making short completed tasks look stuck at 60%.
- Added a conservative historical ETA baseline from comparable completed
  Sessions. Sparse history remains explicitly `history_insufficient`; hidden
  history is retained for estimates and permanently deleted history is removed.
- Aligned the standalone storage migration command with all schema migrations
  through `0005_session_visibility` and documented cleanup/backup semantics.
- Added an explicit Codex app-server adapter using the locally installed JSON-RPC stdio
  protocol, with version-derived schema validation, thread resume/interrupt, redacted
  provider events, command/tool/file/plan/usage normalization, and conservative approval
  handling. The existing Codex TTY and structured CLI paths remain unchanged.
- Added one-command `agent-scope start` orchestration for the local server and
  repository Dashboard, with `--no-dashboard` and `--dashboard-port` escape
  hatches.
- Added Windows Dashboard process-tree cleanup and startup-interrupt handling;
  documented the remaining console-host Ctrl+C recovery limitation.
- Added a runtime observer coordinator that fuses process, workspace Git/File, and
  known command evidence without changing native provider events.
- Persisted observer evidence in the `observer_evidence` table and exposed it through
  `GET /api/sessions/:id/evidence`.
- Added Claude/Codex and Mock runner integration coverage, parser-isolation tests,
  and a Dashboard observer-evidence summary.
- Documented the V0 support boundaries, manual smoke flow, privacy rules, and local
  database backup/restore procedure.
- Added the V0 acceptance matrix and the Known Issues record in
  `docs/v0-acceptance.md` and `docs/known-issues.md`.
- Added live TTY observer activity projection, an opt-in process-tree view for
  AgentScope-owned wrappers (PID/parent PID/name only), and Dashboard filters
  for loaded timeline events and turn evidence.
- Added opt-in browser notifications for terminal session attention states and
  turn waiting states, with duplicate suppression across live reconnects.

## 0.1.0

Initial local-first V0 development baseline: unified AgentEvent protocol, Mock,
Claude Code CLI and Codex CLI adapters, SQLite persistence, HTTP/WebSocket server,
Progress/ETA projections, and the React Dashboard.
