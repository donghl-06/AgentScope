# SQLite driver comparison

Date: 2026-09-05  
Host: Windows native, Node.js v24.14.1, pnpm 11.19.0  
Temporary packages: `better-sqlite3@13.0.3`, `drizzle-orm@0.45.2`

## Results

| Criterion | `node:sqlite` | `better-sqlite3` |
|---|---|---|
| Basic open/close and prepared statements | Passed | Passed |
| Foreign keys | Passed (`ERR_SQLITE_ERROR`) | Passed (`SQLITE_CONSTRAINT_FOREIGNKEY`) |
| WAL and busy timeout | Passed on file-backed DB | Passed on file-backed DB |
| Explicit transaction | Passed | Passed (`db.transaction`) |
| Windows install/load | Built into Node 24; emits experimental warning | Installed and native module loaded successfully after the normal build step |
| Drizzle integration | No `drizzle-orm/node-sqlite` export in 0.45.2; would require a custom proxy | First-class `drizzle-orm/better-sqlite3` adapter passed insert/select |
| Cleanup | Passed | Passed |

## Decision

Use `better-sqlite3` inside `packages/storage`. The decisive factor is the stable, first-class Drizzle integration, not raw SQLite feature coverage. `node:sqlite` remains a possible future option if Drizzle adds a maintained adapter and the Node 22 baseline is revalidated.

