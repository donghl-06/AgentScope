# Configuration, logging, and errors

Phase 1 establishes cross-layer conventions without locking in the final server or CLI option names.

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

