import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createServer } from '../../apps/server/src/index.js';
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
import {
  openStorage,
  OrchestratorRepository,
  StorageRepository,
} from '../../packages/storage/src/index.js';

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
      reason: 'Integration workspace intentionally has no Git repository.',
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
    files: [],
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

function plannerWithFutureTask(): Planner {
  return {
    planInitial(input): InitialPlan {
      const firstTask = {
        id: `${input.goal.id}:task:1`,
        title: 'Implement the verified change',
        objective: input.goal.prompt,
        acceptanceCriteria: ['The implementation is independently verified.'],
        verification: { checks: [{ executable: 'node', args: ['-e', 'process.exit(0)'] }] },
        constraints: { singleWorker: true, noRemotePush: true },
        maxAttempts: 3,
        sequence: 1,
        tentative: false,
      } as const;
      const futureTask = {
        id: `${input.goal.id}:task:2`,
        title: 'Run follow-up verification',
        objective: 'Run the follow-up verification checks.',
        acceptanceCriteria: ['The follow-up evidence is recorded.'],
        verification: { checks: [{ executable: 'node', args: ['-e', 'process.exit(0)'] }] },
        constraints: { singleWorker: true, noRemotePush: true },
        maxAttempts: 2,
        sequence: 2,
        tentative: true,
      } as const;
      return {
        goalId: input.goal.id,
        roadmap: [
          {
            id: firstTask.id,
            title: firstTask.title,
            objective: firstTask.objective,
            status: 'LOCKED',
          },
          {
            id: futureTask.id,
            title: futureTask.title,
            objective: futureTask.objective,
            status: 'TENTATIVE',
          },
        ],
        firstTask,
        tentativeTasks: [futureTask],
        rationale: 'Integration planner keeps a future Task for revision coverage.',
      };
    },
    planRolling(input): RollingPlan {
      const pending = input.tasks
        .filter((task) => task.status === 'PENDING')
        .sort((left, right) => left.sequence - right.sequence)[0];
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
          rationale: 'The next future Task is ready after the previous boundary.',
        };
      }
      if (
        input.tasks.length > 0 &&
        input.tasks.every((task) => task.status === 'COMPLETED' || task.status === 'SKIPPED')
      ) {
        return {
          goalId: input.goal.id,
          action: 'GOAL_READY_FOR_FINAL_VERIFICATION',
          rationale: 'All integration Tasks are terminal.',
        };
      }
      return {
        goalId: input.goal.id,
        action: 'INSPECT',
        rationale: 'The integration planner waits for the active Task boundary.',
      };
    },
  };
}

async function openServer(
  repository: StorageRepository,
  orchestratorRepository: OrchestratorRepository,
) {
  return createServer({ repository, orchestratorRepository, recoverOnStart: false });
}

