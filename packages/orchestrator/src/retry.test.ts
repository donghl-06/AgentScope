import { describe, expect, it } from 'vitest';

import type {
  StoredAttempt,
  StoredGoal,
  StoredTask,
  StoredVerificationRun,
} from '@agentscope/storage';
import { openStorage, OrchestratorRepository } from '@agentscope/storage';

import { beginTaskRetry, planTaskRetry, RetryNotAllowedError } from './retry.js';

const goal: StoredGoal = {
  id: 'retry-goal',
  workspace: 'D:/workspace',
  prompt: 'Repair the task',
  provider: 'mock',
  status: 'NEEDS_HUMAN',
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
  id: 'retry-goal:task:1',
  goalId: goal.id,
  title: 'Repair task',
  objective: 'Make the repair.',
  acceptanceCriteria: ['The repair is verified.'],
  verification: {},
  constraints: { singleWorker: true },
  maxAttempts: 3,
  status: 'NEEDS_HUMAN',
  sequence: 1,
  tentative: false,
  createdAt: 1,
  updatedAt: 1,
};

const failedAttempt: StoredAttempt = {
  id: 'retry-goal:task:1:attempt:1',
  taskId: task.id,
  attemptNumber: 1,
  provider: 'mock',
  status: 'FAILED',
  createdAt: 1,
  updatedAt: 2,
};

const failedVerification: StoredVerificationRun = {
  id: 'retry-goal:task:1:verification:1',
  taskId: task.id,
  attemptId: failedAttempt.id,
  status: 'FAIL',
  criteria: ['The repair is verified.'],
  deterministicChecks: [],
  evidence: [{ kind: 'command', status: 'failed', exitCode: 1 }],
  reason: 'The deterministic check failed.',
  createdAt: 3,
  updatedAt: 3,
};

describe('planTaskRetry', () => {
  it('creates the next bounded Attempt and carries diagnostic evidence', () => {
    const plan = planTaskRetry({
      goal,
      task,
      attempts: [failedAttempt],
      verifications: [failedVerification],
    });
    expect(plan).toMatchObject({
      goalId: goal.id,
      taskId: task.id,
      attemptNumber: 2,
      reasonCode: 'verification_failed',
      previousAttempt: failedAttempt,
      previousVerification: failedVerification,
      verificationEvidence: failedVerification.evidence,
    });
    expect(plan.repairObjective).toContain('The deterministic check failed.');
  });

  it('rejects active, terminal, and exhausted tasks', () => {
    expect(() =>
      planTaskRetry({
        goal,
        task,
        attempts: [{ ...failedAttempt, status: 'RUNNING' }],
        verifications: [],
      }),
    ).toThrow(RetryNotAllowedError);
    expect(() =>
      planTaskRetry({
        goal,
        task: { ...task, status: 'COMPLETED' },
        attempts: [failedAttempt],
        verifications: [failedVerification],
      }),
    ).toThrow('cannot be retried');
    expect(() =>
      planTaskRetry({
        goal,
        task,
        attempts: [
          failedAttempt,
          { ...failedAttempt, id: `${failedAttempt.id}:2`, attemptNumber: 2 },
          { ...failedAttempt, id: `${failedAttempt.id}:3`, attemptNumber: 3 },
        ],
        verifications: [failedVerification],
      }),
    ).toThrow('maximum of 3 Attempts');
  });
});

describe('beginTaskRetry', () => {
  it('persists the task boundary and audit event after explicit stopped confirmation', () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    try {
      const repository = new OrchestratorRepository(client);
      repository.createGoal({
        id: goal.id,
        workspace: goal.workspace,
        prompt: goal.prompt,
        provider: goal.provider,
      });
      repository.transitionGoal(goal.id, 'PLANNING', 1);
      repository.createTask({
        id: task.id,
        goalId: goal.id,
        title: task.title,
        objective: task.objective,
        acceptanceCriteria: task.acceptanceCriteria,
        verification: task.verification,
        constraints: task.constraints,
        maxAttempts: task.maxAttempts,
        sequence: task.sequence,
        tentative: task.tentative,
        now: 1,
      });
      repository.transitionTask(task.id, 'RUNNING', 2);
      repository.createAttempt({
        id: failedAttempt.id,
        taskId: task.id,
        attemptNumber: 1,
        provider: failedAttempt.provider,
        now: 3,
      });
      repository.updateAttempt(failedAttempt.id, { status: 'FAILED' }, 4);
      repository.createVerificationRun({
        id: failedVerification.id,
        taskId: task.id,
        attemptId: failedAttempt.id,
        status: failedVerification.status,
        criteria: failedVerification.criteria,
        deterministicChecks: failedVerification.deterministicChecks,
        evidence: failedVerification.evidence,
        reason: failedVerification.reason,
        now: 5,
      });
      repository.transitionTask(task.id, 'NEEDS_HUMAN', 6);
      repository.transitionGoal(goal.id, 'NEEDS_HUMAN', 7);

      expect(() =>
        beginTaskRetry(repository, { goalId: goal.id, taskId: task.id, now: 8 }),
      ).toThrow('requires confirmation');
      const plan = beginTaskRetry(repository, {
        goalId: goal.id,
        taskId: task.id,
        confirmExternalProcessStopped: true,
        now: 8,
      });
      expect(plan.attemptNumber).toBe(2);
      expect(repository.getTask(task.id).status).toBe('RUNNING');
      expect(repository.listEvents(goal.id).at(-1)).toMatchObject({
        type: 'task.retry.requested',
        taskId: task.id,
        payload: { attemptNumber: 2, reasonCode: 'verification_failed' },
      });
    } finally {
      client.close();
    }
  });
});
