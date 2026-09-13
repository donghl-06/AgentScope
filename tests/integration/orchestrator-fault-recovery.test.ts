import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  OrchestratorEngine,
  SerialWorkerRuntime,
  type GoalVerification,
  type BootstrapContext,
  type InitialPlan,
  type Planner,
  type ProjectState,
  type RetryBackoffWaiter,
  type RollingPlan,
  type TaskVerifier,
  type WorkerExecutionResult,
  type WorkerLaunchRequest,
  type WorkerLauncher,
} from '../../packages/orchestrator/src/index.js';
import {
  openStorage,
  OrchestratorRepository,
  StorageBusyError,
  type CreateOrchestratorNotificationInput,
  type CreateRoadmapRevisionInput,
} from '../../packages/storage/src/index.js';
import { recoverOrchestrator } from '../../packages/orchestrator/src/index.js';

const goalInput = (id: string, workspace: string) => ({
  id,
  workspace,
  prompt: 'Run the injected recovery fixture.',
  provider: 'mock',
});

const projectStateFor = (workspace: string): ProjectState => ({
  workspace,
  capturedAt: 1,
  git: {
    rootPath: workspace,
    isRepository: false,
    files: [],
    trackedFiles: [],
    diffStat: [],
    capturedAt: 1,
    reason: 'Fault-injection fixture has no Git repository.',
  },
  packageManager: 'unknown',
  manifests: [],
  techStack: ['Node.js'],
  topLevelDirectories: [],
  discoverableVerification: [],
  recentCommits: [],
  relevantFiles: [],
});

const contextFor = (workspace: string): BootstrapContext => ({
  projectState: projectStateFor(workspace),
  workingSet: {
    files: [],
    directories: [],
    rationale: 'Fault-injection fixture working set.',
    updatedAt: 1,
  },
  executionMemory: {
    decisions: [],
    completedTaskIds: [],
    failedApproaches: [],
    notes: [],
  },
});

class SingleTaskPlanner implements Planner {
  planInitial(input: Parameters<Planner['planInitial']>[0]): InitialPlan {
    const task = {
      id: `${input.goal.id}:task:1`,
      title: 'Run the recovery fixture',
      objective: input.goal.prompt,
      acceptanceCriteria: ['The injected boundary is recovered without duplicate work.'],
      verification: { checks: [{ executable: 'node', args: ['-e', 'process.exit(0)'] }] },
      constraints: { singleWorker: true, noRemotePush: true },
      maxAttempts: 3,
      sequence: 1,
      tentative: false,
    } as const;
    return {
      goalId: input.goal.id,
      roadmap: [{ id: task.id, title: task.title, objective: task.objective, status: 'LOCKED' }],
      firstTask: task,
      tentativeTasks: [],
      rationale: 'Fault-injection planner creates one bounded Task.',
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
        rationale: 'The persisted Task is safe to start.',
      };
    }
    return {
      goalId: input.goal.id,
      action: 'GOAL_READY_FOR_FINAL_VERIFICATION',
      rationale: 'The single Task is terminal.',
    };
  }
}

class FaultInjectingRepository extends OrchestratorRepository {
  constructor(
    client: ConstructorParameters<typeof OrchestratorRepository>[0],
    private readonly faults: { revisionWrites?: number; notifications?: boolean },
  ) {
    super(client);
  }

  override createRoadmapRevision(input: CreateRoadmapRevisionInput) {
    if ((this.faults.revisionWrites ?? 0) > 0) {
      this.faults.revisionWrites = (this.faults.revisionWrites ?? 1) - 1;
      throw new StorageBusyError('Injected database busy during roadmap revision write.');
    }
    return super.createRoadmapRevision(input);
  }

  override createOrchestratorNotification(input: CreateOrchestratorNotificationInput) {
    if (this.faults.notifications === true) {
      throw new Error('Injected notification sink failure.');
    }
    return super.createOrchestratorNotification(input);
  }
}

function passWorkerResult(request: WorkerLaunchRequest): WorkerExecutionResult {
  return {
    attemptId: request.attemptId,
    status: 'completed',
    exitCode: 0,
    summary: 'The injected Worker completed the bounded fixture.',
    changedFiles: [],
    reportedVerification: {},
  };
}

function passVerification(reason = 'The injected verification passed.') {
  return {
    status: 'PASS' as const,
    criteria: [
      {
        criterion: 'The injected boundary is recovered without duplicate work.',
        status: 'PASS' as const,
        reason: 'fixture',
      },
    ],
    deterministicChecks: [{ id: 'fixture', status: 'passed' }],
    evidence: [{ kind: 'fault-injection', status: 'passed' }],
    reason,
  };
}

