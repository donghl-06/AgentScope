import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openStorage, OrchestratorRepository } from '../../packages/storage/src/index.js';
import {
  OrchestratorEngine,
  SerialWorkerRuntime,
  type BootstrapContext,
  type InitialPlan,
  type Planner,
  type ProjectState,
  type RollingPlan,
  type WorkingSet,
} from '../../packages/orchestrator/src/index.js';

function oneTaskPlanner(): Planner {
  return {
    planInitial(input): InitialPlan {
      const task = {
        id: `${input.goal.id}:task:1`,
        title: 'Create the verified artifact',
        objective: input.goal.prompt,
        acceptanceCriteria: ['The artifact exists after the Worker finishes.'],
        verification: {
          checks: [
            {
              id: 'artifact-exists',
              label: 'node artifact existence check',
              executable: 'node',
              args: ['-e', "process.exit(require('fs').existsSync('artifact.txt') ? 0 : 1)"],
            },
          ],
        },
        constraints: { noRemotePush: true, singleWorker: true },
        maxAttempts: 3,
        sequence: 1,
        tentative: false,
      } as const;
      return {
        goalId: input.goal.id,
        roadmap: [{ id: task.id, title: task.title, objective: task.objective, status: 'LOCKED' }],
        firstTask: task,
        tentativeTasks: [],
        rationale: 'Integration test locks one safe file task.',
      };
    },
    planRolling(input): RollingPlan {
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
          },
          rationale: 'The integration Task is ready to run.',
        };
      }
      return {
        goalId: input.goal.id,
        action: 'GOAL_READY_FOR_FINAL_VERIFICATION',
        rationale: 'The single integration Task is complete.',
      };
    },
  };
}

function contextFor(workspace: string): BootstrapContext {
  const projectState: ProjectState = {
    workspace,
    capturedAt: 1,
    git: {
      rootPath: workspace,
      isRepository: false,
      files: [],
      trackedFiles: [],
      diffStat: [],
      capturedAt: 1,
      reason: 'Integration fixture intentionally has no Git repository.',
    },
    packageManager: 'unknown',
    manifests: [],
    techStack: ['Node.js'],
    topLevelDirectories: [],
    discoverableVerification: [],
    recentCommits: [],
    relevantFiles: [],
  };
  const workingSet: WorkingSet = {
    files: ['artifact.txt'],
    directories: [],
    rationale: 'Integration fixture working set.',
    updatedAt: 1,
  };
  return {
    projectState,
    workingSet,
    executionMemory: {
      decisions: [],
      completedTaskIds: [],
      failedApproaches: [],
      notes: [],
    },
  };
}

describe('orchestrator real-task integration', () => {
  it('executes a safe file task, verifies deterministic evidence, and persists the result', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-orchestrator-task-'));
    const filename = path.join(workspace, 'state.db');
    const { client } = openStorage({ filename, migrate: true });
    try {
      const repository = new OrchestratorRepository(client);
      const engine = new OrchestratorEngine({
        repository,
        planner: oneTaskPlanner(),
        contextProvider: async () => contextFor(workspace),
        worker: new SerialWorkerRuntime({
          launch: async (request) => {
            fs.writeFileSync(path.join(request.workspace, 'artifact.txt'), 'verified\n', 'utf8');
            return {
              attemptId: request.attemptId,
              status: 'completed',
              exitCode: 0,
              summary: 'The integration Worker created artifact.txt.',
              changedFiles: ['artifact.txt'],
              reportedVerification: { artifact: 'created' },
            };
          },
        }),
      });

      const result = await engine.createGoalAndRun({
        id: 'integration-goal',
        workspace,
        prompt: 'Create artifact.txt with a verified marker.',
        provider: 'mock',
      });

      expect(result.status).toBe('COMPLETED');
      expect(fs.readFileSync(path.join(workspace, 'artifact.txt'), 'utf8')).toBe('verified\n');
      expect(repository.listTasks('integration-goal')).toMatchObject([{ status: 'COMPLETED' }]);
      expect(repository.listAttempts('integration-goal:task:1')).toHaveLength(1);
      expect(repository.listVerificationRuns('integration-goal:task:1')).toMatchObject([
        { status: 'PASS' },
        { status: 'PASS' },
      ]);
      expect(repository.listEvents('integration-goal').map((event) => event.type)).toContain(
        'goal.rolling_plan',
      );
    } finally {
      client.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
