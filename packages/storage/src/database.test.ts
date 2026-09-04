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
      ).toEqual(['_agentscope_migrations', 'eta_snapshots', 'events', 'milestones', 'sessions']);
      expect(client.prepare('SELECT count(*) AS count FROM _agentscope_migrations').get()).toEqual({
        count: 1,
      });
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
});
