import { describe, expect, it } from 'vitest';

import type { StoredGoal, StoredTask, StoredVerificationRun } from '@agentscope/storage';

import {
  buildMemorySnapshot,
  normalizeExecutionMemory,
  rememberTaskOutcome,
  type ExecutionMemory,
} from './index.js';

const goal = {
  id: 'memory-goal',
  prompt: 'Improve the safe execution flow with apiKey=sk-1234567890abcdefghijklmnop',
  activeRevision: 3,
} as Pick<StoredGoal, 'id' | 'prompt' | 'activeRevision'>;

const completedTask = {
  id: 'memory-goal:task:1',
  title: 'Implement the safe flow',
  objective: 'Keep the execution boundary auditable.',
  status: 'COMPLETED',
  sequence: 1,
  endedAt: 120,
  updatedAt: 120,
} as StoredTask;

const verification = {
  id: 'memory-goal:task:1:verification:1',
  taskId: completedTask.id,
  status: 'PASS',
  reason: 'Deterministic checks passed.',
  createdAt: 121,
} as StoredVerificationRun;

describe('execution memory snapshots', () => {
  it('builds bounded, source-linked memory and redacts secret-shaped text', () => {
    const memory: ExecutionMemory = {
      goalSummary: goal.prompt,
      decisions: [
        {
          id: 'decision:no-push',
          summary: 'Never push changes to a remote repository.',
          status: 'LOCKED',
          source: 'user',
          recordedAt: 10,
          sourceRefs: [{ kind: 'instruction', id: 'instruction:no-push' }],
        },
      ],
      completedTaskIds: [],
      failedApproaches: ['apiKey=sk-1234567890abcdefghijklmnop'],
      notes: ['Keep the original verification evidence.'],
      issues: [
        {
          id: 'issue:verification',
          summary: 'The final verification is still open.',
          status: 'OPEN',
          recordedAt: 11,
          sourceRefs: [{ kind: 'task', id: completedTask.id }],
        },
      ],
      questions: [
        {
          id: 'question:scope',
          question: 'Does the requested scope include the Dashboard?',
          status: 'OPEN',
          recordedAt: 12,
          sourceRefs: [{ kind: 'goal', id: goal.id }],
        },
      ],
    };

    const result = buildMemorySnapshot({
      goal,
      tasks: [completedTask],
      verificationRuns: [verification],
      executionMemory: memory,
      reason: 'after-attempt',
      now: 130,
    });

    expect(result.memory).toMatchObject({
      schemaVersion: 1,
      activeRevision: 3,
      completedTaskIds: [],
      completedTaskSummaries: [
        {
          taskId: completedTask.id,
          verificationStatus: 'PASS',
          sourceRefs: [
            { kind: 'task', id: completedTask.id },
            { kind: 'verification', id: verification.id },
          ],
        },
      ],
      issues: [{ id: 'issue:verification', status: 'OPEN' }],
      questions: [{ id: 'question:scope', status: 'OPEN' }],
    });
    expect(JSON.stringify(result.memory)).not.toContain('sk-1234567890abcdefghijklmnop');
    expect(result.sources).toEqual(
      expect.arrayContaining([
        { kind: 'goal', id: goal.id },
        { kind: 'roadmap-revision', id: `${goal.id}:revision:3` },
        { kind: 'instruction', id: 'instruction:no-push' },
        { kind: 'verification', id: verification.id },
      ]),
    );
  });

  it('records a completed outcome without discarding prior decisions', () => {
    const memory: ExecutionMemory = {
      decisions: [
        {
          id: 'decision:locked',
          summary: 'Keep the worker serial.',
          status: 'LOCKED',
          source: 'system',
          recordedAt: 1,
        },
      ],
      completedTaskIds: [],
      failedApproaches: [],
      notes: [],
    };
    const next = rememberTaskOutcome(memory, completedTask, verification, 'Task passed.', 122);
    expect(next.decisions).toHaveLength(1);
    expect(next.completedTaskIds).toEqual([completedTask.id]);
    expect(next.completedTaskSummaries).toMatchObject([
      { taskId: completedTask.id, verificationStatus: 'PASS' },
    ]);
    expect(next.sourceRefs).toEqual(
      expect.arrayContaining([
        { kind: 'task', id: completedTask.id },
        { kind: 'verification', id: verification.id },
      ]),
    );
  });

  it('drops malformed optional memory entries while retaining the stable core', () => {
    const normalized = normalizeExecutionMemory(
      {
        decisions: [],
        completedTaskIds: ['task:1', 42] as unknown as readonly string[],
        failedApproaches: [],
        notes: [],
        issues: [null, { id: 'valid', summary: 'open', status: 'OPEN', recordedAt: 1 }],
      } as unknown as ExecutionMemory,
      10,
    );
    expect(normalized.completedTaskIds).toEqual(['task:1']);
    expect(normalized.issues).toMatchObject([{ id: 'valid', status: 'OPEN' }]);
  });
});
