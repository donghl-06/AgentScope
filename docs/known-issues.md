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

Claude's full native token, timing, stream-phase, hook, and tool-result details
are available only when Claude is launched with its structured JSONL output
flags. A normal interactive TTY remains fully usable and is observed through
PTY/process/filesystem/Git signals, but the PTY does not expose Claude's private
structured usage frames. Use the structured path when provider-native telemetry
is required:

```powershell
node .\apps\cli\bin\agent-scope.mjs run claude -- `
  --print `
  --output-format stream-json `
  --verbose `
  --include-hook-events `
  --include-partial-messages `
  -p "your task"
```

Claude does not currently provide a stable future-ETA field. Dashboard ETA is
therefore an evidence-based estimate; provider-reported latency is shown
separately when available. Explicit native milestones are mapped when present,
but no milestone stream was observed in every real Claude run.

## Manual provider smoke

Real provider sessions depend on the locally installed CLI, endpoint, model,
credentials, network, and approval policy. They are documented manual smoke
tests rather than CI tests. Mock fixtures provide the deterministic CI path.
The configured compatible endpoint can return HTTP 403 concurrent-request-limit
errors while another request is active; waiting about one minute allowed a later
real retry to initialize. In that retry the Claude CLI reached a structured tool
call, but Windows Ctrl+C caused the wrapper to exit with code 1 and persisted the
isolated session as `failed` rather than `interrupted`. No Claude/sleep child was
left behind. This confirms cleanup but not atomic terminal-status persistence;
use `agent-scope recover` for stale sessions and do not treat direct Ctrl+C as a
fully reliable V0 transition yet.

## WSL2 prerequisite

WSL2 itself is installed on the host, and the user's interactive Ubuntu shell
already exposes Linux Node `22.14.0` and Linux pnpm `10.33.0` from
`$HOME/workspace/node-v22.14.0-linux-x64`. A non-interactive shell returns before
the user's `.bashrc` PATH setup, so WSL commands must run through an interactive
shell or explicitly source the user's setup. A separate temporary Linux clone
with Linux dependencies passed the Mock CLI smoke on 2026-09-06, and the user
confirmed real Claude plus same-database Dashboard relay on 2026-09-07. The
shared Windows checkout must not reuse that Linux `node_modules`; interactive
TTY behavior remains experimental.

## Development Dashboard process

The default `agent-scope start` command launches the repository-local Vite
development server through pnpm. It requires a checkout with dependencies
installed; it is not a standalone production Dashboard bundle. Use
`--no-dashboard` when another process owns the Dashboard.

## Performance and scale

V0 has a four-concurrent-Mock baseline, but does not promise a P95 latency,
CPU/memory ceiling, or maximum session/event count yet. These measurements
remain release-hardening work.

The server polls SQLite changes written by independent CLI processes at a bounded
interval so Dashboard WebSocket updates do not depend on an in-process repository
subscription. The measured event-to-WebSocket P95 is below three seconds in the
Windows smoke. Slow clients are disconnected once their buffered amount exceeds
the bounded threshold and recover through WebSocket reconnect plus HTTP cursor
catch-up. Browser paint latency and long-duration capacity are not yet claimed.

## Raw provider logs

Raw provider output is not persisted by default. A general-purpose raw-log
opt-in, retention policy, and cleanup command are not yet exposed as a stable
V0 feature.
