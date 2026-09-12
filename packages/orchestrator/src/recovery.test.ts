import { describe, expect, it } from 'vitest';

import { openStorage, OrchestratorRepository } from '@agentscope/storage';

import type { StoredAttempt, StoredGoal, StoredTask } from '@agentscope/storage';

import { classifyGoalRecovery, recoverOrchestrator } from './recovery.js';

const goal: StoredGoal = {
  id: 'classify-goal',
  workspace: 'D:/workspace',
  prompt: 'Continue safely',
  provider: 'mock',
  status: 'RUNNING',
  constraints: {},
  roadmap: [],
  projectState: {},
  executionMemory: {},
  workingSet: {},
  activeRevision: 0,
  createdAt: 1,
  updatedAt: 1,
};

const task: StoredTask = {
  id: 'classify-goal:task:1',
  goalId: goal.id,
  title: 'Continue task',
  objective: 'Continue safely.',
  acceptanceCriteria: [],
  verification: {},
  constraints: {},
  maxAttempts: 3,
  status: 'RUNNING',
  sequence: 1,
  tentative: false,
  createdAt: 1,
  updatedAt: 1,
};

const attempt: StoredAttempt = {
  id: 'classify-goal:task:1:attempt:1',
  taskId: task.id,
  attemptNumber: 1,
  provider: 'mock',
  status: 'RUNNING',
  createdAt: 1,
  updatedAt: 1,
};

function evidence(
  overrides: Partial<Parameters<typeof classifyGoalRecovery>[0]['evidence']> = {},
): Parameters<typeof classifyGoalRecovery>[0]['evidence'] {
  return {
    now: 100,
    providerProcess: 'unknown',
    sessionStatus: 'unknown',
    ...overrides,
  };
}

describe('recoverOrchestrator', () => {
  it('fences active goal work and does not duplicate recovery on a second pass', () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new OrchestratorRepository(client);
    repository.createGoal({
      id: 'recovery-goal',
      workspace: 'D:/workspace',
      prompt: 'Continue safely',
      provider: 'mock',
    });
    repository.transitionGoal('recovery-goal', 'PLANNING', 1);
    repository.createTask({
      id: 'recovery-goal:task:1',
      goalId: 'recovery-goal',
      title: 'Recover task',
      objective: 'Fence the interrupted work.',
      acceptanceCriteria: ['No duplicate worker is started.'],
      sequence: 1,
      now: 2,
    });
    repository.transitionTask('recovery-goal:task:1', 'RUNNING', 3);
    repository.createAttempt({
      id: 'recovery-goal:task:1:attempt:1',
      taskId: 'recovery-goal:task:1',
      attemptNumber: 1,
      provider: 'mock',
      now: 4,
    });
    repository.updateAttempt('recovery-goal:task:1:attempt:1', { status: 'RUNNING' }, 5);
    repository.transitionGoal('recovery-goal', 'RUNNING', 6);

    expect(recoverOrchestrator(repository, 100)).toEqual({
      goalsInspected: 1,
      goalsPaused: 1,
      tasksPaused: 1,
      attemptsPaused: 1,
    });
    expect(repository.getGoal('recovery-goal').status).toBe('NEEDS_HUMAN');
    expect(repository.getTask('recovery-goal:task:1').status).toBe('NEEDS_HUMAN');
    expect(repository.getAttempt('recovery-goal:task:1:attempt:1').status).toBe('NEEDS_HUMAN');
    expect(repository.listEvents('recovery-goal').map((event) => event.type)).toEqual([
      'orchestrator.recovery.attempt_fenced',
      'orchestrator.recovery.task_fenced',
      'orchestrator.recovery.goal_fenced',
    ]);

    expect(recoverOrchestrator(repository, 200)).toEqual({
      goalsInspected: 0,
      goalsPaused: 0,
      tasksPaused: 0,
      attemptsPaused: 0,
    });
    client.close();
  });
});

describe('classifyGoalRecovery', () => {
  it('returns TERMINAL for a completed goal before inspecting external state', () => {
    expect(
      classifyGoalRecovery({
        goal: { ...goal, status: 'COMPLETED' },
        tasks: [task],
        attempts: [attempt],
        evidence: evidence({ providerProcess: 'running' }),
      }),
    ).toMatchObject({ classification: 'TERMINAL', reasonCode: 'goal_terminal' });
  });

  it('returns STILL_RUNNING when a lease or provider process proves ownership is active', () => {
    expect(
      classifyGoalRecovery({
        goal,
        tasks: [task],
        attempts: [attempt],
        evidence: evidence({ lease: { ownerId: 'owner-a', expiresAt: 101 } }),
      }),
    ).toMatchObject({ classification: 'STILL_RUNNING', reasonCode: 'lease_active' });
    expect(
      classifyGoalRecovery({
        goal,
        tasks: [task],
        attempts: [attempt],
        evidence: evidence({ providerProcess: 'running' }),
      }),
    ).toMatchObject({
      classification: 'STILL_RUNNING',
      reasonCode: 'provider_running',
      taskId: task.id,
      attemptId: attempt.id,
    });
  });

  it('returns NEEDS_HUMAN when an active attempt has no stopped proof', () => {
    expect(
      classifyGoalRecovery({ goal, tasks: [task], attempts: [attempt], evidence: evidence() }),
    ).toMatchObject({ classification: 'NEEDS_HUMAN', reasonCode: 'state_unknown' });
  });

  it('returns RETRYABLE at a persisted repair boundary within the attempt budget', () => {
    expect(
      classifyGoalRecovery({
        goal,
        tasks: [{ ...task, status: 'REPAIRING' }],
        attempts: [{ ...attempt, status: 'FAILED' }],
        evidence: evidence({ providerProcess: 'stopped', sessionStatus: 'failed' }),
      }),
    ).toMatchObject({
      classification: 'RETRYABLE',
      reasonCode: 'attempt_failed_retryable',
      taskId: task.id,
      attemptId: attempt.id,
    });
  });

  it('returns SAFE_TO_RESUME when no attempt is active and the next boundary is persisted', () => {
    expect(
      classifyGoalRecovery({
        goal,
        tasks: [{ ...task, status: 'RUNNING' }],
        attempts: [],
        evidence: evidence({ providerProcess: 'stopped', sessionStatus: 'completed' }),
      }),
    ).toMatchObject({
      classification: 'SAFE_TO_RESUME',
      reasonCode: 'state_complete_boundary',
      taskId: task.id,
    });
    expect(
      classifyGoalRecovery({
        goal: { ...goal, status: 'PLANNING' },
        tasks: [],
        attempts: [],
        evidence: evidence({ providerProcess: 'stopped', sessionStatus: 'completed' }),
      }),
    ).toMatchObject({ classification: 'SAFE_TO_RESUME' });
  });
});
