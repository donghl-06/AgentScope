import { describe, expect, it } from 'vitest';

import type { StoredGoal, StoredTask, StoredVerificationRun } from '@agentscope/storage';

import {
  buildMemorySnapshot,
  compactExecutionMemory,
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

  it('compacts reconstructible history while retaining locked and unresolved context', () => {
    const memory: ExecutionMemory = {
      decisions: [
        {
          id: 'locked-boundary',
          summary: 'The worker remains serial.',
          status: 'LOCKED',
          source: 'user',
          recordedAt: 1,
          sourceRefs: [{ kind: 'instruction', id: 'instruction:serial' }],
        },
        ...Array.from({ length: 45 }, (_, index) => ({
          id: `tentative:${index}`,
          summary: `Tentative decision ${index}`,
          status: 'TENTATIVE' as const,
          source: 'planner' as const,
          recordedAt: index + 2,
        })),
      ],
      completedTaskIds: ['task:old', 'task:new'],
      completedTaskSummaries: Array.from({ length: 25 }, (_, index) => ({
        taskId: `task:${index}`,
        title: `Task ${index}`,
        summary: `Task ${index} passed`,
        verificationStatus: 'PASS' as const,
        recordedAt: index + 1,
        sourceRefs: [{ kind: 'task' as const, id: `task:${index}` }],
      })),
      failedApproaches: ['The first approach failed.'],
      issues: [
        {
          id: 'issue:open',
          summary: 'Keep the open issue.',
          status: 'OPEN',
          recordedAt: 1,
          sourceRefs: [{ kind: 'task', id: 'task:old' }],
        },
        ...Array.from({ length: 25 }, (_, index) => ({
          id: `issue:resolved:${index}`,
          summary: `Resolved issue ${index}`,
          status: 'RESOLVED' as const,
          recordedAt: index + 2,
          sourceRefs: [{ kind: 'event' as const, id: `event:${index}` }],
        })),
      ],
      questions: [
        {
          id: 'question:open',
          question: 'Keep this open question.',
          status: 'OPEN',
          recordedAt: 1,
          sourceRefs: [{ kind: 'goal', id: goal.id }],
        },
        ...Array.from({ length: 25 }, (_, index) => ({
          id: `question:answered:${index}`,
          question: `Answered question ${index}`,
          status: 'ANSWERED' as const,
          recordedAt: index + 2,
          sourceRefs: [{ kind: 'event' as const, id: `question-event:${index}` }],
        })),
      ],
      notes: [],
    };
    const result = compactExecutionMemory(memory, {
      decisionLimit: 10,
      completedTaskSummaryLimit: 5,
      resolvedIssueLimit: 3,
      answeredQuestionLimit: 3,
      now: 100,
    });
    expect(result.compacted).toBe(true);
    expect(result.memory.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'locked-boundary', status: 'LOCKED' }),
      ]),
    );
    expect(result.memory.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'issue:open', status: 'OPEN' })]),
    );
    expect(result.memory.questions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'question:open', status: 'OPEN' })]),
    );
    expect(result.memory.completedTaskSummaries).toHaveLength(5);
    expect(result.memory.sourceRefs).toEqual(
      expect.arrayContaining([{ kind: 'task', id: 'task:0' }]),
    );
    expect(result.memory.notes.at(-1)).toContain('Compacted');
  });
});
