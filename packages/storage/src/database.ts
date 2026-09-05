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

const INITIAL_MIGRATION = new URL('./migrations/0000_initial.sql', import.meta.url);

export function migrateStorage(client: Database.Database): void {
  client.exec(
    'CREATE TABLE IF NOT EXISTS _agentscope_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)',
  );
  const migrationId = '0000_initial';
  const applied = client
    .prepare('SELECT id FROM _agentscope_migrations WHERE id = ?')
    .get(migrationId) as { id: string } | undefined;
  if (applied !== undefined) return;

  const migration = client.transaction(() => {
    client.exec(readMigration(INITIAL_MIGRATION));
    client
      .prepare('INSERT INTO _agentscope_migrations (id, applied_at) VALUES (?, ?)')
      .run(migrationId, Date.now());
  });
  migration();
}

function readMigration(url: URL): string {
  // Keep migration loading in this package so callers never construct SQL paths themselves.
  return fs.readFileSync(url, 'utf8');
}

export function openStorage(options: OpenStorageOptions): OpenStorageResult {
  const client = new Database(options.filename);
  client.pragma('foreign_keys = ON');
  client.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
  if (options.filename !== ':memory:') client.pragma('journal_mode = WAL');
  if (options.migrate === true) migrateStorage(client);
  const db = drizzle(client, { schema: storageTables });
  return { client, db };
}
