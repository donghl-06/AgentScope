import { describe, expect, it } from 'vitest';

import { openStorage, OrchestratorRepository } from '@agentscope/storage';

import { recoverOrchestrator } from './recovery.js';

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