describe('orchestrator control-loop integration', () => {
  it('串起 instruction、roadmap revision、retry、verification 和 server snapshot', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-control-loop-'));
    const filename = path.join(workspace, 'state.db');
    const { client } = openStorage({ filename, migrate: true });
    let engine: OrchestratorEngine | undefined;
    let app: Awaited<ReturnType<typeof openServer>> | undefined;
    try {
      const repository = new OrchestratorRepository(client);
      const context = contextFor(workspace);
      let firstTaskVerificationCount = 0;
      let instructionSubmitted = false;
      let futureTaskEdited = false;
      const engineContext = {
        repository,
        planner: plannerWithFutureTask(),
        contextProvider: async () => context,
        worker: new SerialWorkerRuntime({
          launch: async (request) => {
            if (request.task.id.endsWith(':task:1') && !futureTaskEdited) {
              futureTaskEdited = true;
              const mutation = engine.editFutureTaskContract(
                'integration-control-loop',
                'integration-control-loop:task:2',
                {
                  expectedRevision: 1,
                  idempotencyKey: 'integration-task-edit-1',
                  reason: 'Clarify the follow-up evidence requirement.',
                  patch: {
                    objective: 'Run the follow-up verification checks and record evidence.',
                  },
                },
              );
              expect(mutation.revision.revision).toBe(2);
            }
            if (request.task.id.endsWith(':task:1') && !instructionSubmitted) {
              instructionSubmitted = true;
              const instruction = engine.submitInstruction(
                'integration-control-loop',
                {
                  kind: 'priority',
                  content: 'Keep the verification evidence linked to this Goal.',
                },
                { idempotencyKey: 'integration-instruction-1' },
              );
              expect(instruction.status).toBe('PENDING');
            }
            return {
              attemptId: request.attemptId,
              status: 'completed',
              exitCode: 0,
              summary: 'Integration Worker completed the bounded task.',
              changedFiles: ['src/feature.ts'],
              reportedVerification: { integration: true },
            };
          },
        }),
        verifyTask: async ({ task }) => {
          if (task.id.endsWith(':task:1') && firstTaskVerificationCount++ === 0) {
            return {
              status: 'FAIL' as const,
              criteria: [
                {
                  criterion: 'The implementation is independently verified.',
                  status: 'FAIL' as const,
                  reason: 'retry fixture',
                },
              ],
              deterministicChecks: [],
              evidence: [{ kind: 'integration', status: 'failed' }],
              reason: 'The first verification intentionally fails to exercise retry.',
            };
          }
          return {
            status: 'PASS' as const,
            criteria: [
              {
                criterion: 'The task is independently verified.',
                status: 'PASS' as const,
                reason: 'integration fixture',
              },
            ],
            deterministicChecks: [{ id: 'integration', status: 'passed' }],
            evidence: [{ kind: 'integration', status: 'passed' }],
            reason: 'The integration verification passed.',
          };
        },
        verifyGoal: async () => ({
          status: 'PASS' as const,
          criteria: [
            {
              criterion: 'The Goal is independently verified.',
              status: 'PASS' as const,
              reason: 'integration fixture',
            },
          ],
          deterministicChecks: [{ id: 'goal', status: 'passed' }],
          evidence: [{ kind: 'goal', status: 'passed' }],
          reason: 'The final integration verification passed.',
        }),
      };
      app = await openServer(new StorageRepository(client), repository);
      engine = new OrchestratorEngine(engineContext);
      const result = await engine.createGoalAndRun({
        id: 'integration-control-loop',
        workspace,
        prompt: 'Implement the integration fixture change.',
        provider: 'mock',
      });

      expect(result.status).toBe('COMPLETED');
      expect(repository.listInstructions('integration-control-loop')).toMatchObject([
        { status: 'APPLIED' },
      ]);
      expect(
        repository.listRoadmapRevisions('integration-control-loop').length,
      ).toBeGreaterThanOrEqual(2);
      expect(repository.listAttempts('integration-control-loop:task:1')).toHaveLength(2);
      expect(repository.listAttempts('integration-control-loop:task:2')).toHaveLength(1);
      expect(repository.listVerificationRuns('integration-control-loop:task:1')).toHaveLength(2);
      expect(repository.listEvents('integration-control-loop').map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'goal.instruction.received',
          'goal.instruction.applied',
          'goal.roadmap.task_contract_updated',
          'task.repair.scheduled',
          'goal.verification.completed',
        ]),
      );

      const response = await app.inject('/api/goals/integration-control-loop');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        goal: { id: 'integration-control-loop', status: 'COMPLETED' },
        tasks: [
          { id: 'integration-control-loop:task:1', status: 'COMPLETED' },
          { id: 'integration-control-loop:task:2', status: 'COMPLETED' },
        ],
        taskDetails: [
          {
            task: { id: 'integration-control-loop:task:1' },
            attempts: expect.any(Array),
            verifications: expect.any(Array),
          },
          {
            task: { id: 'integration-control-loop:task:2' },
            attempts: expect.any(Array),
            verifications: expect.any(Array),
          },
        ],
      });
    } finally {
      engine?.dispose();
      await app?.close();
      client.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reopens the database and resumes an uncertain boundary without duplicating the Attempt', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-resume-loop-'));
    const filename = path.join(workspace, 'state.db');
    let verificationCount = 0;
    let firstClient: ReturnType<typeof openStorage>['client'] | undefined;
    let secondClient: ReturnType<typeof openStorage>['client'] | undefined;
    let firstEngine: OrchestratorEngine | undefined;
    let secondEngine: OrchestratorEngine | undefined;
    let app: Awaited<ReturnType<typeof openServer>> | undefined;
    try {
      const first = openStorage({ filename, migrate: true });
      firstClient = first.client;
      const firstRepository = new OrchestratorRepository(first.client);
      firstEngine = new OrchestratorEngine({
        repository: firstRepository,
        planner: plannerWithFutureTask(),
        contextProvider: async () => contextFor(workspace),
        worker: new SerialWorkerRuntime({
          launch: async (request) => ({
            attemptId: request.attemptId,
            status: 'completed' as const,
            exitCode: 0,
            summary: 'The first process completed the Worker boundary.',
            changedFiles: [],
            reportedVerification: {},
          }),
        }),
        verifyTask: async () => {
          verificationCount += 1;
          return {
            status: verificationCount === 1 ? ('UNCERTAIN' as const) : ('PASS' as const),
            criteria: [],
            deterministicChecks: [],
            evidence: [{ kind: 'resume', verificationCount }],
            reason:
              verificationCount === 1
                ? 'The first process has incomplete evidence.'
                : 'The resumed evidence passed.',
          };
        },
        verifyGoal: async () => ({
          status: 'PASS' as const,
          criteria: [],
          deterministicChecks: [],
          evidence: [{ kind: 'resume-goal' }],
          reason: 'The resumed Goal passed final verification.',
        }),
      });
      const initial = await firstEngine.createGoalAndRun({
        id: 'integration-resume-loop',
        workspace,
        prompt: 'Resume this uncertain integration boundary.',
        provider: 'mock',
      });
      expect(initial.status).toBe('NEEDS_HUMAN');
      firstEngine.dispose();
      firstEngine = undefined;
      first.client.close();
      firstClient = undefined;

      const second = openStorage({ filename, migrate: true });
      secondClient = second.client;
      const secondRepository = new OrchestratorRepository(second.client);
      secondEngine = new OrchestratorEngine({
        repository: secondRepository,
        planner: plannerWithFutureTask(),
        contextProvider: async () => contextFor(workspace),
        worker: new SerialWorkerRuntime({
          launch: async (request) => ({
            attemptId: request.attemptId,
            status: 'completed' as const,
            exitCode: 0,
            summary: 'The resumed process completed the next Attempt.',
            changedFiles: [],
            reportedVerification: {},
          }),
        }),
        verifyTask: async () => {
          verificationCount += 1;
          return {
            status: 'PASS' as const,
            criteria: [],
            deterministicChecks: [],
            evidence: [{ kind: 'resume', verificationCount }],
            reason: 'The resumed evidence passed.',
          };
        },
        verifyGoal: async () => ({
          status: 'PASS' as const,
          criteria: [],
          deterministicChecks: [],
          evidence: [{ kind: 'resume-goal' }],
          reason: 'The resumed Goal passed final verification.',
        }),
      });
      const result = await secondEngine.resumeGoal('integration-resume-loop', {
        confirmExternalProcessStopped: true,
        idempotencyKey: 'integration-resume-1',
      });
      expect(result.status).toBe('COMPLETED');
      expect(secondRepository.listAttempts('integration-resume-loop:task:1')).toHaveLength(2);
      expect(
        secondRepository.listEvents('integration-resume-loop').map((event) => event.type),
      ).toContain('goal.recovery.resumed');
      app = await openServer(new StorageRepository(second.client), secondRepository);
      const response = await app.inject('/api/goals/integration-resume-loop');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ goal: { status: 'COMPLETED' } });
      secondEngine.dispose();
      secondEngine = undefined;
      second.client.close();
      secondClient = undefined;
    } finally {
      firstEngine?.dispose();
      secondEngine?.dispose();
      await app?.close();
      firstClient?.close();
      secondClient?.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
