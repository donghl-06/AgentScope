# Security and privacy audit findings

## 2026-09-06 local audit

Scope covered the tracked source/docs/fixtures, the repository-local AgentScope
database, and the default server configuration. The audit intentionally excluded
the ignored `.env.claude-test.ps1` file because it is the local credential boundary.

- No `sk-kimi-*` or `sk-ant-*` credential strings were found in tracked files or
  the default database.
- No hard-coded `ANTHROPIC_API_KEY=` assignment or `Authorization: Bearer` value
  was found in tracked files or the default database.
- The fixture sensitivity check passed; raw provider output and credentials are
  not present in the committed fixture set.
- The server configuration defaults to `127.0.0.1`; external binding requires an
  explicit host override.
- The local Claude configuration remains ignored and is not part of Git history.

The production dependency audit ran with explicit user authorization on 2026-09-06:
`pnpm audit --prod --json` reported 69 production dependencies, 3 optional
dependencies, and zero info/low/moderate/high/critical advisories.

This is a targeted evidence scan, not a substitute for a full security review.
The observer regression suite now covers lexical traversal rejection and a
workspace junction targeting an outside path; the process-runner suite covers
shell metacharacter arguments with `shell: false`. Raw-log opt-in retention is
not implemented and remains disabled by policy. Windows/WSL process-tree and
interactive signal behavior remain manual smoke items.

## 2026-09-09 release-gate dependency recheck

With explicit user authorization, `pnpm audit --prod` completed with
`No known vulnerabilities found`. This recheck does not change the local-only
credential boundary or imply that a provider endpoint/account has been audited.
