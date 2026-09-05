import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openStorage, StorageRepository } from '@agentscope/storage';

import { runMockFixture } from './mock-runner.js';

describe('mock CLI runner', () => {
  it('persists a successful fixture and returns exit 0', async () => {
    const result = await runMockFixture({
      filename: ':memory:',
      fixture: 'basic-success',
      sessionId: 'session-1',
      workspacePath: '.',
      speed: 0,
      now: () => 1_700_000_000_000,
    });

    expect(result).toMatchObject({ status: 'completed', exitCode: 0, eventCount: 10 });
  });

  it('maps fixture failure and interruption to distinct exit codes', async () => {
    const failure = await runMockFixture({
      filename: ':memory:',
      fixture: 'test-failure',
      sessionId: 'failed',
      workspacePath: '.',
      speed: 0,
    });
    const interrupted = await runMockFixture({
      filename: ':memory:',
      fixture: 'interrupted',
      sessionId: 'interrupted',
      workspacePath: '.',
      speed: 0,
    });

    expect(failure).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(interrupted).toMatchObject({ status: 'interrupted', exitCode: 130 });
  });

  it('leaves a queryable terminal session in a file database', async () => {
    const filename = path.join(os.tmpdir(), `agentscope-cli-${Date.now()}-${Math.random()}.db`);
    try {
      await runMockFixture({
        filename,
        fixture: 'blocked-then-resumed',
        sessionId: 'session-1',
        workspacePath: '.',
        speed: 0,
      });
      const storage = openStorage({ filename, migrate: true });
      const repository = new StorageRepository(storage.client);
      const session = repository.getSession('session-1');
      expect(session).toMatchObject({ status: 'completed' });
      expect(session.state.progress.value).toBeLessThanOrEqual(0.6);
      expect(session.state.progress.reasons.map((reason) => reason.code)).toContain(
        'completion_unverified',
      );
      const snapshots = repository.listEtaSnapshots('session-1');
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots.length).toBeLessThan(8);
      storage.client.close();
    } finally {
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
