# Configuration, logging, and errors

The CLI now has a concrete local-server configuration. These values are intentionally local-only by
default; the Clash proxy port is unrelated to the port AgentScope listens on.

## Local server defaults

`agent-scope start` runs in the foreground and listens on:

| Setting | Default | CLI flag | Environment variable |
| --- | --- | --- | --- |
| Bind host | `127.0.0.1` | `--host` | `AGENTSCOPE_HOST` |
| HTTP/WebSocket port | `8787` | `--port` | `AGENTSCOPE_PORT` |
| SQLite file | `.agentscope/agentscope.db` | `--database` / `--db` | `AGENTSCOPE_DATABASE` |
| Existing server URL for query commands | `http://127.0.0.1:8787` | — | `AGENTSCOPE_SERVER_URL` |

The precedence for host, port, and database is CLI flag > environment variable > defaults. The
database parent directory is created automatically. Press `Ctrl+C` to close the foreground server
cleanly. AgentScope does not contact a provider API directly; Claude Code or another CLI keeps its
own endpoint, model, and credential configuration.

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