function createHealthyEngine(
  repository: OrchestratorRepository,
  options: {
    launch?: WorkerLauncher;
    verifyTask?: TaskVerifier;
    verifyGoal?: GoalVerification;
    retryBackoffWait?: RetryBackoffWaiter;
  } = {},
): OrchestratorEngine {
  return new OrchestratorEngine({
    repository,
    planner: new SingleTaskPlanner(),
    contextProvider: async ({ workspace }) => contextFor(workspace),
    worker: new SerialWorkerRuntime({ launch: options.launch ?? passWorkerResult }),
    verifyTask: options.verifyTask ?? (async () => passVerification()),
    verifyGoal:
      options.verifyGoal ??
      (async () => passVerification('The final fixture verification passed.')),
    ...(options.retryBackoffWait === undefined
      ? {}
      : { retryBackoffWait: options.retryBackoffWait }),
  });
}

function removeDatabaseFiles(filename: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(filename + suffix);
    } catch {
      // Best-effort cleanup for SQLite sidecar files.
    }
  }
}

function closeFixture(filename: string, workspace: string, client: { close: () => void }): void {
  client.close();
  removeDatabaseFiles(filename);
  fs.rmSync(workspace, { recursive: true, force: true });
}

describe('orchestrator fault injection and recovery', () => {
  it('recovers when planning context crashes and creates no phantom Task', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-fault-planning-'));
    const filename = path.join(workspace, 'state.db');
    const first = openStorage({ filename, migrate: true });
    const firstRepository = new OrchestratorRepository(first.client);
    const firstEngine = new OrchestratorEngine({
      repository: firstRepository,
      planner: new SingleTaskPlanner(),
      contextProvider: async () => {
        throw new Error('injected planning crash');
      },
      worker: new SerialWorkerRuntime({ launch: passWorkerResult }),
      verifyTask: async () => passVerification(),
      verifyGoal: async () => passVerification(),
    });
    try {
      await expect(
        firstEngine.createGoalAndRun(goalInput('fault-planning', workspace)),
      ).rejects.toThrow('injected planning crash');
      expect(firstRepository.getGoal('fault-planning').status).toBe('NEEDS_HUMAN');
      expect(firstRepository.listTasks('fault-planning')).toHaveLength(0);
      expect(firstRepository.listEvents('fault-planning').map((event) => event.type)).toContain(
        'goal.run_failed',
      );
    } finally {
      firstEngine.dispose();
      first.client.close();
    }

    const second = openStorage({ filename, migrate: true });
    const secondRepository = new OrchestratorRepository(second.client);
    const secondEngine = createHealthyEngine(secondRepository);
    try {
      const result = await secondEngine.resumeGoal('fault-planning', {
        confirmExternalProcessStopped: true,
        idempotencyKey: 'fault-planning-resume-1',
      });
      expect(result.status).toBe('COMPLETED');
      expect(secondRepository.listTasks('fault-planning')).toHaveLength(1);
      expect(secondRepository.listAttempts('fault-planning:task:1')).toHaveLength(1);
    } finally {
      secondEngine.dispose();
      closeFixture(filename, workspace, second.client);
    }
  });

  it('classifies a Worker start crash and retries without a duplicate active Attempt', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-fault-worker-start-'));
    const filename = path.join(workspace, 'state.db');
    const storage = openStorage({ filename, migrate: true });
    const repository = new OrchestratorRepository(storage.client);
    let launchCount = 0;
    const engine = createHealthyEngine(repository, {
      launch: async (request) => {
        if (launchCount++ === 0) throw new Error('spawn_error: injected Worker start crash');
        return passWorkerResult(request);
      },
    });
    try {
      const initial = await engine.createGoalAndRun(goalInput('fault-worker-start', workspace));
      expect(initial.status).toBe('NEEDS_HUMAN');
      const result = await engine.resumeGoal('fault-worker-start', {
        confirmExternalProcessStopped: true,
        idempotencyKey: 'fault-worker-start-resume-1',
      });
      expect(result.status).toBe('COMPLETED');
      const attempts = repository.listAttempts('fault-worker-start:task:1');
      expect(attempts).toHaveLength(2);
      expect(attempts.map((attempt) => attempt.status)).toEqual(['NEEDS_HUMAN', 'COMPLETED']);
      expect(attempts[0]?.workerResult?.failure).toMatchObject({
        code: 'spawn_error',
        retryable: false,
      });
      expect(repository.listEvents('fault-worker-start').map((event) => event.type)).toContain(
        'goal.recovery.resumed',
      );
      expect(attempts.every((attempt) => !['CREATED', 'RUNNING'].includes(attempt.status))).toBe(
        true,
      );
    } finally {
      engine.dispose();
      closeFixture(filename, workspace, storage.client);
    }
  });

  it('classifies a transient Worker runtime failure and bounds its retry wait', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-fault-worker-running-'));
    const filename = path.join(workspace, 'state.db');
    const storage = openStorage({ filename, migrate: true });
    const repository = new OrchestratorRepository(storage.client);
    let launchCount = 0;
    const engine = createHealthyEngine(repository, {
      launch: async (request) => {
        if (launchCount++ === 0) {
          return {
            attemptId: request.attemptId,
            status: 'failed' as const,
            exitCode: 1,
            summary: 'The injected Worker lost its network connection.',
            changedFiles: [],
            reportedVerification: {},
            failure: {
              code: 'network' as const,
              retryable: true,
              summary: 'Worker network failure.',
              diagnosticRef: 'worker:mock:network:1',
              exitCode: 1,
            },
          };
        }
        return passWorkerResult(request);
      },
      retryBackoffWait: async () => 'elapsed',
    });
    try {
      const result = await engine.createGoalAndRun(goalInput('fault-worker-running', workspace));
      expect(result.status).toBe('COMPLETED');
      const attempts = repository.listAttempts('fault-worker-running:task:1');
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.workerResult?.failure).toMatchObject({
        code: 'network',
        retryable: true,
      });
      expect(repository.listEvents('fault-worker-running').map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'attempt.retry_backoff.started',
          'attempt.retry_backoff.completed',
        ]),
      );
      expect(attempts.every((attempt) => !['CREATED', 'RUNNING'].includes(attempt.status))).toBe(
        true,
      );
    } finally {
      engine.dispose();
      closeFixture(filename, workspace, storage.client);
    }
  });

  it('replays a crashed verification boundary after an explicit stopped-process confirmation', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-fault-verification-'));
    const filename = path.join(workspace, 'state.db');
    const first = openStorage({ filename, migrate: true });
    const firstRepository = new OrchestratorRepository(first.client);
    const firstEngine = createHealthyEngine(firstRepository, {
      verifyTask: async () => {
        throw new Error('injected verification crash');
      },
    });
    try {
      await expect(
        firstEngine.createGoalAndRun(goalInput('fault-verification', workspace)),
      ).rejects.toThrow('injected verification crash');
      expect(firstRepository.getGoal('fault-verification').status).toBe('NEEDS_HUMAN');
      expect(firstRepository.getTask('fault-verification:task:1').status).toBe('VERIFYING');
      expect(firstRepository.listAttempts('fault-verification:task:1')).toMatchObject([
        { status: 'COMPLETED' },
      ]);
      expect(firstRepository.listVerificationRuns('fault-verification:task:1')).toHaveLength(0);
    } finally {
      firstEngine.dispose();
      first.client.close();
    }

    const second = openStorage({ filename, migrate: true });
    const secondRepository = new OrchestratorRepository(second.client);
    const secondEngine = createHealthyEngine(secondRepository);
    try {
      const result = await secondEngine.resumeGoal('fault-verification', {
        confirmExternalProcessStopped: true,
        idempotencyKey: 'fault-verification-resume-1',
      });
      expect(result.status).toBe('COMPLETED');
      expect(secondRepository.listAttempts('fault-verification:task:1')).toHaveLength(2);
      expect(secondRepository.getTask('fault-verification:task:1').status).toBe('COMPLETED');
      expect(
        secondRepository.listEvents('fault-verification').map((event) => event.type),
      ).toContain('orchestrator.recovery.verification_fenced');
    } finally {
      secondEngine.dispose();
      closeFixture(filename, workspace, second.client);
    }
  });

  it('recovers a busy roadmap write without leaving a roadmap revision half-written', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-fault-revision-'));
    const filename = path.join(workspace, 'state.db');
    const first = openStorage({ filename, migrate: true });
    const firstRepository = new FaultInjectingRepository(first.client, { revisionWrites: 1 });
    const firstEngine = createHealthyEngine(firstRepository);
    try {
      await expect(
        firstEngine.createGoalAndRun(goalInput('fault-revision', workspace)),
      ).rejects.toThrow('Injected database busy during roadmap revision write');
      expect(firstRepository.getGoal('fault-revision').status).toBe('NEEDS_HUMAN');
      expect(firstRepository.listRoadmapRevisions('fault-revision')).toHaveLength(0);
      expect(firstRepository.listTasks('fault-revision')).toMatchObject([
        { id: 'fault-revision:task:1', status: 'PENDING' },
      ]);
    } finally {
      firstEngine.dispose();
      first.client.close();
    }

    const second = openStorage({ filename, migrate: true });
    const secondRepository = new OrchestratorRepository(second.client);
    const secondEngine = createHealthyEngine(secondRepository);
    try {
      const result = await secondEngine.resumeGoal('fault-revision', {
        confirmExternalProcessStopped: true,
        idempotencyKey: 'fault-revision-resume-1',
      });
      expect(result.status).toBe('COMPLETED');
      expect(secondRepository.listTasks('fault-revision')).toHaveLength(1);
      expect(secondRepository.listAttempts('fault-revision:task:1')).toHaveLength(1);
      expect(secondRepository.listRoadmapRevisions('fault-revision').length).toBeGreaterThan(0);
    } finally {
      secondEngine.dispose();
      closeFixture(filename, workspace, second.client);
    }
  });

  it('keeps a Goal complete when the notification sink crashes', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-fault-notification-'));
    const filename = path.join(workspace, 'state.db');
    const storage = openStorage({ filename, migrate: true });
    const repository = new FaultInjectingRepository(storage.client, { notifications: true });
    const engine = createHealthyEngine(repository);
    try {
      const result = await engine.createGoalAndRun(goalInput('fault-notification', workspace));
      expect(result.status).toBe('COMPLETED');
      expect(repository.listTasks('fault-notification')).toMatchObject([{ status: 'COMPLETED' }]);
      expect(repository.listEvents('fault-notification').map((event) => event.type)).toContain(
        'goal.verification.completed',
      );
      expect(repository.listOrchestratorNotifications('fault-notification')).toHaveLength(0);
      expect(repository.listEvents('fault-notification').map((event) => event.type)).not.toContain(
        'goal.run_failed',
      );
    } finally {
      engine.dispose();
      closeFixture(filename, workspace, storage.client);
    }
  });

  it('fences a disappeared process and resumes with exactly one replacement Attempt', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-fault-process-'));
    const filename = path.join(workspace, 'state.db');
    const storage = openStorage({ filename, migrate: true });
    const repository = new OrchestratorRepository(storage.client);
    const goalId = 'fault-process-disappeared';
    const taskId = `${goalId}:task:1`;
    try {
      repository.createGoal(goalInput(goalId, workspace));
      repository.transitionGoal(goalId, 'PLANNING', 2);
      repository.createTask({
        id: taskId,
        goalId,
        title: 'Run the replacement after a disappeared process',
        objective: 'Run a replacement without duplicating the disappeared process.',
        acceptanceCriteria: ['The replacement Attempt is independently verified.'],
        verification: { checks: [] },
        constraints: { singleWorker: true, noRemotePush: true },
        maxAttempts: 3,
        sequence: 1,
        tentative: false,
        now: 3,
      });
      repository.transitionTask(taskId, 'RUNNING', 4);
      repository.createAttempt({
        id: `${taskId}:attempt:1`,
        taskId,
        attemptNumber: 1,
        provider: 'mock',
        now: 5,
      });
      repository.updateAttempt(`${taskId}:attempt:1`, { status: 'RUNNING' }, 6);
      repository.transitionGoal(goalId, 'RUNNING', 7);

      expect(recoverOrchestrator(repository, 8)).toMatchObject({
        goalsInspected: 1,
        goalsPaused: 1,
        tasksPaused: 1,
        attemptsPaused: 1,
      });
      expect(repository.getGoal(goalId).status).toBe('NEEDS_HUMAN');
      expect(repository.getTask(taskId).status).toBe('NEEDS_HUMAN');
      expect(repository.getAttempt(`${taskId}:attempt:1`).status).toBe('NEEDS_HUMAN');
      expect(repository.listAttempts(taskId)).toHaveLength(1);
    } finally {
      storage.client.close();
    }

    const second = openStorage({ filename, migrate: true });
    const secondRepository = new OrchestratorRepository(second.client);
    const secondEngine = createHealthyEngine(secondRepository);
    try {
      const result = await secondEngine.resumeGoal(goalId, {
        confirmExternalProcessStopped: true,
        idempotencyKey: 'fault-process-resume-1',
      });
      expect(result.status).toBe('COMPLETED');
      const attempts = secondRepository.listAttempts(taskId);
      expect(attempts).toHaveLength(2);
      expect(attempts.map((attempt) => attempt.status)).toEqual(['NEEDS_HUMAN', 'COMPLETED']);
      expect(secondRepository.listEvents(goalId).map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'orchestrator.recovery.attempt_fenced',
          'orchestrator.recovery.task_fenced',
          'orchestrator.recovery.goal_fenced',
          'goal.recovery.resumed',
        ]),
      );
    } finally {
      secondEngine.dispose();
      closeFixture(filename, workspace, second.client);
    }
  });
});
