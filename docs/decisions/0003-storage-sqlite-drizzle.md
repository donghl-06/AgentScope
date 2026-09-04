# ADR-0003: Use local SQLite with Drizzle-managed schema

- Status: Accepted with driver follow-up
- Date: 2026-09-05

## Context

V0 is local-first and single-user, but needs durable ordered events, transactions, migrations, restart recovery, indexed cursor queries, and typed schema access. A server database would add deployment scope without solving a V0 need.

## Decision

Use SQLite as the local durable store and Drizzle ORM/Kit for typed schema definitions and checked-in migrations.

The concrete runtime driver remains open until the Phase 1 install spike compares stable `better-sqlite3` with `node:sqlite` on the declared Node 22+ and Windows baseline.

## Driver close criteria

- No experimental runtime flag in the declared minimum Node version.
- Reliable install on Windows and the secondary target platform.
- Supports foreign keys, WAL, busy timeout, explicit transactions, and cleanup.
- Compatible with the selected stable Drizzle release; release-candidate-only integration requires an explicit follow-up decision.
- Temporary-database integration tests pass.

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
