# Known Issues and V0 Boundaries

This document records limitations that are known and intentional for the V0
local-first release. They are not silently treated as supported behavior.

## Windows console interruption

The provider runner registers signal handlers before startup and the
`agent-scope start` supervisor terminates the Dashboard process tree before
closing the server. A Windows console host can nevertheless terminate the
outer Node process before the provider's terminal event is persisted. In that
case the provider child/process evidence is still cleaned up, but the session
may remain `running` until:

```powershell
node .\apps\cli\bin\agent-scope.mjs recover
```

The recovery command is the supported V0 fallback. Fully atomic Ctrl+C and
Ctrl+Break behavior across every PowerShell/console host is not claimed.

## Structured, non-interactive provider path

V0 targets the documented structured/non-interactive Claude Code and Codex CLI
paths. Interactive TTY/PTY semantics, terminal resize, and provider-specific
interactive approval screens remain experimental and are not part of the
automatic CI contract.

## Manual provider smoke

Real provider sessions depend on the locally installed CLI, endpoint, model,
credentials, network, and approval policy. They are documented manual smoke
tests rather than CI tests. Mock fixtures provide the deterministic CI path.

## Development Dashboard process

The default `agent-scope start` command launches the repository-local Vite
development server through pnpm. It requires a checkout with dependencies
installed; it is not a standalone production Dashboard bundle. Use
`--no-dashboard` when another process owns the Dashboard.

## Performance and scale

V0 has a four-concurrent-Mock baseline, but does not promise a P95 latency,
CPU/memory ceiling, or maximum session/event count yet. These measurements
remain release-hardening work.

## Raw provider logs

Raw provider output is not persisted by default. A general-purpose raw-log
opt-in, retention policy, and cleanup command are not yet exposed as a stable
V0 feature.
