import type {
  OrchestratorRepository,
  CreateGoalInput,
  JsonObject,
  StoredGoal,
  StoredTask,
} from '@agentscope/storage';

import {
  bootstrapProjectContext,
  type BootstrapContext,
  type ProjectState,
  type WorkingSet,
} from './index.js';
import { ConservativePlanner, type Planner } from './planner.js';
import { decideRepair } from './repair.js';
import { verifyTask, type VerificationResult, type VerifyTaskOptions } from './verification.js';
import type { SerialWorkerRuntime, WorkerExecutionResult } from './worker.js';

export type GoalVerification = (input: {
  readonly goal: StoredGoal;
  readonly tasks: readonly StoredTask[];
  readonly projectState: ProjectState;
  readonly workingSet: WorkingSet;
}) => Promise<VerificationResult>;

export type TaskVerifier = (options: VerifyTaskOptions) => Promise<VerificationResult>;

export interface OrchestratorEngineOptions {
  readonly repository: OrchestratorRepository;
  readonly planner?: Planner;
  readonly worker: SerialWorkerRuntime;
  readonly contextProvider?: (input: {
    readonly workspace: string;
    readonly goalPrompt: string;
  }) => Promise<BootstrapContext>;
  readonly verifyTask?: TaskVerifier;
  readonly verifyGoal?: GoalVerification;
  readonly maxSteps?: number;
  readonly now?: () => number;
}

export interface GoalRunResult {
  readonly goal: StoredGoal;
  readonly tasks: readonly StoredTask[];
  readonly status: StoredGoal['status'];
  readonly lastVerification?: VerificationResult;
}

export class OrchestratorBusyError extends Error {
  constructor(readonly activeGoalId: string) {
    super(`An Orchestrator Goal is already running: ${activeGoalId}.`);
    this.name = 'OrchestratorBusyError';
  }
}

/**
 * Serial autonomous loop. It owns orchestration decisions but delegates provider execution,
 * deterministic verification, and persistence to explicit collaborators.
 */
export class OrchestratorEngine {
  private readonly planner: Planner;
  private readonly contextProvider: NonNullable<OrchestratorEngineOptions['contextProvider']>;
  private readonly verifyTask: TaskVerifier;
  private readonly verifyGoal: GoalVerification;
  private readonly maxSteps: number;
  private readonly now: () => number;
  private activeGoalId: string | undefined;

  constructor(private readonly options: OrchestratorEngineOptions) {
    this.planner = options.planner ?? new ConservativePlanner();
    this.contextProvider = options.contextProvider ?? ((input) => bootstrapProjectContext(input));
    this.verifyTask = options.verifyTask ?? verifyTask;
    this.verifyGoal = options.verifyGoal ?? defaultGoalVerifier;
    this.maxSteps = validateMaxSteps(options.maxSteps ?? 100);
    this.now = options.now ?? Date.now;
  }

  get active(): boolean {
    return this.activeGoalId !== undefined;
  }

  async createGoalAndRun(input: CreateGoalInput): Promise<GoalRunResult> {
    const goal = this.options.repository.createGoal(input);
    return this.runGoal(goal.id);
  }

  async runGoal(goalId: string): Promise<GoalRunResult> {
    if (this.activeGoalId !== undefined) throw new OrchestratorBusyError(this.activeGoalId);
    this.activeGoalId = goalId;
    try {
      return await this.runGoalInternal(goalId);
    } finally {
      this.activeGoalId = undefined;
    }
  }

