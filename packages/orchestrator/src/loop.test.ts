import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openStorage } from '@agentscope/storage';
import { OrchestratorRepository } from '@agentscope/storage';

import {
  OrchestratorEngine,
  SerialWorkerRuntime,
  type BootstrapContext,
  type Planner,
  type ProjectState,
  type InitialPlan,
  type RollingPlan,
  type WorkingSet,
} from './index.js';

const projectState = {
  workspace: 'D:/workspace/engine',
  capturedAt: 1,
  git: {
    rootPath: 'D:/workspace/engine',
    isRepository: true,
    files: [],
    trackedFiles: [],
    diffStat: [],
    capturedAt: 1,
  },
  packageManager: 'unknown',
  manifests: [],
  techStack: [],
  topLevelDirectories: [],
  discoverableVerification: [],
  recentCommits: [],
  relevantFiles: [],
} as ProjectState;
const workingSet: WorkingSet = {
  files: [],
  directories: [],
  rationale: 'test',
  updatedAt: 1,
};
const context: BootstrapContext = {
  projectState,
  workingSet,
  executionMemory: {
    decisions: [],
    completedTaskIds: [],
    failedApproaches: [],
    notes: [],
  },
};

class SingleTaskPlanner implements Planner {
  planInitial(input: Parameters<Planner['planInitial']>[0]): InitialPlan {
    const task = {
      id: `${input.goal.id}:task:1`,
      title: 'Implement one task',
      objective: input.goal.prompt,
      acceptanceCriteria: ['The task is independently verified.'],
      verification: { checks: [{ id: 'test', executable: 'pnpm', args: ['run', 'test'] }] },
      constraints: { singleWorker: true },
      maxAttempts: 3,
      sequence: 1,
      tentative: false,
    } as const;
    return {
      goalId: input.goal.id,
      roadmap: [{ id: task.id, title: task.title, objective: task.objective, status: 'LOCKED' }],
      firstTask: task,
      tentativeTasks: [],
      rationale: 'test planner',
    };
  }

  planRolling(input: Parameters<Planner['planRolling']>[0]): RollingPlan {
    const pending = input.tasks.find((task) => task.status === 'PENDING');
    if (pending !== undefined) {
      return {
        goalId: input.goal.id,
        action: 'NEXT_TASK',
        nextTask: {
          id: pending.id,
          title: pending.title,
          objective: pending.objective,
          acceptanceCriteria: pending.acceptanceCriteria,
          verification: pending.verification,
          constraints: pending.constraints,
          maxAttempts: pending.maxAttempts,
          sequence: pending.sequence,
          tentative: pending.tentative,
          ...(pending.parentTaskId === undefined ? {} : { parentTaskId: pending.parentTaskId }),
        },
        rationale: 'test next task',
      };
    }
    return {
      goalId: input.goal.id,
      action: 'GOAL_READY_FOR_FINAL_VERIFICATION',
      rationale: 'test final',
    };
  }
}

async function withEngine(
  verify: ((attempt: number) => 'PASS' | 'FAIL' | 'UNCERTAIN') | 'PASS' | 'FAIL' | 'UNCERTAIN',
  test: (engine: OrchestratorEngine, repository: OrchestratorRepository) => Promise<void>,
  finalStatus: 'PASS' | 'FAIL' = 'PASS',
  contextProvider: () => Promise<BootstrapContext> = async () => context,
): Promise<void> {
  const filename = path.join(os.tmpdir(), `agentscope-engine-${Date.now()}-${Math.random()}.db`);
  const { client } = openStorage({ filename, migrate: true });
  try {
    const repository = new OrchestratorRepository(client);
    let attemptCount = 0;
    const worker = new SerialWorkerRuntime({
      launch: async (request) => ({
        attemptId: request.attemptId,
        status: 'completed' as const,
        exitCode: 0,
        summary: 'worker completed',
        changedFiles: ['src/feature.ts'],
        reportedVerification: {},
      }),
    });
    const engine = new OrchestratorEngine({
      repository,
      planner: new SingleTaskPlanner(),
      worker,
      contextProvider,
      verifyTask: async () => {
        attemptCount += 1;
        const status = typeof verify === 'function' ? verify(attemptCount) : verify;
        return {
          status,
          criteria: [{ criterion: 'The task is independently verified.', status, reason: 'test' }],
          deterministicChecks: [],
          evidence: [{ kind: 'test', attempt: attemptCount }],
          reason: status === 'PASS' ? 'passed' : status === 'FAIL' ? 'failed' : 'uncertain',
        };
      },
      verifyGoal: async () => ({
        status: finalStatus,
        criteria: [{ criterion: 'Goal verified.', status: finalStatus, reason: 'test' }],
        deterministicChecks: [],
        evidence: [{ kind: 'final' }],
        reason: finalStatus === 'PASS' ? 'final pass' : 'final gap',
      }),
      now: (() => {
        let value = 100;
        return () => (value += 1);
      })(),
    });
    await test(engine, repository);
  } finally {
    client.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(filename + suffix);
      } catch {
        // Best-effort cleanup for SQLite sidecar files.
      }
    }
  }
}

