import { describe, expect, it } from 'vitest';

import type {
  StoredAttempt,
  StoredGoal,
  StoredOrchestratorEvent,
  StoredTask,
} from '@agentscope/storage';

import { computeReliabilityMetrics } from './reliability.js';

function goal(id: string, status: StoredGoal['status'], archivedAt?: number): StoredGoal {
  return {
    id,
    workspace: 'D:/workspace',
    prompt: id,
    provider: 'claude',
    status,
    constraints: {},
    roadmap: [],
    projectState: {},
    executionMemory: {},
    workingSet: {},
    activeRevision: 0,
    createdAt: 0,
    updatedAt: status === 'COMPLETED' ? 100_000 : 40_000,
    ...(archivedAt === undefined ? {} : { archivedAt }),
    ...(status === 'COMPLETED' ? { completedAt: 100_000 } : {}),
  };
}

function task(id: string, goalId: string, status: StoredTask['status']): StoredTask {
  return {
    id,
    goalId,
    title: id,
    objective: id,
    acceptanceCriteria: [],
    verification: {},
    constraints: {},
    maxAttempts: 3,
    status,
    sequence: 1,
    tentative: false,
    createdAt: 0,
    updatedAt: 40_000,
  };
}

function attempt(
  id: string,
  taskId: string,
  attemptNumber: number,
  usage?: NonNullable<NonNullable<StoredAttempt['workerResult']>['usage']>,
): StoredAttempt {
  return {
    id,
    taskId,
    attemptNumber,
    provider: 'claude',
    status: 'COMPLETED',
    createdAt: 0,
    updatedAt: 10_000,
    ...(usage === undefined
      ? {}
      : {
          workerResult: {
            claimedStatus: 'completed',
            summary: 'done',
            changedFiles: [],
            reportedVerification: {},
            usage,
          },
        }),
  };
}

function event(
  goalId: string,
  type: string,
  payload: Record<string, unknown>,
): StoredOrchestratorEvent {
  return {
    id: `${goalId}:${type}`,
    goalId,
    seq: 1,
    timestamp: 50_000,
    type,
    payload,
    confidence: 1,
  };
}

describe('Orchestrator reliability metrics', () => {
  it('computes success, repair, runtime, and human intervention rates with N/A denominators', () => {
    const goals = [
      goal('goal-1', 'COMPLETED'),
      goal('goal-2', 'NEEDS_HUMAN'),
      goal('goal-3', 'COMPLETED', 200_000),
    ];
    const tasks = [
      task('task-1', 'goal-1', 'COMPLETED'),
      task('task-2', 'goal-2', 'FAILED'),
      task('task-3', 'goal-3', 'SKIPPED'),
    ];
    const attempts = [
      attempt('attempt-1', 'task-1', 1),
      attempt('attempt-2', 'task-2', 1),
      attempt('attempt-3', 'task-2', 2),
    ];
    const metrics = computeReliabilityMetrics({ goals, tasks, attempts }, 123);

    expect(metrics.generatedAt).toBe(123);
    expect(metrics.taskSuccessRate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(metrics.averageRepairAttempts).toBe(1 / 2);
    expect(metrics.humanInterventionRate).toEqual({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(metrics.runtime).toMatchObject({ sampleCount: 2, averageSeconds: 100, p50Seconds: 100 });
    expect(metrics.archivedGoalCount).toBe(1);
    expect(metrics.usage.availability).toBe('unavailable');
  });

  it('reports provider usage only when it is actually present', () => {
    const goals = [goal('goal-usage', 'COMPLETED')];
    const tasks = [task('task-usage', 'goal-usage', 'COMPLETED')];
    const attempts = [
      attempt('attempt-usage-1', 'task-usage', 1, {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cost: 0.01,
      }),
      attempt('attempt-usage-2', 'task-usage', 2),
    ];
    const partial = computeReliabilityMetrics({ goals, tasks, attempts });
    expect(partial.usage).toMatchObject({
      availability: 'partial',
      reportedAttemptCount: 1,
      attemptCount: 2,
    });
    expect(partial.usage.inputTokens).toBe(10);
    expect(partial.usage.totalTokens).toBe(15);
  });

  it('uses only explicit final-gate or gap evidence for the false-completion proxy', () => {
    const goals = [goal('goal-false', 'COMPLETED'), goal('goal-clean', 'COMPLETED')];
    const tasks = [
      task('task-false', 'goal-false', 'COMPLETED'),
      task('task-clean', 'goal-clean', 'COMPLETED'),
    ];
    const events = [event('goal-false', 'goal.gap_task.created', { reason: 'gap' })];
    const metrics = computeReliabilityMetrics({ goals, tasks, attempts: [], events });

    expect(metrics.falseCompletionRateProxy).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });

  it('keeps all rates explicitly N/A when their denominators are zero', () => {
    const metrics = computeReliabilityMetrics({ goals: [], tasks: [], attempts: [] });

    expect(metrics.taskSuccessRate).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.humanInterventionRate).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.falseCompletionRateProxy).toEqual({ numerator: 0, denominator: 0 });
    expect(metrics.averageRepairAttempts).toBeUndefined();
  });
});
