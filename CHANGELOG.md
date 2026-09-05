# Changelog

All notable changes to AgentScope are recorded here.

## Unreleased

- Added a runtime observer coordinator that fuses process, workspace Git/File, and
  known command evidence without changing native provider events.
- Persisted observer evidence in the `observer_evidence` table and exposed it through
  `GET /api/sessions/:id/evidence`.
- Added Claude/Codex and Mock runner integration coverage, parser-isolation tests,
  and a Dashboard observer-evidence summary.
- Documented the V0 support boundaries, manual smoke flow, privacy rules, and local
  database backup/restore procedure.

## 0.1.0

Initial local-first V0 development baseline: unified AgentEvent protocol, Mock,
Claude Code CLI and Codex CLI adapters, SQLite persistence, HTTP/WebSocket server,
Progress/ETA projections, and the React Dashboard.

