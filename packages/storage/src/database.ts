import Database from 'better-sqlite3';
import fs from 'node:fs';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { storageTables } from './schema.js';

export type StorageDatabase = BetterSQLite3Database<typeof storageTables>;

export interface OpenStorageOptions {
  readonly filename: string;
  readonly busyTimeoutMs?: number;
  readonly migrate?: boolean;
}

export interface OpenStorageResult {
  readonly client: Database.Database;
  readonly db: StorageDatabase;
}

const MIGRATIONS = [
  { id: '0000_initial', url: new URL('./migrations/0000_initial.sql', import.meta.url) },
  {
    id: '0001_session_status_updated_index',
    url: new URL('./migrations/0001_session_status_updated_index.sql', import.meta.url),
  },
  {
    id: '0002_observer_evidence',
    url: new URL('./migrations/0002_observer_evidence.sql', import.meta.url),
  },
  {
    id: '0003_turns',
    url: new URL('./migrations/0003_turns.sql', import.meta.url),
  },
  {
    id: '0004_observer_evidence_turn',
    url: new URL('./migrations/0004_observer_evidence_turn.sql', import.meta.url),
  },
  {
    id: '0005_session_visibility',
    url: new URL('./migrations/0005_session_visibility.sql', import.meta.url),
  },
  {
    id: '0006_orchestrator',
    url: new URL('./migrations/0006_orchestrator.sql', import.meta.url),
  },
  {
    id: '0007_orchestrator_single_active_goal',
    url: new URL('./migrations/0007_orchestrator_single_active_goal.sql', import.meta.url),
  },
] as const;

export function migrateStorage(client: Database.Database): void {
  client.exec(
    'CREATE TABLE IF NOT EXISTS _agentscope_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)',
  );
  for (const migration of MIGRATIONS) {
    const applied = client
      .prepare('SELECT id FROM _agentscope_migrations WHERE id = ?')
      .get(migration.id) as { id: string } | undefined;
    if (applied !== undefined) continue;
    const applyMigration = client.transaction(() => {
      client.exec(readMigration(migration.url));
      client
        .prepare('INSERT INTO _agentscope_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, Date.now());
    });
    applyMigration();
  }
}

function readMigration(url: URL): string {
  // Keep migration loading in this package so callers never construct SQL paths themselves.
  return fs.readFileSync(url, 'utf8');
}

export function openStorage(options: OpenStorageOptions): OpenStorageResult {
  const client = new Database(options.filename);
  client.pragma('foreign_keys = ON');
  client.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 30_000}`);
  if (options.filename !== ':memory:') client.pragma('journal_mode = WAL');
  if (options.migrate === true) migrateStorage(client);
  const db = drizzle(client, { schema: storageTables });
  return { client, db };
}
