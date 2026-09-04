# ADR-0003: Use local SQLite with Drizzle-managed schema

- Status: Accepted
- Date: 2026-09-05

## Context

V0 is local-first and single-user, but needs durable ordered events, transactions, migrations, restart recovery, indexed cursor queries, and typed schema access. A server database would add deployment scope without solving a V0 need.

## Decision

Use SQLite as the local durable store and Drizzle ORM/Kit for typed schema definitions and checked-in migrations.

The runtime driver is `better-sqlite3` with Drizzle's `drizzle-orm/better-sqlite3` adapter. The Phase 0/4 install spike compared it with the built-in `node:sqlite` API on Windows native Node 24.14.1. Both drivers passed direct SQLite behavior checks, but the current stable Drizzle release exposes a first-class better-sqlite3 adapter and no `node:sqlite` adapter export. This keeps the driver-specific surface inside `packages/storage` while avoiding an untyped proxy integration.

## Driver close criteria

- No experimental runtime flag in the declared minimum Node version.
- Reliable install on Windows and the secondary target platform.
- Supports foreign keys, WAL, busy timeout, explicit transactions, and cleanup.
- Compatible with the selected stable Drizzle release; release-candidate-only integration requires an explicit follow-up decision.
- Temporary-database integration tests pass.

## Spike evidence (2026-09-05)

- `better-sqlite3@13.0.3` installed and loaded successfully on Windows native after allowing its normal native build step.
- `drizzle-orm@0.45.2` integrated successfully through `drizzle-orm/better-sqlite3` for schema-backed insert/select.
- Both candidates passed file-backed WAL, foreign-key enforcement, busy timeout configuration, explicit transaction, and cleanup checks.
- `drizzle-orm@0.45.2` does not export `drizzle-orm/node-sqlite`; using `node:sqlite` would require a custom proxy adapter and would not satisfy the first-class integration criterion.

## Consequences

- SQLite is the source of truth; WebSocket delivery is not durable state.
- Schema changes use migrations, never ad hoc startup mutation.
- Event append and session projection update share one transaction.
- WAL/SHM/database files are local artifacts and Git-ignored.
- Driver-specific APIs stay inside `packages/storage`.

## References

- https://orm.drizzle.team/docs/sqlite/get-started-sqlite
- https://orm.drizzle.team/docs/get-started/node-sqlite-new
- https://nodejs.org/api/sqlite.html
