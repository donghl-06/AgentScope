# Configuration, logging, and errors

The CLI now has a concrete local-server configuration. These values are intentionally local-only by
default; the Clash proxy port is unrelated to the port AgentScope listens on.

## Local server defaults

`agent-scope start` runs in the foreground and listens on:

| Setting | Default | CLI flag | Environment variable |
| --- | --- | --- | --- |
| Bind host | `127.0.0.1` | `--host` | `AGENTSCOPE_HOST` |
| HTTP/WebSocket port | `8787` | `--port` | `AGENTSCOPE_PORT` |
| Dashboard dev port | `5173` | `--dashboard-port` | `AGENTSCOPE_DASHBOARD_PORT` |
| SQLite file | `.agentscope/agentscope.db` | `--database` / `--db` | `AGENTSCOPE_DATABASE` |
| Existing server URL for query commands | `http://127.0.0.1:8787` | — | `AGENTSCOPE_SERVER_URL` |
| Interactive task text retention | `full` | — | `AGENTSCOPE_PROMPT_RETENTION` |

The precedence for host, ports, and database is CLI flag > environment variable > defaults. By
default `agent-scope start` launches both the server and the repository-local Vite Dashboard. Use
`--no-dashboard` for server-only mode. The database parent directory is created automatically.
SQLite uses WAL mode with a 30-second default busy timeout so short concurrent writes wait instead
of failing immediately; callers can override this when constructing the storage package directly.
Press `Ctrl+C` to close the foreground server and Dashboard cleanly. AgentScope does not contact a provider API directly; Claude Code or another CLI keeps its
own endpoint, model, and credential configuration.

## Interactive task text retention

`agent-scope claude` stores a compact task title for each submitted turn so the Dashboard remains
navigable. By default, it also stores the locally redacted submitted task text (`full`) so a turn
can retain its complete user-visible request. Set `AGENTSCOPE_PROMPT_RETENTION=title` before
starting the interactive CLI to keep only the compact title; no full task text is stored in the
turn projection. This setting does not enable raw terminal transcript capture, which remains off.

## Configuration precedence

`packages/shared` exposes `mergeConfig`, which applies values in this order:

```text
CLI flags > environment variables > config file > defaults
```

The merge is intentionally shallow. A concrete nested configuration schema belongs to the server/CLI phase and must add runtime validation before values cross a package boundary.

## Logging

Logs are structured records with a level, ISO timestamp, message, and optional context. The shared logger redacts keys matching the following categories before serializing context:

- API keys and authorization/cookie values
- passwords, secrets, and tokens
- prompts and environment values

Raw provider output is not passed to the logger by default. Correlation identifiers such as `sessionId` are safe diagnostic context when they do not contain provider payloads.

## Errors

`AgentScopeError` carries a stable machine-readable code and optional diagnostic details. V0 distinguishes user input, provider, storage, and internal errors. Callers should preserve the code at API/CLI boundaries and avoid exposing `cause` or sensitive details directly to users.