  private async runGoalInternal(goalId: string): Promise<GoalRunResult> {
    const repository = this.options.repository;
    let goal = repository.getGoal(goalId);
    if (goal.status === 'COMPLETED' || goal.status === 'FAILED' || goal.status === 'ABORTED') {
      return { goal, tasks: repository.listTasks(goal.id), status: goal.status };
    }
    if (goal.status === 'CREATED' || goal.status === 'PAUSED' || goal.status === 'NEEDS_HUMAN') {
      goal = repository.transitionGoal(goal.id, 'PLANNING', this.now());
    }
    const context = await this.contextProvider({
      workspace: goal.workspace,
      goalPrompt: goal.prompt,
    });
    const projectState = context.projectState;
    const executionMemory = context.executionMemory;
    const workingSet = context.workingSet;
    let tasks = repository.listTasks(goal.id);
    if (tasks.length === 0) {
      const plan = this.planner.planInitial({ goal, projectState, executionMemory, workingSet });
      repository.updateGoalDocuments(
        goal.id,
        {
          roadmap: plan.roadmap,
          projectState: asJsonObject(projectState),
          executionMemory: asJsonObject(executionMemory),
          workingSet: asJsonObject(workingSet),
          currentTaskId: plan.firstTask.id,
        },
        this.now(),
      );
      repository.createTask({ ...plan.firstTask, goalId: goal.id, now: this.now() });
      for (const draft of plan.tentativeTasks) {
        repository.createTask({ ...draft, goalId: goal.id, now: this.now() });
      }
      repository.appendEvent({
        id: `${goal.id}:planning:initial`,
        goalId: goal.id,
        type: 'goal.planned',
        payload: { taskCount: plan.tentativeTasks.length + 1, rationale: plan.rationale },
        confidence: 1,
        timestamp: this.now(),
      });
      tasks = repository.listTasks(goal.id);
    }
    if (goal.status === 'PLANNING')
      goal = repository.transitionGoal(goal.id, 'RUNNING', this.now());
    let lastVerification: VerificationResult | undefined;
    for (let step = 0; step < this.maxSteps; step += 1) {
      goal = repository.getGoal(goal.id);
      tasks = repository.listTasks(goal.id);
      const activeTask = tasks.find(
        (task) =>
          task.status === 'RUNNING' || task.status === 'REPAIRING' || task.status === 'VERIFYING',
      );
      if (activeTask?.status === 'VERIFYING') {
        return this.pauseForHuman(goal, tasks, 'A Task was left in VERIFYING during recovery.');
      }
      if (activeTask !== undefined) {
        const activeAttempt = repository
          .listAttempts(activeTask.id)
          .find((attempt) => attempt.status === 'RUNNING');
        if (activeAttempt !== undefined) {
          return this.pauseForHuman(
            goal,
            tasks,
            'An active Attempt already exists; refusing to duplicate it.',
          );
        }
        if (activeTask.status === 'REPAIRING') {
          repository.transitionTask(activeTask.id, 'RUNNING', this.now());
        }
        const result = await this.executeTask(goal, activeTask, projectState, workingSet);
        lastVerification = result.verification;
        if (result.next === 'HUMAN') {
          return this.pauseForHuman(
            repository.getGoal(goal.id),
            repository.listTasks(goal.id),
            result.reason,
          );
        }
        continue;
      }
      const pending = tasks
        .filter((task) => task.status === 'PENDING')
        .sort((left, right) => left.sequence - right.sequence)[0];
      if (pending !== undefined) {
        repository.updateGoalDocuments(goal.id, { currentTaskId: pending.id }, this.now());
        repository.transitionTask(pending.id, 'RUNNING', this.now());
        continue;
      }
      if (
        tasks.length === 0 ||
        tasks.some((task) => task.status !== 'COMPLETED' && task.status !== 'SKIPPED')
      ) {
        return this.pauseForHuman(goal, tasks, 'No safe next Task is available.');
      }
      goal = repository.transitionGoal(goal.id, 'VERIFYING', this.now());
      const final = await this.verifyGoal({ goal, tasks, projectState, workingSet });
      lastVerification = final;
      const finalTask = tasks.at(-1);
      if (finalTask !== undefined) {
        repository.createVerificationRun({
          id: `${goal.id}:final-verification:${step}`,
          taskId: finalTask.id,
          status: final.status,
          criteria: final.criteria.map((criterion) => criterion.criterion),
          deterministicChecks: final.deterministicChecks.map((check) => asJsonObject(check)),
          evidence: final.evidence.map((evidence) => asJsonObject(evidence)),
          reason: final.reason,
          now: this.now(),
        });
      }
      repository.appendEvent({
        id: `${goal.id}:goal-verification:${step}`,
        goalId: goal.id,
        type: 'goal.verification.completed',
        payload: { status: final.status, reason: final.reason },
        confidence: final.status === 'PASS' ? 1 : 0.5,
        timestamp: this.now(),
      });
      if (final.status === 'PASS') {
        goal = repository.transitionGoal(goal.id, 'COMPLETED', this.now());
      } else {
        goal = repository.transitionGoal(goal.id, 'NEEDS_HUMAN', this.now());
      }
      return { goal, tasks: repository.listTasks(goal.id), status: goal.status, lastVerification };
    }
    return this.pauseForHuman(
      repository.getGoal(goal.id),
      repository.listTasks(goal.id),
      `The Orchestrator reached its ${this.maxSteps}-step safety bound.`,
    );
  }

