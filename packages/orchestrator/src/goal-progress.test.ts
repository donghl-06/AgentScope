import { describe, expect, it } from 'vitest';

import { projectGoalProgress } from './goal-progress.js';
import type { StoredGoal, StoredTask, StoredVerificationRun } from '@agentscope/storage';

function goal(status: StoredGoal['status'] = 'RUNNING'): Pick<StoredGoal, 'id' | 'status'> {
  return { id: 'goal-progress', status };
}

function task(id: string, status: StoredTask['status'], tentative = false): StoredTask {
  return {
    id,
    goalId: 'goal-progress',
    title: id,
    objective: id,
    acceptanceCriteria: [],
    verification: {},
    constraints: {},
    maxAttempts: 3,
    status,
    sequence: Number(id.replace(/\D/gu, '')) || 1,
    tentative,
    createdAt: 1,
    updatedAt: 1,
  };
}

function verification(
  id: string,
  taskId: string,
  status: StoredVerificationRun['status'],
  createdAt = 10,
): StoredVerificationRun {
  return {
    id,
    taskId,
    attemptId: 'attempt-1',
    status,
    criteria: [],
    deterministicChecks: [],
    evidence: [],
    reason: status,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('Goal progress projection', () => {
  it('does not leave a completed small Task at the old 60% plateau', () => {
    const result = projectGoalProgress({
      goal: goal('RUNNING'),
      tasks: [task('task-1', 'COMPLETED')],
      verifications: [verification('task-1:verification:1', 'task-1', 'PASS')],
    });

    expect(result.value).toBeGreaterThan(0.8);
    expect(result.value).toBeLessThan(1);
    expect(result.reasons.map((reason) => reason.code)).toContain('final_verification_pending');
  });

  it('reaches exactly 100% only after a passing final verification', () => {
    const result = projectGoalProgress({
      goal: goal('COMPLETED'),
      tasks: [task('task-1', 'COMPLETED')],
      verifications: [
        verification('task-1:verification:1', 'task-1', 'PASS'),
        verification('goal-progress:final-verification:1', 'task-1', 'PASS', 20),
      ],
    });

    expect(result.value).toBe(1);
    expect(result.confidence).toBe(1);
    expect(result.verificationStatus).toBe('pass');
  });

  it('explains remaining, repair, skipped, and human-gated work', () => {
    const result = projectGoalProgress({
      goal: goal('NEEDS_HUMAN'),
      tasks: [
        task('task-1', 'COMPLETED'),
        task('task-2', 'REPAIRING'),
        task('task-3', 'SKIPPED', true),
        task('task-4', 'NEEDS_HUMAN', true),
        task('task-5', 'PENDING', true),
      ],
      verifications: [verification('task-1:verification:1', 'task-1', 'PASS')],
    });

    expect(result.value).toBeLessThanOrEqual(0.85);
    expect(result.remainingTaskCount).toBe(3);
    expect(result.skippedTaskCount).toBe(1);
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['tasks_remaining', 'tasks_skipped', 'active_task_repairing']),
    );
  });

  it('uses low confidence instead of inventing detail when no Tasks exist', () => {
    const result = projectGoalProgress({ goal: goal('PLANNING'), tasks: [] });

    expect(result.value).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.reasons.map((reason) => reason.code)).toContain('no_tasks');
  });

  it('keeps a failed final verification below completion and records the gap', () => {
    const result = projectGoalProgress({
      goal: goal('NEEDS_HUMAN'),
      tasks: [task('task-1', 'COMPLETED')],
      verifications: [verification('goal-progress:final-verification:2', 'task-1', 'FAIL')],
    });

    expect(result.value).toBeLessThan(1);
    expect(result.verificationStatus).toBe('fail');
    expect(result.reasons.map((reason) => reason.code)).toContain('final_verification_failed');
  });
});
