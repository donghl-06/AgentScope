import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openStorage, OrchestratorRepository, StorageConflictError } from '@agentscope/storage';

import { GoalRunLeaseManager } from './lease.js';

function withRepository(test: (repository: OrchestratorRepository) => void): void {
  const filename = path.join(os.tmpdir(), `agentscope-lease-${Date.now()}-${Math.random()}.db`);
  const { client } = openStorage({ filename, migrate: true });
  try {
    const repository = new OrchestratorRepository(client);
    repository.createGoal({
      id: 'lease-goal',
      workspace: 'D:/workspace/lease',
      prompt: 'Exercise the run lease.',
      provider: 'mock',
      now: 100,
    });
    test(repository);
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
}

describe('GoalRunLeaseManager', () => {
  it('acquires, heartbeats, fences competing owners, and releases leases', () => {
    withRepository((repository) => {
      let now = 100;
      const first = new GoalRunLeaseManager({
        repository,
        ownerId: 'owner-a',
        ttlMs: 50,
        clock: { now: () => now },
      });
      const second = new GoalRunLeaseManager({
        repository,
        ownerId: 'owner-b',
        ttlMs: 50,
        clock: { now: () => now },
      });

      const firstHandle = first.acquire('lease-goal');
      expect(firstHandle).toMatchObject({ goalId: 'lease-goal', ownerId: 'owner-a', generation: 1, expiresAt: 150 });
      expect(first.isHeld(firstHandle)).toBe(true);
      expect(() => second.acquire('lease-goal')).toThrow(StorageConflictError);

      now = 125;
      const renewed = first.heartbeat(firstHandle);
      expect(renewed.expiresAt).toBe(175);
      expect(first.isHeld(firstHandle)).toBe(true);
      expect(first.isHeld(renewed)).toBe(true);
      expect(first.release(renewed)).toBe(true);
      expect(first.isHeld(renewed)).toBe(false);

      now = 180;
      const secondHandle = second.acquire('lease-goal');
      expect(secondHandle.generation).toBe(2);
      expect(() => first.heartbeat(renewed)).toThrow(StorageConflictError);
    });
  });

  it('treats an expired lease as unavailable without silently claiming it', () => {
    withRepository((repository) => {
      let now = 200;
      const manager = new GoalRunLeaseManager({
        repository,
        ownerId: 'owner-a',
        ttlMs: 10,
        clock: { now: () => now },
      });
      const handle = manager.acquire('lease-goal');
      now = 210;
      expect(manager.isHeld(handle)).toBe(false);
      expect(() => manager.assertHeld(handle)).toThrow(StorageConflictError);
    });
  });

  it('rejects invalid manager configuration', () => {
    withRepository((repository) => {
      expect(
        () => new GoalRunLeaseManager({ repository, ownerId: ' ', ttlMs: 10 }),
      ).toThrow('Lease owner must not be empty');
      expect(
        () => new GoalRunLeaseManager({ repository, ownerId: 'owner', ttlMs: 0 }),
      ).toThrow('Lease TTL must be a positive integer');
    });
  });
});
