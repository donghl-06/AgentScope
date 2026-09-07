import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { migrateStorage, openStorage } from './database.js';

describe('storage database', () => {
  it('opens with SQLite safety pragmas and applies an idempotent migration', () => {
    const filename = path.join(os.tmpdir(), `agentscope-storage-${Date.now()}-${Math.random()}.db`);
    const { client } = openStorage({ filename, busyTimeoutMs: 7_500 });
    try {
      migrateStorage(client);
      migrateStorage(client);

      expect(client.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(client.pragma('busy_timeout', { simple: true })).toBe(7_500);
      expect(client.pragma('journal_mode', { simple: true })).toBe('wal');
      const tables = client
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(
        tables.map((table) => table.name).filter((name) => name !== 'sqlite_sequence'),
      ).toEqual([
        '_agentscope_migrations',
        'eta_snapshots',
        'events',
        'milestones',
        'observer_evidence',
        'sessions',
        'turns',
      ]);
      expect(client.prepare('SELECT count(*) AS count FROM _agentscope_migrations').get()).toEqual({
        count: 4,
      });
      expect(
        client
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get('sessions_status_updated_idx'),
      ).toBeDefined();
    } finally {
      client.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(filename + suffix);
        } catch {
          // Best-effort cleanup for SQLite sidecar files.
        }
      }
    }
  });

  it('upgrades a database that already has the 0000 migration', () => {
    const { client } = openStorage({ filename: ':memory:' });
    try {
      client.exec(
        'CREATE TABLE _agentscope_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)',
      );
      client.exec(
        fs.readFileSync(new URL('./migrations/0000_initial.sql', import.meta.url), 'utf8'),
      );
      client
        .prepare('INSERT INTO _agentscope_migrations (id, applied_at) VALUES (?, ?)')
        .run('0000_initial', 1);
      migrateStorage(client);

      expect(client.prepare('SELECT count(*) AS count FROM _agentscope_migrations').get()).toEqual({
        count: 4,
      });
      expect(
        client
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get('sessions_status_updated_idx'),
      ).toBeDefined();
    } finally {
      client.close();
    }
  });
});
