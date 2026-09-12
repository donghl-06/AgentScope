import { describe, expect, it } from 'vitest';

import type { StoredGoal, StoredGoalInstruction, StoredTask } from '@agentscope/storage';

import { evaluateInstructionApplicability } from './instructions.js';

const goal = {
  id: 'goal-policy',
  workspace: 'D:/workspace',
  prompt: 'Keep the implementation safe.',
  provider: 'mock',
  status: 'PAUSED',
  constraints: {},
  roadmap: [
    { id: 'task-locked', title: 'Keep tests', objective: 'Preserve tests.', status: 'LOCKED' },
    { id: 'task-future', title: 'Polish docs', objective: 'Update docs.', status: 'TENTATIVE' },
  ],
  projectState: {},
  executionMemory: {},
  workingSet: {},
  activeRevision: 2,
  createdAt: 1,
  updatedAt: 2,
} as StoredGoal;

const tasks: readonly StoredTask[] = [
  {
    id: 'task-locked',
    goalId: goal.id,
    title: 'Keep tests',
    objective: 'Preserve tests.',
    acceptanceCriteria: ['Tests remain present.'],
    verification: {},
    constraints: {},
    maxAttempts: 3,
    status: 'COMPLETED',
    sequence: 1,
    tentative: false,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'task-future',
    goalId: goal.id,
    title: 'Polish docs',
    objective: 'Update docs.',
    acceptanceCriteria: ['Docs are clear.'],
    verification: {},
    constraints: {},
    maxAttempts: 3,
    status: 'PENDING',
    sequence: 2,
    tentative: true,
    createdAt: 1,
    updatedAt: 1,
  },
];

function instruction(patch: Partial<StoredGoalInstruction> = {}): StoredGoalInstruction {
  return {
    id: 'instruction-1',
    goalId: goal.id,
    kind: 'general',
    content: 'Focus on the next deterministic test.',
    source: 'user',
    status: 'PENDING',
    baseRevision: goal.activeRevision,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe('instruction applicability', () => {
  it('applies a concrete low-risk instruction', () => {
    expect(evaluateInstructionApplicability({ goal, tasks, instruction: instruction() })).toEqual({
      decision: 'APPLY',
      reasonCode: 'safe',
      reason: expect.stringContaining('compatible'),
      lockedTaskIds: ['task-locked'],
      riskSignals: [],
    });
  });

  it('rejects stale revisions before considering the content', () => {
    expect(
      evaluateInstructionApplicability({
        goal,
        tasks,
        instruction: instruction({ baseRevision: 1 }),
      }),
    ).toMatchObject({ decision: 'REJECT', reasonCode: 'revision_conflict' });
  });

  it('rejects attempts to override a LOCKED task', () => {
    expect(
      evaluateInstructionApplicability({
        goal,
        tasks,
        instruction: instruction({ content: 'Ignore and delete the locked tests.' }),
      }),
    ).toMatchObject({
      decision: 'REJECT',
      reasonCode: 'locked_constraint_conflict',
      lockedTaskIds: ['task-locked'],
    });
  });

  it('requires approval for high-risk or approval-context instructions', () => {
    expect(
      evaluateInstructionApplicability({
        goal,
        tasks,
        instruction: instruction({ content: 'Please deploy this change to production.' }),
      }),
    ).toMatchObject({ decision: 'NEEDS_APPROVAL', reasonCode: 'approval_required' });
    expect(
      evaluateInstructionApplicability({
        goal,
        tasks,
        instruction: instruction({ kind: 'approval-context', content: 'Use the approved scope.' }),
      }),
    ).toMatchObject({ decision: 'NEEDS_APPROVAL', reasonCode: 'approval_required' });
  });

  it('requests clarification for an ambiguous short instruction', () => {
    expect(
      evaluateInstructionApplicability({
        goal,
        tasks,
        instruction: instruction({ content: 'Do it.' }),
      }),
    ).toMatchObject({ decision: 'NEEDS_CLARIFICATION', reasonCode: 'clarification_required' });
  });

  it('does not treat an explicit do-not-skip guard as a locked override', () => {
    expect(
      evaluateInstructionApplicability({
        goal,
        tasks,
        instruction: instruction({ content: 'Do not skip the locked tests.' }),
      }),
    ).toMatchObject({ decision: 'APPLY', reasonCode: 'safe' });
  });
});
