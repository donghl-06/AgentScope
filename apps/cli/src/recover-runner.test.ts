import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInitialSessionState } from '@agentscope/protocol';
import { openStorage, StorageRepository } from '@agentscope/storage';

import { recoverSessions } from './recover-runner.js';

describe('recoverSessions', () => {
  it('recovers only non-terminal sessions and closes the database', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-recover-'));
    const filename = path.join(directory, 'session.db');
    try {
      const storage = openStorage({ filename, migrate: true });
      const repository = new StorageRepository(storage.client);
      const running = createInitialSessionState('running', 100);
      const completed = {
        ...createInitialSessionState('completed', 100),
        status: 'completed' as const,
      };
      repository.createSession({
        id: 'running',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 100,
        capabilities: {},
        state: { ...running, status: 'running' },
      });
      repository.createSession({
        id: 'completed',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 100,
        capabilities: {},
        state: completed,
      });
      storage.client.close();

      expect(recoverSessions(filename, () => 200)).toEqual({
        count: 1,
        recovered: [{ id: 'running', status: 'interrupted', endedAt: 200 }],
      });

      const check = openStorage({ filename, migrate: false });
      const checked = new StorageRepository(check.client);
      expect(checked.getSession('running').status).toBe('interrupted');
      expect(checked.getSession('completed').status).toBe('completed');
      check.client.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
