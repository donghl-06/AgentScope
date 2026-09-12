import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { migrateStorage, openStorage } from './database.js';
import { OrchestratorRepository } from './orchestrator.js';

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
        'approval_requests',
        'eta_snapshots',
        'events',
        'goal_instructions',
        'goal_metric_snapshots',
        'goal_run_leases',
        'goals',
        'memory_snapshots',
        'milestones',
        'observer_evidence',
        'orchestrator_commands',
        'orchestrator_events',
        'orchestrator_notifications',
        'roadmap_revision_items',
        'roadmap_revisions',
        'sessions',
        'task_attempts',
        'tasks',
        'turns',
        'verification_runs',
      ]);
      expect(client.prepare('SELECT count(*) AS count FROM _agentscope_migrations').get()).toEqual({
        count: 11,
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
        count: 11,
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

  it('adds v1 control columns and tables without changing existing Goal data', () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    try {
      const repository = new OrchestratorRepository(client);
      repository.createGoal({
        id: 'legacy-goal',
        workspace: 'D:/legacy-workspace',
        prompt: 'Keep this V0 Goal readable after the V1 migration.',
        provider: 'mock',
      });

      const columns = client.prepare('PRAGMA table_info(goals)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['active_revision', 'archived_at']),
      );
      expect(
        client
          .prepare('SELECT active_revision, archived_at FROM goals WHERE id = ?')
          .get('legacy-goal'),
      ).toEqual({ active_revision: 0, archived_at: null });
      expect(
        client
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get('goal_run_leases'),
      ).toBeDefined();
      expect(
        client
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get('orchestrator_commands'),
      ).toBeDefined();
      expect(
        client
          .prepare('PRAGMA table_info(goal_instructions)')
          .all()
          .some((column) => (column as { name?: string }).name === 'source'),
      ).toBe(true);
    } finally {
      client.close();
    }
  });
});
