import { describe, expect, it } from 'vitest';

import type { PlannerTaskDraft } from './planner.js';
import type { StoredGoal, StoredTask } from '@agentscope/storage';
import { evaluatePlannerTaskMerge } from './roadmap.js';

const goal = {
  id: 'merge-goal',
  workspace: 'D:/workspace/merge',
  prompt: 'Preserve roadmap edits.',
  provider: 'mock',
  status: 'RUNNING',
  constraints: {},
  roadmap: [
    { id: 'locked-task', title: 'Locked', objective: 'Keep locked.', status: 'LOCKED' },
    { id: 'tentative-task', title: 'Tentative', objective: 'Keep tentative.', status: 'TENTATIVE' },
  ],
  projectState: {},
  executionMemory: {},
  workingSet: {},
  activeRevision: 2,
  createdAt: 1,
  updatedAt: 2,
} as StoredGoal;

const task = (patch: Partial<StoredTask>): StoredTask =>
  ({
    id: 'tentative-task',
    goalId: goal.id,
    title: 'User-edited title',
    objective: 'User-edited objective',
    acceptanceCriteria: ['The user contract remains authoritative.'],
    verification: {},
    constraints: {},
    maxAttempts: 2,
    status: 'PENDING',
    sequence: 2,
    tentative: true,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  }) as StoredTask;

const draft = (patch: Partial<PlannerTaskDraft>): PlannerTaskDraft =>
  ({
    id: 'tentative-task',
    title: 'Planner title',
    objective: 'Planner objective',
    acceptanceCriteria: ['Planner criterion.'],
    verification: {},
    constraints: {},
    maxAttempts: 2,
    sequence: 2,
    tentative: true,
    ...patch,
  }) as PlannerTaskDraft;

describe('evaluatePlannerTaskMerge', () => {
  it('preserves an existing user-edited tentative contract', () => {
    expect(evaluatePlannerTaskMerge({ goal, tasks: [task({})], draft: draft({}) })).toMatchObject({
      decision: 'PRESERVE_USER',
    });
  });

  it('routes planner changes to a locked or historical Task to human review', () => {
    expect(
      evaluatePlannerTaskMerge({
        goal,
        tasks: [task({ id: 'locked-task', tentative: false, sequence: 1, status: 'PENDING' })],
        draft: draft({ id: 'locked-task', sequence: 1, tentative: false }),
      }),
    ).toMatchObject({ decision: 'NEEDS_HUMAN' });
    expect(
      evaluatePlannerTaskMerge({
        goal,
        tasks: [task({ status: 'COMPLETED', endedAt: 3 })],
        draft: draft({}),
      }),
    ).toMatchObject({ decision: 'NEEDS_HUMAN' });
  });

  it('accepts a new planner Task only outside the immutable boundary', () => {
    expect(
      evaluatePlannerTaskMerge({
        goal,
        tasks: [task({ id: 'locked-task', tentative: false, sequence: 1 })],
        draft: draft({ id: 'new-task', sequence: 2 }),
      }),
    ).toMatchObject({ decision: 'ACCEPT' });
    expect(
      evaluatePlannerTaskMerge({
        goal,
        tasks: [task({ id: 'locked-task', tentative: false, sequence: 1 })],
        draft: draft({ id: 'unsafe-task', sequence: 1 }),
      }),
    ).toMatchObject({ decision: 'NEEDS_HUMAN' });
  });
});
