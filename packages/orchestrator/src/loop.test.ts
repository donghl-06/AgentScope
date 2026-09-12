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

  planRolling(): RollingPlan {
    return { goalId: 'unused', action: 'NEEDS_HUMAN', rationale: 'not used in this test' };
  }
}

async function withEngine(
  verify: ((attempt: number) => 'PASS' | 'FAIL' | 'UNCERTAIN') | 'PASS' | 'FAIL' | 'UNCERTAIN',
  test: (engine: OrchestratorEngine, repository: OrchestratorRepository) => Promise<void>,
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
      contextProvider: async () => context,
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
        status: 'PASS',
        criteria: [{ criterion: 'Goal verified.', status: 'PASS', reason: 'test' }],
        deterministicChecks: [],
        evidence: [{ kind: 'final' }],
        reason: 'final pass',
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
});
