# Troubleshooting

This page covers the Windows native PowerShell workflow used by the current V0
smoke tests. Commands assume the repository is at
`D:\大学\项目\AgentScope`; replace the path if the checkout differs.

## The CLI reports `MODULE_NOT_FOUND`

The command must run from the AgentScope checkout, not from the parent directory:

```powershell
Set-Location -LiteralPath 'D:\大学\项目\AgentScope'
Test-Path .\apps\cli\bin\agent-scope.mjs
node .\apps\cli\bin\agent-scope.mjs --help
```

If the first command returns `False`, locate the checkout again. Do not create a
second project directory to work around a wrong current directory.

## Corepack asks to download pnpm

The workspace pins a pnpm version through `packageManager`. The first
`pnpm` invocation may ask Corepack to download that version. Approve it only when
the URL is the expected npm registry, then rerun the command if needed.

## Database path and session history

Use a repository-local database consistently in every terminal:

```powershell
$env:AGENTSCOPE_DATABASE = Join-Path (Get-Location) '.agentscope\agentscope.db'
node .\apps\cli\bin\agent-scope.mjs sessions
```

Do not open the same SQLite database from two independent AgentScope server
instances. A `database is locked` error usually means a duplicate server or a
previous process still owns the file. Stop the duplicate process first; do not
delete the database as a first response.

## Server and Dashboard ports

The default local split is server `127.0.0.1:8787` and Vite Dashboard
`localhost:5173`:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Test-NetConnection 127.0.0.1 -Port 8787
```

The CLI can write sessions directly to SQLite, but Dashboard live updates need
the server and its WebSocket endpoint to remain available. If the port is busy,
inspect the owning process before choosing another port and update the Dashboard
proxy configuration consistently.

## A provider command prints nothing

First determine whether the PowerShell prompt returned:

- If it did not return, the provider may still be starting or waiting for an
  approval/authentication step. Wait briefly before interrupting it.
- If it returned, inspect the persisted result instead of assuming success:

```powershell
node .\apps\cli\bin\agent-scope.mjs sessions
```

Use `show <session-id>` to inspect normalized events. Do not paste raw provider
streams containing prompts, thinking signatures, paths, usage, or diagnostics into
the repository.

## Claude-compatible endpoint errors

An HTTP `403` concurrent-request error means the configured endpoint rejected the
request before a provider tool ran. AgentScope should record `failed`; this is a
provider/account limit, not evidence of a parser failure. Wait for outstanding
requests to finish and avoid launching many parallel Claude requests.

Keep endpoint and API key configuration in a local ignored file such as
`.env.claude-test.ps1`. Never commit it, print the key, or put it in a fixture.
Rotate a key that has been pasted into chat or logs.

## Codex stderr warnings

Codex structured JSONL is read from stdout. Runtime warnings about PowerShell
shell snapshots, plugin icons, model refresh, or analytics may appear on stderr;
they are diagnostics and must not be parsed as protocol events. Check the
normalized session status and timeline instead.

## Interrupted or orphaned sessions

`Ctrl+C` should result in `interrupted`, not `completed`. If the wrapper terminal
has already exited but the database still shows `running`, do not kill every
`node` or `claude` process. Identify the exact process/session first. The server's
startup recovery marks stale `starting`/`running` sessions as interrupted; a
targeted recovery is safer than editing unrelated records.

## Unicode and spaces in paths

Use `Set-Location -LiteralPath` and pass child-process arguments as an array. Do
not build a shell command string or rely on unquoted paths. The Windows native
smoke path includes non-ASCII characters and is covered by the current CLI setup.

## What to report when asking for help

Provide only:

- the exact command shape with secrets and full prompts removed;
- whether the prompt returned;
- the session `status`, `provider`, and `adapter`;
- a short error code/message;
- the CLI and Node versions.

Avoid raw JSONL, environment dumps, API keys, full command output, and unrelated
process lists.
