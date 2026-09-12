import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openStorage } from './database.js';
import { StorageConflictError } from './repository.js';
import {
  OrchestratorRepository,
  OrchestratorStateError,
  type WorkerResult,
} from './orchestrator.js';

function withRepository(test: (repository: OrchestratorRepository) => void): void {
  const filename = path.join(
    os.tmpdir(),
    `agentscope-orchestrator-${Date.now()}-${Math.random()}.db`,
  );
  const { client } = openStorage({ filename, migrate: true });
  try {
    test(new OrchestratorRepository(client));
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

describe('OrchestratorRepository', () => {
  it('persists the goal/task/attempt/verification lifecycle and event sequence', () => {
    withRepository((repository) => {
      const notifications: string[] = [];
      repository.subscribe((notification) => notifications.push(notification.type));

      const goal = repository.createGoal({
        id: 'goal-1',
        workspace: 'D:/workspace/example',
        prompt: 'Implement a safe feature.',
        provider: 'claude',
        now: 100,
      });
      expect(goal.status).toBe('CREATED');
      repository.transitionGoal('goal-1', 'PLANNING', 110);
      repository.transitionGoal('goal-1', 'RUNNING', 120);

      const task = repository.createTask({
        id: 'task-1',
        goalId: 'goal-1',
        title: 'Implement feature',
        objective: 'Make the requested change.',
        acceptanceCriteria: ['The feature is present.'],
        verification: { checks: [{ id: 'typecheck', executable: 'pnpm', args: ['typecheck'] }] },
        sequence: 1,
        now: 130,
      });
      expect(task.maxAttempts).toBe(3);
      repository.transitionTask('task-1', 'RUNNING', 140);

      const attempt = repository.createAttempt({
        id: 'attempt-1',
        taskId: 'task-1',
        attemptNumber: 1,
        provider: 'claude',
        now: 150,
      });
      repository.updateAttempt('attempt-1', { status: 'RUNNING' }, 160);
      const workerResult: WorkerResult = {
        claimedStatus: 'completed',
        summary: 'Implemented the feature.',
        changedFiles: ['src/feature.ts'],
        reportedVerification: { tests: 'passed' },
      };
      const completedAttempt = repository.updateAttempt(
        'attempt-1',
        { status: 'COMPLETED', workerResult },
        170,
      );
      expect(completedAttempt.workerResult).toEqual(workerResult);

      repository.transitionTask('task-1', 'VERIFYING', 180);
      const verification = repository.createVerificationRun({
        id: 'verification-1',
        taskId: 'task-1',
        attemptId: attempt.id,
        status: 'PASS',
        criteria: ['The feature is present.'],
        deterministicChecks: [{ id: 'typecheck', exitCode: 0 }],
        evidence: [{ kind: 'git-diff', files: ['src/feature.ts'] }],
        reason: 'All deterministic checks passed.',
        now: 190,
      });
      expect(verification.status).toBe('PASS');
      repository.transitionTask('task-1', 'COMPLETED', 200);
      repository.transitionGoal('goal-1', 'VERIFYING', 210);
      repository.transitionGoal('goal-1', 'COMPLETED', 220);

      const firstEvent = repository.appendEvent({
        id: 'event-1',
        goalId: 'goal-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        type: 'task.completed',
        payload: { status: 'PASS' },
        confidence: 1,
        timestamp: 230,
      });
      const secondEvent = repository.appendEvent({
        id: 'event-2',
        goalId: 'goal-1',
        type: 'goal.completed',
        payload: { verified: true },
        confidence: 1,
        timestamp: 240,
      });
      expect([firstEvent.seq, secondEvent.seq]).toEqual([1, 2]);
      expect(repository.listEvents('goal-1')).toHaveLength(2);
      expect(repository.listTasks('goal-1')[0]).toMatchObject({ status: 'COMPLETED' });
      expect(repository.getGoal('goal-1')).toMatchObject({ status: 'COMPLETED', completedAt: 220 });
      expect(notifications).toEqual([
        'goal.created',
        'goal.updated',
        'goal.updated',
        'task.created',
        'task.updated',
        'attempt.created',
        'attempt.updated',
        'attempt.updated',
        'task.updated',
        'verification.created',
        'task.updated',
        'goal.updated',
        'goal.updated',
        'event.appended',
        'event.appended',
      ]);
    });
  });

  it('rejects unsafe status transitions instead of silently rewriting state', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'goal-invalid',
        workspace: 'D:/workspace/example',
        prompt: 'Do not complete without verification.',
        provider: 'codex',
      });
      expect(() => repository.transitionGoal('goal-invalid', 'COMPLETED')).toThrow(
        OrchestratorStateError,
      );
      repository.createTask({
        id: 'task-invalid',
        goalId: 'goal-invalid',
        title: 'Pending task',
        objective: 'Wait for a worker.',
        acceptanceCriteria: [],
        sequence: 1,
      });
      expect(() => repository.transitionTask('task-invalid', 'COMPLETED')).toThrow(
        OrchestratorStateError,
      );
    });
  });

  it('enforces one active Goal across repository instances', () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const first = new OrchestratorRepository(client);
    const second = new OrchestratorRepository(client);
    first.createGoal({
      id: 'active-one',
      workspace: 'D:/workspace',
      prompt: 'First active goal',
      provider: 'mock',
    });
    first.transitionGoal('active-one', 'PLANNING');
    second.createGoal({
      id: 'active-two',
      workspace: 'D:/workspace',
      prompt: 'Second active goal',
      provider: 'mock',
    });

    expect(() => second.transitionGoal('active-two', 'PLANNING')).toThrow(StorageConflictError);
    expect(first.getGoal('active-one').status).toBe('PLANNING');
    client.close();
  });
});
