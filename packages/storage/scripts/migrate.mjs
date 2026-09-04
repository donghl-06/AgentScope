import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { argv, cwd } from 'node:process';
import { URL } from 'node:url';

const filename =
  argv.slice(2).find((argument) => argument !== '--') ?? path.resolve(cwd(), 'agentscope.db');
const client = new Database(filename);
client.pragma('foreign_keys = ON');
client.pragma('busy_timeout = 5000');
if (filename !== ':memory:') client.pragma('journal_mode = WAL');
client.exec(
  'CREATE TABLE IF NOT EXISTS _agentscope_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)',
);
const migrationId = '0000_initial';
const applied = client
  .prepare('SELECT id FROM _agentscope_migrations WHERE id = ?')
  .get(migrationId);
if (applied === undefined) {
  const sql = fs.readFileSync(
    new URL('../src/migrations/0000_initial.sql', import.meta.url),
    'utf8',
  );
  client.transaction(() => {
    client.exec(sql);
    client
      .prepare('INSERT INTO _agentscope_migrations (id, applied_at) VALUES (?, ?)')
      .run(migrationId, Date.now());
  })();
}
client.close();
globalThis.console.log(`Storage migrations applied: ${filename}`);
