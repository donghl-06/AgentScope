import { describe, expect, it } from 'vitest';

import type { StoredTask } from '@agentscope/storage';

import { decideRepair } from './repair.js';

const task: StoredTask = {
  id: 'task-repair',
  goalId: 'goal-repair',
  title: 'Repairable task',
  objective: 'Make the checks pass.',
  acceptanceCriteria: ['Checks pass.'],
  verification: {},
  constraints: {},
  maxAttempts: 3,
  status: 'VERIFYING',
  sequence: 1,
  tentative: false,
  createdAt: 1,
  updatedAt: 1,
};

describe('decideRepair', () => {
  it('allows bounded retries and then escalates', () => {
    expect(decideRepair(task, 1, { status: 'FAIL', reason: 'test failed' })).toMatchObject({
      action: 'RETRY',
      attemptNumber: 2,
    });
    expect(decideRepair(task, 3, { status: 'FAIL', reason: 'test failed' }).action).toBe(
      'NEEDS_HUMAN',
    );
  });

  it('does not retry uncertain evidence and accepts only PASS', () => {
    expect(decideRepair(task, 1, { status: 'UNCERTAIN', reason: 'no evidence' }).action).toBe(
      'NEEDS_HUMAN',
    );
    expect(decideRepair(task, 1, { status: 'PASS', reason: 'all good' })).toMatchObject({
      action: 'COMPLETE',
      attemptNumber: 1,
    });
  });
});
