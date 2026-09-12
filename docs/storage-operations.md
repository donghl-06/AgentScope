# SQLite storage operations

AgentScope keeps its local state in one SQLite database. The default path is
`.agentscope/agentscope.db`; use `AGENTSCOPE_DATABASE` or the CLI `--database`/`--db`
option to select another path.

## Migration policy

The storage package owns the migration list and applies pending migrations in order
when the server opens the database. Current migrations are:

| Migration | Purpose |
| --- | --- |
| `0000_initial` | Projects, sessions, events, milestones, and ETA snapshots |
| `0001_session_status_updated_index` | Index for session status/update queries |
| `0002_observer_evidence` | Process, workspace, and known-command evidence |
| `0003_turns` | Turn projections owned by a session |
| `0004_observer_evidence_turn` | Optional turn ownership for observer evidence |
| `0005_session_visibility` | Nullable `hidden_at` marker and visibility index |

Do not delete rows from `_agentscope_migrations`, rename migration files, or edit an
already-applied migration. A changed schema must be introduced as a new migration.
The application does not perform automatic downgrades.

## Session cleanup semantics

The Dashboard's **Hide** action is a reversible soft cleanup: it sets
`sessions.hidden_at`, excludes the session from the default list and overview
counts, and keeps its events, turns, evidence and ETA history. Enable **Show
hidden** to restore or permanently remove it.

The **Delete** action is irreversible at the database level. It deletes the
Session row and relies on the foreign-key cascade to remove its turns, events,
milestones, ETA snapshots and observer evidence. Running or starting sessions
are rejected with HTTP 409 and are never offered cleanup buttons in the
Dashboard. A hidden completed session still contributes to the historical ETA
baseline; a permanently deleted session no longer does.

## Backup before upgrades or experiments

1. Stop the foreground server and any CLI process using the database.
2. Copy the database file and, if present, its sibling `-wal` and `-shm` files to a
   dated backup directory. Keeping the three files together avoids an incomplete WAL
   backup.
3. Record the AgentScope commit, Node version, and database path next to the backup.
4. Start AgentScope again and run `pnpm test` plus the relevant manual smoke before
   making the backup the only copy.

Example PowerShell procedure (replace the paths with the actual database path):

```powershell
$source = (Resolve-Path '.agentscope/agentscope.db').Path
$backup = Join-Path (Get-Location) (".agentscope/backups/" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item -LiteralPath $source -Destination $backup
foreach ($suffix in @('-wal', '-shm')) {
  $sidecar = $source + $suffix
  if (Test-Path -LiteralPath $sidecar) { Copy-Item -LiteralPath $sidecar -Destination $backup }
}
```

## Restore or roll back

1. Stop AgentScope and keep the current database directory as a quarantine copy;
   do not overwrite it until the restored copy has been checked.
2. Restore `agentscope.db` and any backed-up `-wal`/`-shm` sidecars together.
3. Start the exact commit that created the backup. If a newer commit has already
   migrated the database, restore the backup into a separate path first and verify it
   before switching `AGENTSCOPE_DATABASE`.
4. Check `/healthz`, list sessions, and inspect one session's events/evidence before
   resuming provider work.

Rollback is a file restore, not a reverse migration. Keep the quarantine copy until
the restored history and observer evidence have been verified.

## Lock and corruption precautions

- Only one AgentScope server should own a database path at a time.
- The server uses WAL mode and a bounded SQLite busy timeout; a persistent `database
  is busy` error means another process is still using the file or a transaction is
  stuck. Stop duplicate processes before retrying.
- Never copy or edit a live database while a provider session is writing. Stop the
  writer first, then back up all SQLite sidecars together.
- Raw provider output is not stored by default. Database backups still contain
  workspace paths, event payloads, and observer metadata; protect them like local
  development data.