  private async executeTask(
    goal: StoredGoal,
    task: StoredTask,
    projectState: ProjectState,
    workingSet: WorkingSet,
  ): Promise<{
    readonly next: 'CONTINUE' | 'HUMAN';
    readonly verification: VerificationResult;
    readonly reason: string;
  }> {
    const repository = this.options.repository;
    const attempts = repository.listAttempts(task.id);
    const attemptNumber = attempts.length + 1;
    const attempt = repository.createAttempt({
      id: `${task.id}:attempt:${attemptNumber}`,
      taskId: task.id,
      attemptNumber,
      provider: goal.provider,
      now: this.now(),
    });
    repository.updateAttempt(attempt.id, { status: 'RUNNING' }, this.now());
    repository.appendEvent({
      id: `${attempt.id}:started`,
      goalId: goal.id,
      taskId: task.id,
      attemptId: attempt.id,
      type: 'attempt.started',
      payload: { attemptNumber },
      confidence: 1,
      timestamp: this.now(),
    });
    let workerResult: WorkerExecutionResult;
    try {
      workerResult = await this.options.worker.execute({
        attemptId: attempt.id,
        provider: goal.provider,
        workspace: goal.workspace,
        task,
        projectState,
        workingSet,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      repository.updateAttempt(
        attempt.id,
        {
          status: 'FAILED',
          workerResult: {
            claimedStatus: 'failed',
            summary: reason,
            changedFiles: [],
            reportedVerification: {},
          },
        },
        this.now(),
      );
      return this.handleVerification(
        goal,
        task,
        attempt.id,
        attemptNumber,
        failedWorkerVerification(reason),
      );
    }
    const attemptStatus =
      workerResult.status === 'completed'
        ? 'COMPLETED'
        : workerResult.status === 'interrupted'
          ? 'INTERRUPTED'
          : 'FAILED';
    repository.updateAttempt(
      attempt.id,
      {
        status: attemptStatus,
        ...(workerResult.sessionId === undefined ? {} : { sessionId: workerResult.sessionId }),
        workerResult: toWorkerClaim(workerResult),
      },
      this.now(),
    );
    if (workerResult.status === 'interrupted') {
      return {
        next: 'HUMAN',
        verification: failedWorkerVerification('Worker was interrupted.'),
        reason: 'Worker was interrupted; human review is required before continuing.',
      };
    }
    repository.transitionTask(task.id, 'VERIFYING', this.now());
    const verification = await this.verifyTask({
      workspace: goal.workspace,
      task: repository.getTask(task.id),
      projectState,
      workerResult,
    });
    return this.handleVerification(goal, task, attempt.id, attemptNumber, verification);
  }

  private handleVerification(
    goal: StoredGoal,
    task: StoredTask,
    attemptId: string,
    attemptNumber: number,
    verification: VerificationResult,
  ): {
    readonly next: 'CONTINUE' | 'HUMAN';
    readonly verification: VerificationResult;
    readonly reason: string;
  } {
    const repository = this.options.repository;
    repository.createVerificationRun({
      id: `${task.id}:verification:${attemptNumber}`,
      taskId: task.id,
      attemptId,
      status: verification.status,
      criteria: verification.criteria.map((criterion) => criterion.criterion),
      deterministicChecks: verification.deterministicChecks.map((check) => asJsonObject(check)),
      evidence: verification.evidence.map((evidence) => asJsonObject(evidence)),
      reason: verification.reason,
      now: this.now(),
    });
    repository.appendEvent({
      id: `${task.id}:verification:${attemptNumber}:event`,
      goalId: goal.id,
      taskId: task.id,
      attemptId,
      type: 'task.verification.completed',
      payload: { status: verification.status, reason: verification.reason },
      confidence: verification.status === 'PASS' ? 1 : 0.5,
      timestamp: this.now(),
    });
    const decision = decideRepair(task, attemptNumber, {
      status: verification.status,
      reason: verification.reason,
    });
    if (decision.action === 'COMPLETE') {
      repository.transitionTask(task.id, 'COMPLETED', this.now());
      return { next: 'CONTINUE', verification, reason: decision.reason };
    }
    if (decision.action === 'RETRY') {
      repository.transitionTask(task.id, 'REPAIRING', this.now());
      repository.appendEvent({
        id: `${task.id}:repair:${decision.attemptNumber}`,
        goalId: goal.id,
        taskId: task.id,
        type: 'task.repair.scheduled',
        payload: { attemptNumber: decision.attemptNumber, reason: decision.reason },
        confidence: 1,
        timestamp: this.now(),
      });
      return { next: 'CONTINUE', verification, reason: decision.reason };
    }
    repository.transitionTask(task.id, 'NEEDS_HUMAN', this.now());
    return { next: 'HUMAN', verification, reason: decision.reason };
  }

  private pauseForHuman(
    goal: StoredGoal,
    tasks: readonly StoredTask[],
    reason: string,
  ): GoalRunResult {
    const repository = this.options.repository;
    if (goal.status !== 'NEEDS_HUMAN') {
      if (goal.status === 'PLANNING' || goal.status === 'RUNNING' || goal.status === 'VERIFYING') {
        goal = repository.transitionGoal(goal.id, 'NEEDS_HUMAN', this.now());
      }
    }
    repository.appendEvent({
      id: `${goal.id}:needs-human:${this.now()}`,
      goalId: goal.id,
      type: 'goal.needs_human',
      payload: { reason },
      confidence: 1,
      timestamp: this.now(),
    });
    return { goal, tasks, status: goal.status };
  }
}

function toWorkerClaim(result: WorkerExecutionResult): {
  claimedStatus: 'completed' | 'blocked' | 'failed';
  summary: string;
  changedFiles: readonly string[];
  reportedVerification: JsonObject;
} {
  return {
    claimedStatus:
      result.status === 'completed'
        ? 'completed'
        : result.status === 'interrupted'
          ? 'blocked'
          : 'failed',
    summary: result.summary,
    changedFiles: result.changedFiles,
    reportedVerification: result.reportedVerification,
  };
}

function failedWorkerVerification(reason: string): VerificationResult {
  return {
    status: 'FAIL',
    criteria: [],
    deterministicChecks: [],
    evidence: [{ kind: 'worker', status: 'failed', reason }],
    reason,
  };
}

async function defaultGoalVerifier(input: {
  readonly goal: StoredGoal;
  readonly tasks: readonly StoredTask[];
  readonly projectState: ProjectState;
  readonly workingSet: WorkingSet;
}): Promise<VerificationResult> {
  const task = input.tasks.at(-1);
  if (task === undefined) {
    return {
      status: 'UNCERTAIN',
      criteria: [],
      deterministicChecks: [],
      evidence: [],
      reason: 'No completed Task is available for final verification.',
    };
  }
  return verifyTask({
    workspace: input.goal.workspace,
    task,
    projectState: input.projectState,
  });
}

function asJsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}

function validateMaxSteps(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError('maxSteps must be an integer between 1 and 1000.');
  }
  return value;
}
