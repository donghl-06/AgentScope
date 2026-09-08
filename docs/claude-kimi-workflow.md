# Claude Code + Kimi monitoring workflow

This guide describes the Windows/VS Code workflow for observing a Claude Code
CLI session that uses a compatible Kimi endpoint. AgentScope does not call the
provider API itself; it wraps the local `claude` executable, while the Claude
environment variables select the endpoint, model, and credentials.

## 1. Open two VS Code PowerShell terminals

Use the repository root in both terminals:

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
```

The two terminals must use the same `AGENTSCOPE_DATABASE` value. Do not start a
second server against the same ports or database.

## 2. Terminal 1: start AgentScope and Dashboard

```powershell
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
pnpm start
```

The one-command supervisor starts the local API server on `127.0.0.1:8787` and
the Dashboard on `http://127.0.0.1:5173/`. Keep this terminal running while a
provider task is active. Open the Dashboard URL in a browser.

If a previous AgentScope process owns port 8787, identify that exact listener
with `Get-NetTCPConnection -LocalPort 8787 -State Listen` and stop only the
corresponding stale process before retrying. Do not terminate an unrelated
program just because it uses a different port.

For an isolated second instance, use different ports and a different database:

```powershell
pnpm start -- --port 8788 --dashboard-port 5174 --database (Join-Path (Get-Location) '.agentscope\isolated.db')
```

Open `http://127.0.0.1:5174/` for that instance.

## 3. Terminal 2: load the Claude/Kimi environment and run a task

The local experiment file is gitignored. Dot-source it so the variables remain
in the current PowerShell terminal; never paste the secret values into a
committed file or a prompt:

```powershell
. .\.env.claude-test.ps1
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
node .\apps\cli\bin\agent-scope.mjs run claude -- --bare -p "Reply with OK only" --output-format stream-json --verbose
```

For a trusted local workspace task that may need Claude Code approvals, add
`--dangerously-skip-permissions` after the `--` separator. Only use that option
for workspaces and prompts you trust.

The command starts the local `claude` executable. AgentScope records normalized
events in the database while Claude Code uses the environment-loaded Kimi
endpoint. The terminal prints the wrapper's final JSON result; the Dashboard
updates the same session through WebSocket notifications.

For the normal multi-turn experience with Claude Code's full features, use the
interactive TTY entry point instead of `run`/`--bare`:

```powershell
node 'D:\大学\项目\AgentScope\apps\cli\bin\agent-scope.mjs' claude --agent-scope-accept-api-key
```

Type prompts in that same terminal exactly as you would in an ordinary Claude
Code session. AgentScope observes terminal boundaries, process/Git/filesystem
evidence and live projections without replacing the provider's prompt or tool
approval flow. Use `--resume <provider-session-id>` only when you have an explicit
provider id; use `--continue` when you want Claude to choose its native continuation,
understanding that AgentScope will keep the new execution unlinked until a stable
provider id is reported.

### Running against another project

The observed workspace is the current directory of the wrapper process. It is
not required to be the AgentScope repository. Start the server from the
AgentScope repository, then start the provider wrapper from the project you
actually want Claude Code to edit. Use an absolute path for the wrapper and an
absolute path for the shared database:

```powershell
# Terminal 1: keep this in the AgentScope repository
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
pnpm start

# Terminal 2: switch to the target project
Set-Location -LiteralPath 'D:\大学\其他项目\MyProject'
. 'D:\大学\项目\AgentScope\.env.claude-test.ps1'
$env:AGENTSCOPE_DATABASE = 'D:\大学\项目\AgentScope\.agentscope\agentscope.db'
node 'D:\大学\项目\AgentScope\apps\cli\bin\agent-scope.mjs' run claude -- `
  --bare `
  -p "Reply with OK only" `
  --output-format stream-json `
  --verbose
```

In this example `D:\大学\其他项目\MyProject` is the workspace sent to Claude,
and `D:\大学\项目\AgentScope\.agentscope\agentscope.db` is only the shared
observability database. The Dashboard can therefore show the task while the
provider edits the other project. File, Git, and process evidence is scoped to
that target workspace. The PowerShell dot-source syntax is `. <path>`; do not
omit the space after the first dot.

## 4. What to observe in the Dashboard

1. The header should say **Live updates connected**.
2. A new row should appear under **Recent agent work** with the provider,
   adapter, session id, and a status pill.
3. During work, **Active** is the count of `starting` plus `running` sessions.
4. Select the row to inspect the detail panel. The status, current activity,
   progress, ETA, verification state, evidence, and timeline should update.
5. When the provider exits, the row becomes **Completed**, **Failed**, or
   **Interrupted**. A completed provider process does not mean tests/build/typecheck
   passed; those checks are shown separately as verification signals.

Use the status filter to find `Interrupted` sessions; it is intentionally not a
separate top summary card. **Blocked** means the task is waiting for action and
is not treated as failed.

## 5. Reading the detail panel

- **Started / Duration / Workspace**: session start time, elapsed duration, and
  the canonical workspace path reported by the wrapper.
- **Client / Environment / Activity / Last event**: source metadata and the most
  recent normalized activity signal. Missing provider fields are shown as
  `Not reported`, not guessed.
- **Progress**: an explainable estimate from 0–100%, followed by a confidence
  bar and the reason that produced the estimate. Before objective verification,
  the safety cap can keep a successful provider run below 100%.
- **ETA**: a range, not a precise promise. `Unavailable` means no reliable ETA
  signal has been observed yet; the confidence and reason are shown below it.
- **Evidence capabilities**: which structured events, tool calls, process/file
  signals, and session metadata the adapter reported as available. `not reported`
  means unavailable or unobserved, not necessarily unsupported by the provider.
- **Tests / Build / Typecheck**: objective verification statuses (`unknown`,
  `pending`, `passed`, or `failed`). These are independent from the lifecycle
  status.
- **Observer evidence**: deduplicated workspace/process/Git/test signals, with
  their source and latest reason. It is evidence supporting the projection, not
  a copy of raw provider output.
- **Timeline**: ordered normalized events. Each entry has a sequence number,
  timestamp, event type, and parser confidence. **Load more** uses the event
  cursor and should not duplicate earlier entries after reconnect.

The red banner is an API/Dashboard request error. `Offline · retrying` means the
WebSocket is reconnecting; the HTTP cursor path is used to catch up events after
it reconnects.

## 6. CLI inspection and recovery

List sessions from the same database:

```powershell
node .\apps\cli\bin\agent-scope.mjs sessions
```

Inspect one actual UUID (replace the example; do not type angle brackets in
PowerShell):

```powershell
node .\apps\cli\bin\agent-scope.mjs show 1557fc60-1fa5-4b9f-ab9a-6a3b7ad5662c
```

If Windows Ctrl+C kills the outer wrapper before its terminal event is persisted,
first verify that no real provider task is still running, then run recovery with
the same database configuration:

```powershell
node .\apps\cli\bin\agent-scope.mjs recover
```

Recovery converts stale `starting`/`running` sessions to `interrupted`. Direct
Windows Ctrl+C is not yet claimed to be an atomic terminal transition for every
PowerShell/console host.

## 7. Security and proxy notes

- The Kimi API key belongs only in the local gitignored environment file. Rotate
  a key if it was exposed outside the intended local environment.
- Clash port `7897` is a network proxy port; it is unrelated to AgentScope's API
  port `8787` and Dashboard port `5173`. Configure proxy variables for the
  provider terminal only when the local Claude/Kimi setup requires them.
- AgentScope stores normalized lifecycle/evidence data by default, not raw
  prompts, thinking traces, full tool output, or provider secrets.
