# Changelog

All notable changes to AgentScope are recorded here.

## Unreleased

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