describe('OrchestratorEngine', () => {
  it('runs one serial Task and completes only after final verification', async () => {
    await withEngine('PASS', async (engine, repository) => {
      const result = await engine.createGoalAndRun({
        id: 'goal-pass',
        workspace: projectState.workspace,
        prompt: 'Implement the feature.',
        provider: 'claude',
      });
      expect(result.status).toBe('COMPLETED');
      expect(result.tasks).toMatchObject([{ status: 'COMPLETED' }]);
      expect(repository.listAttempts('goal-pass:task:1')).toHaveLength(1);
      expect(repository.listEvents('goal-pass')).not.toHaveLength(0);
    });
  });

  it('retries a failed verification within the task budget', async () => {
    await withEngine(
      (attempt) => (attempt === 1 ? 'FAIL' : 'PASS'),
      async (engine, repository) => {
        const result = await engine.createGoalAndRun({
          id: 'goal-retry',
          workspace: projectState.workspace,
          prompt: 'Repair the feature.',
          provider: 'claude',
        });
        expect(result.status).toBe('COMPLETED');
        expect(repository.listAttempts('goal-retry:task:1')).toHaveLength(2);
      },
    );
  });

  it('pauses at NEEDS_HUMAN when verification is uncertain', async () => {
    await withEngine('UNCERTAIN', async (engine, repository) => {
      const result = await engine.createGoalAndRun({
        id: 'goal-uncertain',
        workspace: projectState.workspace,
        prompt: 'Need human review.',
        provider: 'claude',
      });
      expect(result.status).toBe('NEEDS_HUMAN');
      expect(repository.listTasks('goal-uncertain')).toMatchObject([{ status: 'NEEDS_HUMAN' }]);
    });
  });

  it('supports a persisted pause and explicit resume at a safe boundary', async () => {
    await withEngine('PASS', async (engine, repository) => {
      repository.createGoal({
        id: 'goal-pause',
        workspace: projectState.workspace,
        prompt: 'Pause before running.',
        provider: 'claude',
      });
      expect(engine.requestPause('goal-pause').status).toBe('PAUSED');
      const result = await engine.resumeGoal('goal-pause');
      expect(result.status).toBe('COMPLETED');
      expect(repository.getGoal('goal-pause').status).toBe('COMPLETED');
    });
  });

  it('does not resume an explicitly aborted Goal', async () => {
    await withEngine('PASS', async (engine, repository) => {
      repository.createGoal({
        id: 'goal-abort',
        workspace: projectState.workspace,
        prompt: 'Abort before running.',
        provider: 'claude',
      });
      expect(engine.requestAbort('goal-abort').status).toBe('ABORTED');
      await expect(engine.resumeGoal('goal-abort')).rejects.toThrow('Only a PAUSED Goal');
      expect(repository.getGoal('goal-abort').status).toBe('ABORTED');
    });
  });

  it('persists a Gap Task when final verification fails', async () => {
    await withEngine(
      'PASS',
      async (engine, repository) => {
        const result = await engine.createGoalAndRun({
          id: 'goal-final-gap',
          workspace: projectState.workspace,
          prompt: 'Detect a final verification gap.',
          provider: 'claude',
        });
        expect(result.status).toBe('NEEDS_HUMAN');
        expect(repository.listTasks('goal-final-gap')).toMatchObject([
          { id: 'goal-final-gap:task:1', status: 'COMPLETED' },
          { id: 'goal-final-gap:gap:2', status: 'PENDING' },
        ]);
        expect(repository.listEvents('goal-final-gap').map((event) => event.type)).toContain(
          'goal.gap_task.created',
        );
      },
      'FAIL',
    );
  });

  it('persists an intervention state when runtime setup fails', async () => {
    await withEngine(
      'PASS',
      async (engine, repository) => {
        await expect(
          engine.createGoalAndRun({
            id: 'goal-runtime-failure',
            workspace: projectState.workspace,
            prompt: 'The context provider will fail.',
            provider: 'claude',
          }),
        ).rejects.toThrow('context unavailable');
        expect(repository.getGoal('goal-runtime-failure').status).toBe('NEEDS_HUMAN');
        expect(repository.listEvents('goal-runtime-failure').map((event) => event.type)).toContain(
          'goal.run_failed',
        );
      },
      'PASS',
      async () => {
        throw new Error('context unavailable');
      },
    );
  });
});
