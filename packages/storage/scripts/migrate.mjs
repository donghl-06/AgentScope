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
const migrations = [
  { id: '0000_initial', url: new URL('../src/migrations/0000_initial.sql', import.meta.url) },
  {
    id: '0001_session_status_updated_index',
    url: new URL('../src/migrations/0001_session_status_updated_index.sql', import.meta.url),
  },
  {
    id: '0002_observer_evidence',
    url: new URL('../src/migrations/0002_observer_evidence.sql', import.meta.url),
  },
  {
    id: '0003_turns',
    url: new URL('../src/migrations/0003_turns.sql', import.meta.url),
  },
  {
    id: '0004_observer_evidence_turn',
    url: new URL('../src/migrations/0004_observer_evidence_turn.sql', import.meta.url),
  },
  {
    id: '0005_session_visibility',
    url: new URL('../src/migrations/0005_session_visibility.sql', import.meta.url),
  },
  {
    id: '0006_orchestrator',
    url: new URL('../src/migrations/0006_orchestrator.sql', import.meta.url),
  },
  {
    id: '0007_orchestrator_single_active_goal',
    url: new URL('../src/migrations/0007_orchestrator_single_active_goal.sql', import.meta.url),
  },
  {
    id: '0008_orchestrator_v1_control',
    url: new URL('../src/migrations/0008_orchestrator_v1_control.sql', import.meta.url),
  },
  {
    id: '0009_orchestrator_commands',
    url: new URL('../src/migrations/0009_orchestrator_commands.sql', import.meta.url),
  },
  {
    id: '0010_instruction_source',
    url: new URL('../src/migrations/0010_instruction_source.sql', import.meta.url),
  },
  {
    id: '0011_observer_evidence_attempt',
    url: new URL('../src/migrations/0011_observer_evidence_attempt.sql', import.meta.url),
  },
];
for (const migration of migrations) {
  const applied = client
    .prepare('SELECT id FROM _agentscope_migrations WHERE id = ?')
    .get(migration.id);
  if (applied !== undefined) continue;
  const sql = fs.readFileSync(migration.url, 'utf8');
  client.transaction(() => {
    client.exec(sql);
    client
      .prepare('INSERT INTO _agentscope_migrations (id, applied_at) VALUES (?, ?)')
      .run(migration.id, Date.now());
  })();
}
client.close();
globalThis.console.log(`Storage migrations applied: ${filename}`);
