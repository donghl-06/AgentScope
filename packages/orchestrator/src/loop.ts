import { randomUUID } from 'node:crypto';

import {
  StorageConflictError,
  StorageError,
  StorageNotFoundError,
  type OrchestratorRepository,
  type CreateGoalInput,
  type InstructionSource,
  type JsonObject,
  type RoadmapItem,
  type OrchestratorCommandReservation,
  type RoadmapRevisionItemInput,
  type RoadmapTaskMutationResult,
  type InsertRoadmapTaskInput,
  type SkipRoadmapTaskInput,
  type ReorderRoadmapTasksInput,
  type RoadmapReorderResult,
  type StoredAttempt,
  type StoredGoal,
  type StoredOrchestratorCommand,
  type StoredGoalInstruction,
  type StoredTask,
  type StoredVerificationRun,
  type TaskContractPatch,
  type UpdateFutureTaskContractInput,
} from '@agentscope/storage';
import {
  bootstrapProjectContext,
  type AppliedInstructionContext,
  type BootstrapContext,
  type ExecutionMemory,
  type ProjectState,
  type WorkingSet,
} from './index.js';
import { buildMemorySnapshot, rememberTaskOutcome } from './memory.js';
import { ConservativePlanner, type Planner } from './planner.js';
import { decideRepair } from './repair.js';
import { verifyTask, type VerificationResult, type VerifyTaskOptions } from './verification.js';
import type { SerialWorkerRuntime, WorkerExecutionResult, WorkerRetryContext } from './worker.js';
import { GoalRunLeaseManager, type GoalRunLeaseHandle } from './lease.js';
import { classifyGoalRecovery } from './recovery.js';
import { beginTaskRetry, type RetryTaskPlan } from './retry.js';
import { evaluatePlannerTaskMerge } from './roadmap.js';
import {
  evaluateInstructionApplicability,
  validateInstructionDraft,
  type InstructionApplicabilityResult,
  type InstructionDraft,
} from './instructions.js';

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
  /** Optional durable lease manager. A process-scoped manager is created by default. */
  readonly leaseManager?: GoalRunLeaseManager;
  readonly leaseOwnerId?: string;
  readonly leaseTtlMs?: number;
  readonly leaseHeartbeatMs?: number;
}

export interface ControlCommandOptions {
  readonly idempotencyKey?: string;
  readonly expectedRevision?: number;
}

export interface ResumeGoalOptions extends ControlCommandOptions {
  /** Required for NEEDS_HUMAN recovery so a stale Provider cannot be duplicated. */
  readonly confirmExternalProcessStopped?: boolean;
}

export interface EditFutureTaskOptions extends ControlCommandOptions {
  readonly patch: TaskContractPatch;
  readonly reason: string;
}

export interface InsertFutureTaskOptions extends ControlCommandOptions {
  readonly taskId?: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verification?: JsonObject;
  readonly constraints?: JsonObject;
  readonly maxAttempts?: number;
  readonly sequence?: number;
  readonly tentative?: boolean;
  readonly parentTaskId?: string;
  readonly reason: string;
}

export interface SkipFutureTaskOptions extends ControlCommandOptions {
  readonly reason: string;
}

export interface ReorderFutureTasksOptions extends ControlCommandOptions {
  readonly taskIds: readonly string[];
  readonly reason: string;
}

export interface RetryTaskOptions extends ControlCommandOptions {
  readonly reason?: string;
  readonly confirmExternalProcessStopped?: boolean;
}

export interface SubmitInstructionOptions extends ControlCommandOptions {
  readonly source?: InstructionSource;
}

export interface GoalRunResult {
  readonly goal: StoredGoal;
  readonly tasks: readonly StoredTask[];
  readonly status: StoredGoal['status'];
  readonly lastVerification?: VerificationResult;
}

type InstructionBoundary = 'before-planning' | 'before-attempt' | 'after-attempt';

interface InstructionApplicationOutcome {
  readonly goal: StoredGoal;
  readonly executionMemory: ExecutionMemory;
  readonly workingSet: WorkingSet;
  readonly blockedReason?: string;
}

export interface RetryRunResult extends GoalRunResult {
  readonly retry: RetryTaskPlan;
}

export class OrchestratorBusyError extends Error {
  constructor(
    readonly activeGoalId: string,
    message?: string,
  ) {
    super(message ?? `An Orchestrator Goal is already running: ${activeGoalId}.`);
    this.name = 'OrchestratorBusyError';
  }
}

export class OrchestratorCommandError extends StorageError {
  constructor(message: string, code = 'command_rejected') {
    super(message, code);
    this.name = 'OrchestratorCommandError';
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
  private readonly leaseManager: GoalRunLeaseManager;
  private readonly leaseHeartbeatMs: number;
  private activeGoalId: string | undefined;
  private readonly controlRequests = new Map<
    string,
    { readonly control: 'PAUSE' | 'ABORT'; readonly command: StoredOrchestratorCommand }
  >();

  constructor(private readonly options: OrchestratorEngineOptions) {
    this.planner = options.planner ?? new ConservativePlanner();
    this.contextProvider = options.contextProvider ?? ((input) => bootstrapProjectContext(input));
    this.verifyTask = options.verifyTask ?? verifyTask;
    this.verifyGoal = options.verifyGoal ?? defaultGoalVerifier;
    this.maxSteps = validateMaxSteps(options.maxSteps ?? 100);
    this.now = options.now ?? Date.now;
    this.leaseManager =
      options.leaseManager ??
      new GoalRunLeaseManager({
        repository: options.repository,
        ownerId: options.leaseOwnerId ?? `orchestrator:${process.pid}:${randomUUID()}`,
        ttlMs: options.leaseTtlMs ?? 30_000,
        clock: { now: this.now },
      });
    this.leaseHeartbeatMs = validateLeaseHeartbeat(
      options.leaseHeartbeatMs ?? Math.max(1_000, Math.floor((options.leaseTtlMs ?? 30_000) / 3)),
      options.leaseTtlMs ?? 30_000,
    );
  }

  get active(): boolean {
    return this.activeGoalId !== undefined;
  }

  requestPause(goalId: string, options: ControlCommandOptions = {}): StoredGoal {
    const reservation = this.reserveControlCommand(goalId, 'pause', {}, options);
    if (reservation.replayed) return this.replayGoal(reservation.command);
    try {
      const goal = this.options.repository.getGoal(goalId);
      if (goal.status === 'PAUSED') {
        this.completeCommand(reservation.command, { goal });
        return goal;
      }
      if (goal.status === 'COMPLETED' || goal.status === 'FAILED' || goal.status === 'ABORTED') {
        throw new OrchestratorBusyError(goalId, `Goal ${goalId} is already terminal.`);
      }
      if (this.activeGoalId === goalId) {
        this.queueControlRequest(goalId, 'PAUSE', reservation.command);
        this.options.repository.appendEvent({
          id: `${goalId}:control:pause:${randomUUID()}`,
          goalId,
          type: 'goal.pause_requested',
          payload: { reason: 'Pause requested; the active Attempt will finish first.' },
          confidence: 1,
          timestamp: this.now(),
        });
        return goal;
      }
      const updatedGoal = this.options.repository.transitionGoal(goalId, 'PAUSED', this.now());
      this.completeCommand(reservation.command, { goal: updatedGoal });
      return updatedGoal;
    } catch (error) {
      this.rejectCommand(reservation.command, error);
      throw error;
    }
  }

  requestAbort(goalId: string, options: ControlCommandOptions = {}): StoredGoal {
    const reservation = this.reserveControlCommand(goalId, 'abort', {}, options);
    if (reservation.replayed) return this.replayGoal(reservation.command);
    try {
      const goal = this.options.repository.getGoal(goalId);
      if (goal.status === 'ABORTED') {
        this.completeCommand(reservation.command, { goal });
        return goal;
      }
      if (goal.status === 'COMPLETED' || goal.status === 'FAILED') {
        throw new OrchestratorBusyError(goalId, `Goal ${goalId} is already terminal.`);
      }
      if (this.activeGoalId === goalId) {
        this.queueControlRequest(goalId, 'ABORT', reservation.command);
        this.options.repository.appendEvent({
          id: `${goalId}:control:abort:${randomUUID()}`,
          goalId,
          type: 'goal.abort_requested',
          payload: { reason: 'Abort requested; the active Attempt will finish first.' },
          confidence: 1,
          timestamp: this.now(),
        });
        return goal;
      }
      const updatedGoal = this.options.repository.transitionGoal(goalId, 'ABORTED', this.now());
      this.completeCommand(reservation.command, { goal: updatedGoal });
      return updatedGoal;
    } catch (error) {
      this.rejectCommand(reservation.command, error);
      throw error;
    }
  }

  async resumeGoal(goalId: string, options: ResumeGoalOptions = {}): Promise<GoalRunResult> {
    const reservation = this.reserveControlCommand(
      goalId,
      'resume',
      { confirmExternalProcessStopped: options.confirmExternalProcessStopped === true },
      options,
    );
    if (reservation.replayed) return this.replayRunResult(reservation.command);
    try {
      const goal = this.options.repository.getGoal(goalId);
      if (goal.status === 'NEEDS_HUMAN') {
        if (options.confirmExternalProcessStopped !== true) {
          throw new OrchestratorBusyError(
            goalId,
            `Goal ${goalId} requires confirmation that its external Provider process is stopped before resuming.`,
          );
        }
      } else if (goal.status !== 'PAUSED') {
        throw new OrchestratorBusyError(
          goalId,
          `Only a PAUSED Goal can be resumed without confirmation; NEEDS_HUMAN requires explicit confirmation: ${goalId}.`,
        );
      }
      const result = await this.runGoal(
        goalId,
        undefined,
        goal.status === 'NEEDS_HUMAN' ? () => this.prepareHumanRecovery(goalId) : undefined,
      );
      this.completeCommand(reservation.command, asJsonObject(result));
      return result;
    } catch (error) {
      this.rejectCommand(reservation.command, error);
      throw error;
    }
  }

  createGoalAndRun(
    input: CreateGoalInput,
    options: ControlCommandOptions = {},
  ): Promise<GoalRunResult> {
    let existingGoal: StoredGoal | undefined;
    try {
      existingGoal = this.options.repository.getGoal(input.id);
    } catch (error) {
      if (!(error instanceof StorageNotFoundError)) throw error;
    }
    if (existingGoal === undefined && this.activeGoalId !== undefined) {
      throw new OrchestratorBusyError(this.activeGoalId);
    }
    const goal = existingGoal ?? this.options.repository.createGoal(input);
    const reservation = this.reserveControlCommand(
      goal.id,
      'start',
      {
        workspace: input.workspace,
        prompt: input.prompt,
        provider: input.provider,
        constraints: input.constraints ?? {},
        roadmap: input.roadmap ?? [],
        projectState: input.projectState ?? {},
        executionMemory: input.executionMemory ?? {},
        workingSet: input.workingSet ?? {},
      },
      options,
    );
    if (reservation.replayed) return Promise.resolve(this.replayRunResult(reservation.command));
    if (existingGoal !== undefined) {
      const error = new StorageConflictError(`Goal ${goal.id} already exists.`);
      this.rejectCommand(reservation.command, error);
      throw error;
    }
    return this.runGoal(goal.id).then(
      (result) => {
        this.completeCommand(reservation.command, asJsonObject(result));
        return result;
      },
      (error: unknown) => {
        this.rejectCommand(reservation.command, error);
        throw error;
      },
    );
  }

  async retryTask(
    goalId: string,
    taskId: string,
    options: RetryTaskOptions = {},
  ): Promise<RetryRunResult> {
    const reservation = this.reserveControlCommand(
      goalId,
      'retry',
      {
        taskId,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        confirmExternalProcessStopped: options.confirmExternalProcessStopped === true,
      },
      options,
    );
    if (reservation.replayed) return this.replayRetryResult(reservation.command);
    try {
      let retry: RetryTaskPlan | undefined;
      const result = await this.runGoal(goalId, () => {
        retry = beginTaskRetry(this.options.repository, {
          goalId,
          taskId,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
          ...(options.confirmExternalProcessStopped === true
            ? { confirmExternalProcessStopped: true }
            : {}),
          now: this.now(),
        });
      });
      if (retry === undefined) {
        throw new OrchestratorCommandError('Retry preparation did not produce a retry plan.');
      }
      const retryResult = { ...result, retry };
      this.completeCommand(reservation.command, asJsonObject(retryResult));
      return retryResult;
    } catch (error) {
      this.rejectCommand(reservation.command, error);
      throw error;
    }
  }

  editFutureTaskContract(
    goalId: string,
    taskId: string,
    options: EditFutureTaskOptions,
  ): RoadmapTaskMutationResult {
    const payload: JsonObject = {
      taskId,
      reason: options.reason,
      patch: options.patch,
    };
    const reservation = this.reserveControlCommand(goalId, 'edit-task-contract', payload, options);
    if (reservation.replayed) return this.replayTaskMutation(reservation.command);
    try {
      const mutation: UpdateFutureTaskContractInput = {
        id: `${goalId}:task-contract:${randomUUID()}`,
        goalId,
        taskId,
        patch: options.patch,
        reason: options.reason,
        ...(options.expectedRevision === undefined
          ? {}
          : { expectedActiveRevision: options.expectedRevision }),
        now: this.now(),
      };
      const result = this.options.repository.updateFutureTaskContract(mutation);
      this.completeCommand(reservation.command, asJsonObject(result));
      return result;
    } catch (error) {
      this.rejectCommand(reservation.command, error);
      throw error;
    }
  }

  insertFutureTask(goalId: string, options: InsertFutureTaskOptions): RoadmapTaskMutationResult {
    const taskId = options.taskId ?? `${goalId}:task:${randomUUID()}`;
    const payload: JsonObject = {
      taskId,
      title: options.title,
      objective: options.objective,
      acceptanceCriteria: options.acceptanceCriteria,
      verification: options.verification ?? {},
      constraints: options.constraints ?? {},
      maxAttempts: options.maxAttempts ?? 3,
      ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
      tentative: options.tentative !== false,
      ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
      reason: options.reason,
    };
    const reservation = this.reserveControlCommand(goalId, 'insert-task', payload, options);
    if (reservation.replayed) return this.replayTaskMutation(reservation.command);
    try {
      const input: InsertRoadmapTaskInput = {
        id: `${goalId}:roadmap:${randomUUID()}`,
        goalId,
        taskId,
        title: options.title,
        objective: options.objective,
        acceptanceCriteria: options.acceptanceCriteria,
        ...(options.verification === undefined ? {} : { verification: options.verification }),
        ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
        maxAttempts: options.maxAttempts ?? 3,
        ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
        ...(options.tentative === undefined ? {} : { tentative: options.tentative }),
        ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
        reason: options.reason,
        ...(options.expectedRevision === undefined
          ? {}
          : { expectedActiveRevision: options.expectedRevision }),
        now: this.now(),
      };
      const result = this.options.repository.insertRoadmapTask(input);
      this.completeCommand(reservation.command, asJsonObject(result));
      return result;
    } catch (error) {
      this.rejectCommand(reservation.command, error);
      throw error;
    }
  }

  skipFutureTask(
    goalId: string,
    taskId: string,
    options: SkipFutureTaskOptions,
  ): RoadmapTaskMutationResult {
    const payload: JsonObject = { taskId, reason: options.reason };
    const reservation = this.reserveControlCommand(goalId, 'skip-task', payload, options);
    if (reservation.replayed) return this.replayTaskMutation(reservation.command);
    try {
      const input: SkipRoadmapTaskInput = {
        id: `${goalId}:roadmap:${randomUUID()}`,
        goalId,
        taskId,
        reason: options.reason,
        ...(options.expectedRevision === undefined
          ? {}
          : { expectedActiveRevision: options.expectedRevision }),
        now: this.now(),
      };
      const result = this.options.repository.skipRoadmapTask(input);
      this.completeCommand(reservation.command, asJsonObject(result));
      return result;
    } catch (error) {
      this.rejectCommand(reservation.command, error);
      throw error;
    }
  }

  reorderFutureTasks(goalId: string, options: ReorderFutureTasksOptions): RoadmapReorderResult {
    const payload: JsonObject = { taskIds: options.taskIds, reason: options.reason };
    const reservation = this.reserveControlCommand(goalId, 'reorder-roadmap', payload, options);
    if (reservation.replayed) return this.replayRoadmapReorder(reservation.command);
    try {
      const input: ReorderRoadmapTasksInput = {
        id: `${goalId}:roadmap:${randomUUID()}`,
        goalId,
        taskIds: options.taskIds,
        reason: options.reason,
        ...(options.expectedRevision === undefined
          ? {}
          : { expectedActiveRevision: options.expectedRevision }),
        now: this.now(),
      };
      const result = this.options.repository.reorderRoadmapTasks(input);
      this.completeCommand(reservation.command, asJsonObject(result));
      return result;
    } catch (error) {
      this.rejectCommand(reservation.command, error);
      throw error;
    }
  }

  private reserveControlCommand(
    goalId: string,
    commandKind: string,
    payload: JsonObject,
    options: ControlCommandOptions,
  ): OrchestratorCommandReservation {
    try {
      return this.options.repository.reserveOrchestratorCommand({
        id: `${commandKind}:${goalId}:${randomUUID()}`,
        goalId,
        commandKind,
        idempotencyKey: options.idempotencyKey ?? `${commandKind}:${randomUUID()}`,
        payload,
        ...(options.expectedRevision === undefined
          ? {}
          : { expectedRevision: options.expectedRevision }),
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof StorageConflictError && error.message.includes('still in progress')) {
        throw new OrchestratorBusyError(goalId, error.message);
      }
      throw error;
    }
  }

  private completeCommand(command: StoredOrchestratorCommand, result: JsonObject): void {
    this.options.repository.completeOrchestratorCommand(command.id, result, this.now());
  }

  private rejectCommand(command: StoredOrchestratorCommand, error: unknown): void {
    const errorCode = error instanceof StorageError ? error.code : 'command_failed';
    const errorMessage = error instanceof Error ? error.message : String(error);
    try {
      this.options.repository.rejectOrchestratorCommand(
        command.id,
        errorCode,
        errorMessage,
        this.now(),
      );
    } catch {
      // Preserve the original control error if the audit update itself fails.
    }
  }

  private replayCommand(command: StoredOrchestratorCommand): JsonObject {
    if (command.status === 'PENDING') {
      throw new OrchestratorBusyError(
        command.goalId,
        `Command ${command.commandKind} with idempotency key ${command.idempotencyKey} is still in progress.`,
      );
    }
    if (command.status === 'REJECTED') {
      throw new OrchestratorCommandError(
        command.errorMessage ?? `Command ${command.commandKind} was rejected.`,
        command.errorCode ?? 'command_rejected',
      );
    }
    if (command.result === undefined) {
      throw new OrchestratorCommandError(
        `Command ${command.commandKind} completed without a persisted result.`,
        'command_result_missing',
      );
    }
    return command.result;
  }

  private replayGoal(command: StoredOrchestratorCommand): StoredGoal {
    const result = this.replayCommand(command);
    const goal = result.goal;
    if (typeof goal !== 'object' || goal === null) {
      throw new OrchestratorCommandError('Persisted Goal command result is invalid.');
    }
    return goal as StoredGoal;
  }

  private replayInstruction(command: StoredOrchestratorCommand): StoredGoalInstruction {
    const result = this.replayCommand(command);
    const instructionId = result.instructionId;
    if (typeof instructionId !== 'string' || instructionId.length === 0) {
      throw new OrchestratorCommandError('Persisted Instruction command result is invalid.');
    }
    return this.options.repository.getInstruction(instructionId);
  }

  private replayRunResult(command: StoredOrchestratorCommand): GoalRunResult {
    return this.replayCommand(command) as unknown as GoalRunResult;
  }

  private replayRetryResult(command: StoredOrchestratorCommand): RetryRunResult {
    return this.replayCommand(command) as unknown as RetryRunResult;
  }

  private replayTaskMutation(command: StoredOrchestratorCommand): RoadmapTaskMutationResult {
    return this.replayCommand(command) as unknown as RoadmapTaskMutationResult;
  }

  private replayRoadmapReorder(command: StoredOrchestratorCommand): RoadmapReorderResult {
    return this.replayCommand(command) as unknown as RoadmapReorderResult;
  }

  submitInstruction(
    goalId: string,
    draft: InstructionDraft,
    options: SubmitInstructionOptions = {},
  ): StoredGoalInstruction {
    validateInstructionDraft(draft);
    const source = options.source ?? draft.source ?? 'user';
    validateInstructionDraft({ ...draft, source });
    const payload: JsonObject = {
      kind: draft.kind,
      content: draft.content,
      source,
      ...(draft.baseRevision === undefined ? {} : { baseRevision: draft.baseRevision }),
    };
    const reservation = this.reserveControlCommand(goalId, 'instruction', payload, options);
    if (reservation.replayed) return this.replayInstruction(reservation.command);
    try {
      const instruction = this.options.repository.createInstruction({
        id: draft.id ?? `${goalId}:instruction:${randomUUID()}`,
        goalId,
        kind: draft.kind,
        content: draft.content,
        source,
        ...(draft.baseRevision === undefined ? {} : { baseRevision: draft.baseRevision }),
        now: this.now(),
      });
      this.options.repository.appendEvent({
        id: `${instruction.id}:received`,
        goalId,
        type: 'goal.instruction.received',
        payload: {
          instructionId: instruction.id,
          kind: instruction.kind,
          source: instruction.source,
          baseRevision: instruction.baseRevision,
        },
        confidence: 1,
        timestamp: this.now(),
      });
      this.completeCommand(reservation.command, { instructionId: instruction.id });
      return instruction;
    } catch (error) {
      this.rejectCommand(reservation.command, error);
      throw error;
    }
  }

  async runGoal(
    goalId: string,
    prepare?: () => void,
    prepareAfterBoundary?: () => void,
  ): Promise<GoalRunResult> {
    if (this.activeGoalId !== undefined) throw new OrchestratorBusyError(this.activeGoalId);
    let lease: GoalRunLeaseHandle;
    try {
      lease = this.leaseManager.acquire(goalId);
    } catch (error) {
      if (error instanceof StorageConflictError) {
        throw new OrchestratorBusyError(
          goalId,
          `Goal ${goalId} is already being run by another owner.`,
        );
      }
      throw error;
    }
    this.activeGoalId = goalId;
    let leaseLost: Error | undefined;
    const assertLease = (): void => {
      if (leaseLost !== undefined) throw leaseLost;
      this.leaseManager.assertHeld(lease);
    };
    const heartbeat = setInterval(() => {
      if (leaseLost !== undefined) return;
      try {
        lease = this.leaseManager.heartbeat(lease);
      } catch (error) {
        leaseLost = error instanceof Error ? error : new Error(String(error));
      }
    }, this.leaseHeartbeatMs);
    try {
      assertLease();
      prepare?.();
      assertLease();
      return await this.runGoalInternal(goalId, assertLease, prepareAfterBoundary);
    } catch (error) {
      this.failPendingControl(goalId, error);
      this.markRunFailed(goalId, error);
      throw error;
    } finally {
      clearInterval(heartbeat);
      try {
        this.leaseManager.release(lease);
      } catch {
        // A lost lease is already fenced; never mask the original run result or error.
      }
      this.activeGoalId = undefined;
    }
  }

  private async runGoalInternal(
    goalId: string,
    assertLease: () => void,
    prepareAfterBoundary?: () => void,
  ): Promise<GoalRunResult> {
    const repository = this.options.repository;
    assertLease();
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
    let executionMemory = mergeExecutionMemory(context.executionMemory, goal.executionMemory);
    let workingSet = mergeWorkingSet(context.workingSet, goal.workingSet);
    let tasks = repository.listTasks(goal.id);
    let lastVerificationTaskId: string | undefined;
    let instructionApplication = this.applyPendingInstructions(
      goal,
      tasks,
      executionMemory,
      workingSet,
      'before-planning',
    );
    goal = instructionApplication.goal;
    executionMemory = instructionApplication.executionMemory;
    workingSet = instructionApplication.workingSet;
    if (instructionApplication.blockedReason !== undefined) {
      return this.pauseForHuman(
        repository.getGoal(goal.id),
        repository.listTasks(goal.id),
        instructionApplication.blockedReason,
      );
    }
    const unresolvedInstruction = repository
      .listInstructions(goal.id)
      .find(
        (instruction) =>
          instruction.status === 'NEEDS_APPROVAL' || instruction.status === 'NEEDS_CLARIFICATION',
      );
    if (unresolvedInstruction !== undefined) {
      return this.pauseForHuman(
        repository.getGoal(goal.id),
        repository.listTasks(goal.id),
        `Instruction ${unresolvedInstruction.id} is ${unresolvedInstruction.status}; resolve it before continuing.`,
      );
    }
    prepareAfterBoundary?.();
    assertLease();
    if (tasks.length === 0) {
      assertLease();
      const plan = this.planner.planInitial({ goal, projectState, executionMemory, workingSet });
      repository.updateGoalDocuments(
        goal.id,
        {
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
      const initialTasks = repository.listTasks(goal.id);
      repository.createRoadmapRevision({
        id: `${goal.id}:roadmap:${goal.activeRevision + 1}`,
        goalId: goal.id,
        parentRevision: goal.activeRevision,
        source: 'planner',
        reason: plan.rationale,
        roadmap: plan.roadmap,
        items: roadmapRevisionItems([], initialTasks),
        expectedActiveRevision: goal.activeRevision,
        now: this.now(),
      });
      goal = repository.getGoal(goal.id);
      repository.appendEvent({
        id: `${goal.id}:planning:initial`,
        goalId: goal.id,
        type: 'goal.planned',
        payload: { taskCount: plan.tentativeTasks.length + 1, rationale: plan.rationale },
        confidence: 1,
        timestamp: this.now(),
      });
      tasks = repository.listTasks(goal.id);
      goal = this.persistMemorySnapshot(goal, tasks, executionMemory, 'initial-plan');
    }
    if (goal.status === 'PLANNING')
      goal = repository.transitionGoal(goal.id, 'RUNNING', this.now());
    let lastVerification: VerificationResult | undefined;
    for (let step = 0; step < this.maxSteps; step += 1) {
      assertLease();
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
        instructionApplication = this.applyPendingInstructions(
          goal,
          tasks,
          executionMemory,
          workingSet,
          'before-attempt',
          activeTask.id,
        );
        goal = instructionApplication.goal;
        executionMemory = instructionApplication.executionMemory;
        workingSet = instructionApplication.workingSet;
        if (instructionApplication.blockedReason !== undefined) {
          return this.pauseForHuman(
            repository.getGoal(goal.id),
            repository.listTasks(goal.id),
            instructionApplication.blockedReason,
          );
        }
        if (activeTask.status === 'REPAIRING') {
          assertLease();
          repository.transitionTask(activeTask.id, 'RUNNING', this.now());
        }
        const result = await this.executeTask(
          goal,
          activeTask,
          projectState,
          workingSet,
          assertLease,
        );
        lastVerification = result.verification;
        lastVerificationTaskId = activeTask.id;
        instructionApplication = this.applyPendingInstructions(
          repository.getGoal(goal.id),
          repository.listTasks(goal.id),
          executionMemory,
          workingSet,
          'after-attempt',
          activeTask.id,
        );
        goal = instructionApplication.goal;
        executionMemory = instructionApplication.executionMemory;
        workingSet = instructionApplication.workingSet;
        if (instructionApplication.blockedReason !== undefined) {
          return this.pauseForHuman(
            repository.getGoal(goal.id),
            repository.listTasks(goal.id),
            instructionApplication.blockedReason,
          );
        }
        const completedTask = repository.getTask(activeTask.id);
        const latestVerification = repository.listVerificationRuns(activeTask.id).at(-1);
        executionMemory = rememberTaskOutcome(
          executionMemory,
          completedTask,
          latestVerification,
          result.reason,
          this.now(),
        );
        goal = this.persistMemorySnapshot(
          repository.getGoal(goal.id),
          repository.listTasks(goal.id),
          executionMemory,
          'after-attempt',
        );
        if (result.next === 'HUMAN') {
          return this.pauseForHuman(
            repository.getGoal(goal.id),
            repository.listTasks(goal.id),
            result.reason,
          );
        }
        const controlRequest = this.controlRequests.get(goal.id);
        if (controlRequest !== undefined) {
          const controlResult = this.applyControl(
            goal.id,
            controlRequest.control,
            controlRequest.command,
          );
          this.controlRequests.delete(goal.id);
          return controlResult;
        }
        continue;
      }
      instructionApplication = this.applyPendingInstructions(
        goal,
        tasks,
        executionMemory,
        workingSet,
        'before-planning',
        goal.currentTaskId,
      );
      goal = instructionApplication.goal;
      executionMemory = instructionApplication.executionMemory;
      workingSet = instructionApplication.workingSet;
      if (instructionApplication.blockedReason !== undefined) {
        return this.pauseForHuman(
          repository.getGoal(goal.id),
          repository.listTasks(goal.id),
          instructionApplication.blockedReason,
        );
      }
      tasks = repository.listTasks(goal.id);
      const rolling = this.planRolling(
        goal,
        tasks,
        lastVerificationTaskId === undefined
          ? undefined
          : repository.listVerificationRuns(lastVerificationTaskId).at(-1),
        projectState,
        executionMemory,
        workingSet,
      );
      tasks = repository.listTasks(goal.id);
      if (rolling.action === 'NEEDS_HUMAN' || rolling.action === 'INSPECT') {
        return this.pauseForHuman(goal, tasks, rolling.rationale);
      }
      if (rolling.action === 'REPLAN' && rolling.nextTask === undefined) {
        return this.pauseForHuman(
          goal,
          tasks,
          'Rolling Planner requested a replan without a safe Task Contract.',
        );
      }
      if (rolling.nextTask !== undefined) {
        const merge = evaluatePlannerTaskMerge({ goal, tasks, draft: rolling.nextTask });
        repository.appendEvent({
          id: `${goal.id}:rolling-plan-merge:${randomUUID()}`,
          goalId: goal.id,
          type: 'goal.rolling_plan.merge',
          payload: { decision: merge.decision, reason: merge.reason, taskId: rolling.nextTask.id },
          confidence: merge.decision === 'NEEDS_HUMAN' ? 1 : 0.9,
          timestamp: this.now(),
        });
        if (merge.decision === 'NEEDS_HUMAN') {
          return this.pauseForHuman(goal, tasks, merge.reason);
        }
        if (merge.decision === 'ACCEPT') {
          repository.createTask({ ...rolling.nextTask, goalId: goal.id, now: this.now() });
          tasks = repository.listTasks(goal.id);
        }
      }
      if (
        rolling.action === 'GOAL_READY_FOR_FINAL_VERIFICATION' &&
        tasks.some((task) => task.status !== 'COMPLETED' && task.status !== 'SKIPPED')
      ) {
        return this.pauseForHuman(
          goal,
          tasks,
          'Rolling Planner marked the Goal ready while non-terminal Tasks remain.',
        );
      }
      goal = this.persistRoadmapRevisionIfChanged(goal, tasks, rolling.rationale);
      const pending = tasks
        .filter((task) => task.status === 'PENDING')
        .sort((left, right) => left.sequence - right.sequence)[0];
      if (pending !== undefined) {
        assertLease();
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
      assertLease();
      goal = repository.transitionGoal(goal.id, 'VERIFYING', this.now());
      let final = await this.verifyGoal({ goal, tasks, projectState, workingSet });
      if (final.status === 'PASS' && tasks.some((task) => task.status === 'SKIPPED')) {
        final = {
          ...final,
          status: 'UNCERTAIN',
          reason:
            'At least one Task was skipped; a human must confirm that the original Goal requirement remains covered.',
        };
      }
      assertLease();
      lastVerification = final;
      const finalTask = tasks.at(-1);
      if (finalTask !== undefined) {
        repository.createVerificationRun({
          id: `${goal.id}:final-verification:${randomUUID()}`,
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
        id: `${goal.id}:goal-verification:${randomUUID()}`,
        goalId: goal.id,
        type: 'goal.verification.completed',
        payload: { status: final.status, reason: final.reason },
        confidence: final.status === 'PASS' ? 1 : 0.5,
        timestamp: this.now(),
      });
      if (final.status === 'FAIL') {
        const nextSequence = Math.max(0, ...tasks.map((task) => task.sequence)) + 1;
        const gapTask = repository.createTask({
          id: `${goal.id}:gap:${nextSequence}`,
          goalId: goal.id,
          title: 'Address final verification gap',
          objective: final.reason,
          acceptanceCriteria:
            final.criteria.length === 0
              ? ['The final Goal verification passes after the gap is addressed.']
              : final.criteria.map((criterion) => criterion.criterion),
          verification: {
            checks: final.deterministicChecks.map((check) => ({
              id: check.id,
              label: check.label,
              executable: check.executable,
              args: check.args,
            })),
            deterministicFirst: true,
          },
          constraints: { singleWorker: true, noRemotePush: true, gapFromFinalVerification: true },
          maxAttempts: 3,
          sequence: nextSequence,
          tentative: false,
          ...(finalTask === undefined ? {} : { parentTaskId: finalTask.id }),
          now: this.now(),
        });
        repository.appendEvent({
          id: `${goal.id}:gap-task:${gapTask.id}`,
          goalId: goal.id,
          taskId: gapTask.id,
          type: 'goal.gap_task.created',
          payload: { reason: final.reason, verificationStatus: final.status },
          confidence: 1,
          timestamp: this.now(),
        });
      }
      if (final.status === 'PASS') {
        goal = repository.transitionGoal(goal.id, 'COMPLETED', this.now());
      } else {
        goal = repository.transitionGoal(goal.id, 'NEEDS_HUMAN', this.now());
      }
      goal = this.persistMemorySnapshot(
        goal,
        repository.listTasks(goal.id),
        executionMemory,
        'final-verification',
      );
      return { goal, tasks: repository.listTasks(goal.id), status: goal.status, lastVerification };
    }
    return this.pauseForHuman(
      repository.getGoal(goal.id),
      repository.listTasks(goal.id),
      `The Orchestrator reached its ${this.maxSteps}-step safety bound.`,
    );
  }

  private applyPendingInstructions(
    goal: StoredGoal,
    tasks: readonly StoredTask[],
    executionMemory: ExecutionMemory,
    workingSet: WorkingSet,
    boundary: InstructionBoundary,
    currentTaskId?: string,
  ): InstructionApplicationOutcome {
    const repository = this.options.repository;
    let nextGoal = goal;
    let nextExecutionMemory = executionMemory;
    let nextWorkingSet = workingSet;
    const pending = repository.listInstructions(goal.id, { status: 'PENDING' });
    for (const instruction of pending) {
      const decision = evaluateInstructionApplicability({
        goal: nextGoal,
        instruction,
        tasks,
      });
      if (decision.decision === 'APPLY') {
        nextExecutionMemory = rememberAppliedInstruction(
          nextExecutionMemory,
          instruction,
          this.now(),
        );
        nextWorkingSet = rememberInstructionInWorkingSet(nextWorkingSet, instruction, this.now());
      }
      const status = instructionStatusForDecision(decision);
      const application = repository.applyInstructionAtBoundary({
        id: instruction.id,
        status,
        ...(status === 'APPLIED' ? { appliedRevision: nextGoal.activeRevision } : {}),
        ...(currentTaskId === undefined ? {} : { appliedTaskId: currentTaskId }),
        decisionReason: decision.reason,
        ...(status === 'APPLIED'
          ? {
              executionMemory: asJsonObject(nextExecutionMemory),
              workingSet: asJsonObject(nextWorkingSet),
            }
          : {}),
        event: instructionDecisionEvent(
          nextGoal.id,
          instruction,
          decision,
          boundary,
          currentTaskId,
          this.now(),
        ),
        now: this.now(),
      });
      nextGoal = application.goal;
      if (decision.decision === 'NEEDS_APPROVAL' || decision.decision === 'NEEDS_CLARIFICATION') {
        return {
          goal: nextGoal,
          executionMemory: nextExecutionMemory,
          workingSet: nextWorkingSet,
          blockedReason: `Instruction ${instruction.id} cannot continue automatically: ${decision.reason}`,
        };
      }
    }
    return {
      goal: nextGoal,
      executionMemory: nextExecutionMemory,
      workingSet: nextWorkingSet,
    };
  }

  private persistRoadmapRevisionIfChanged(
    goal: StoredGoal,
    tasks: readonly StoredTask[],
    reason: string,
  ): StoredGoal {
    const nextRoadmap = roadmapFromTasks(goal.roadmap, tasks);
    if (JSON.stringify(nextRoadmap) === JSON.stringify(goal.roadmap)) return goal;
    this.options.repository.createRoadmapRevision({
      id: `${goal.id}:roadmap:${goal.activeRevision + 1}`,
      goalId: goal.id,
      parentRevision: goal.activeRevision,
      source: 'planner',
      reason,
      roadmap: nextRoadmap,
      items: roadmapRevisionItems(goal.roadmap, tasks),
      expectedActiveRevision: goal.activeRevision,
      now: this.now(),
    });
    return this.options.repository.getGoal(goal.id);
  }

  private persistMemorySnapshot(
    goal: StoredGoal,
    tasks: readonly StoredTask[],
    executionMemory: ExecutionMemory,
    reason: string,
  ): StoredGoal {
    const repository = this.options.repository;
    const verificationRuns = tasks.flatMap((task) => repository.listVerificationRuns(task.id));
    const snapshot = buildMemorySnapshot({
      goal,
      tasks,
      executionMemory,
      verificationRuns,
      reason,
      now: this.now(),
    });
    repository.updateGoalDocuments(goal.id, { executionMemory: snapshot.memory }, this.now());
    const updatedGoal = repository.getGoal(goal.id);
    const previousSnapshot = repository.listMemorySnapshots(goal.id, 500).at(-1);
    const memoryRevision = (previousSnapshot?.revision ?? 0) + 1;
    const storedSnapshot = repository.createMemorySnapshot({
      id: `${goal.id}:memory:${updatedGoal.activeRevision}:${randomUUID()}`,
      goalId: goal.id,
      revision: memoryRevision,
      memory: snapshot.memory,
      sources: snapshot.sources,
      now: this.now(),
    });
    repository.appendEvent({
      id: `${goal.id}:memory:${storedSnapshot.id}:event`,
      goalId: goal.id,
      type: 'goal.memory.snapshot',
      payload: {
        snapshotId: storedSnapshot.id,
        revision: storedSnapshot.revision,
        activeRoadmapRevision: updatedGoal.activeRevision,
        reason,
        sourceCount: storedSnapshot.sources.length,
      },
      confidence: 1,
      timestamp: this.now(),
    });
    return updatedGoal;
  }

  private planRolling(
    goal: StoredGoal,
    tasks: readonly StoredTask[],
    latestVerification: StoredVerificationRun | undefined,
    projectState: ProjectState,
    executionMemory: BootstrapContext['executionMemory'],
    workingSet: WorkingSet,
  ): ReturnType<Planner['planRolling']> {
    try {
      const plan = this.planner.planRolling({
        goal,
        tasks,
        ...(latestVerification === undefined ? {} : { latestVerification }),
        projectState,
        executionMemory,
        workingSet,
      });
      this.options.repository.appendEvent({
        id: `${goal.id}:rolling-plan:${randomUUID()}`,
        goalId: goal.id,
        type: 'goal.rolling_plan',
        payload: { action: plan.action, rationale: plan.rationale, nextTaskId: plan.nextTask?.id },
        confidence: 1,
        timestamp: this.now(),
      });
      return plan;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.repository.appendEvent({
        id: `${goal.id}:rolling-plan-failed:${randomUUID()}`,
        goalId: goal.id,
        type: 'goal.rolling_plan_failed',
        payload: { reason },
        confidence: 1,
        timestamp: this.now(),
      });
      return {
        goalId: goal.id,
        action: 'NEEDS_HUMAN',
        rationale: `Rolling Planner failed safely: ${reason}`,
      };
    }
  }

  private applyControl(
    goalId: string,
    control: 'PAUSE' | 'ABORT',
    command?: StoredOrchestratorCommand,
  ): GoalRunResult {
    const repository = this.options.repository;
    const tasks = repository.listTasks(goalId);
    const status = control === 'PAUSE' ? 'PAUSED' : 'ABORTED';
    const updatedGoal = repository.transitionGoal(goalId, status, this.now());
    repository.appendEvent({
      id: `${goalId}:control:${control.toLowerCase()}:${randomUUID()}:applied`,
      goalId,
      type: control === 'PAUSE' ? 'goal.paused' : 'goal.aborted',
      payload: {
        reason: control === 'PAUSE' ? 'Pause request applied.' : 'Abort request applied.',
      },
      confidence: 1,
      timestamp: this.now(),
    });
    const result = { goal: updatedGoal, tasks, status: updatedGoal.status };
    if (command !== undefined) this.completeCommand(command, result);
    return result;
  }

  private queueControlRequest(
    goalId: string,
    control: 'PAUSE' | 'ABORT',
    command: StoredOrchestratorCommand,
  ): void {
    const existing = this.controlRequests.get(goalId);
    if (existing !== undefined) {
      throw new OrchestratorBusyError(
        goalId,
        `Goal ${goalId} already has a ${existing.control.toLowerCase()} request in progress.`,
      );
    }
    this.controlRequests.set(goalId, { control, command });
  }

  private failPendingControl(goalId: string, error: unknown): void {
    const request = this.controlRequests.get(goalId);
    if (request === undefined) return;
    this.controlRequests.delete(goalId);
    this.rejectCommand(request.command, error);
  }

  private markRunFailed(goalId: string, error: unknown): void {
    const repository = this.options.repository;
    const reason = error instanceof Error ? error.message : String(error);
    try {
      const goal = repository.getGoal(goalId);
      if (['CREATED', 'PLANNING', 'RUNNING', 'VERIFYING'].includes(goal.status)) {
        repository.transitionGoal(goalId, 'NEEDS_HUMAN', this.now());
      }
      repository.appendEvent({
        id: `${goalId}:run-failed:${randomUUID()}`,
        goalId,
        type: 'goal.run_failed',
        payload: { reason },
        confidence: 1,
        timestamp: this.now(),
      });
    } catch {
      // Preserve the original failure. A secondary persistence failure must not mask it.
    }
  }

  private async executeTask(
    goal: StoredGoal,
    task: StoredTask,
    projectState: ProjectState,
    workingSet: WorkingSet,
    assertLease: () => void,
  ): Promise<{
    readonly next: 'CONTINUE' | 'HUMAN';
    readonly verification: VerificationResult;
    readonly reason: string;
  }> {
    const repository = this.options.repository;
    assertLease();
    const attempts = repository.listAttempts(task.id);
    const retryContext = createWorkerRetryContext(
      attempts,
      repository.listVerificationRuns(task.id),
    );
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
        ...(retryContext === undefined ? {} : { retryContext }),
      });
    } catch (error) {
      assertLease();
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
        assertLease,
      );
    }
    assertLease();
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
    assertLease();
    repository.transitionTask(task.id, 'VERIFYING', this.now());
    const verification = await this.verifyTask({
      workspace: goal.workspace,
      task: repository.getTask(task.id),
      projectState,
      workerResult,
    });
    assertLease();
    return this.handleVerification(
      goal,
      task,
      attempt.id,
      attemptNumber,
      verification,
      assertLease,
    );
  }

  private handleVerification(
    goal: StoredGoal,
    task: StoredTask,
    attemptId: string,
    attemptNumber: number,
    verification: VerificationResult,
    assertLease: () => void,
  ): {
    readonly next: 'CONTINUE' | 'HUMAN';
    readonly verification: VerificationResult;
    readonly reason: string;
  } {
    const repository = this.options.repository;
    assertLease();
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
      id: `${goal.id}:needs-human:${randomUUID()}`,
      goalId: goal.id,
      type: 'goal.needs_human',
      payload: { reason },
      confidence: 1,
      timestamp: this.now(),
    });
    return { goal, tasks, status: goal.status };
  }

  private prepareHumanRecovery(goalId: string): void {
    const repository = this.options.repository;
    const goal = repository.getGoal(goalId);
    const tasks = repository.listTasks(goalId);
    const attempts = tasks.flatMap((task) => repository.listAttempts(task.id));
    const decision = classifyGoalRecovery({
      goal,
      tasks,
      attempts,
      evidence: {
        now: this.now(),
        providerProcess: 'stopped',
        sessionStatus: 'unknown',
      },
    });
    if (decision.classification !== 'SAFE_TO_RESUME' && decision.classification !== 'RETRYABLE') {
      throw new OrchestratorBusyError(
        goalId,
        `Goal ${goalId} cannot be resumed safely (${decision.reason}).`,
      );
    }
    for (const task of tasks) {
      if (task.status !== 'NEEDS_HUMAN') continue;
      const taskAttempts = repository.listAttempts(task.id);
      const activeAttempt = taskAttempts.find((attempt) =>
        ['CREATED', 'RUNNING'].includes(attempt.status),
      );
      if (activeAttempt !== undefined) {
        throw new OrchestratorBusyError(
          goalId,
          `Task ${task.id} still has an active Attempt; inspect it before resuming.`,
        );
      }
      const latestAttempt = [...taskAttempts].sort(
        (left, right) => right.attemptNumber - left.attemptNumber,
      )[0];
      if (
        latestAttempt !== undefined &&
        latestAttempt.attemptNumber >= task.maxAttempts &&
        ['FAILED', 'INTERRUPTED', 'NEEDS_HUMAN'].includes(latestAttempt.status)
      ) {
        throw new OrchestratorBusyError(
          goalId,
          `Task ${task.id} reached its bounded Attempt limit and cannot be resumed automatically.`,
        );
      }
      repository.transitionTask(task.id, 'RUNNING', this.now());
    }
    repository.appendEvent({
      id: `${goalId}:resume:accepted:${randomUUID()}`,
      goalId,
      type: 'goal.recovery.resumed',
      payload: {
        classification: decision.classification,
        reason: 'External Provider process was explicitly confirmed stopped.',
      },
      confidence: 1,
      timestamp: this.now(),
    });
  }
}

function instructionStatusForDecision(
  decision: InstructionApplicabilityResult,
): 'APPLIED' | 'REJECTED' | 'NEEDS_APPROVAL' | 'NEEDS_CLARIFICATION' {
  switch (decision.decision) {
    case 'APPLY':
      return 'APPLIED';
    case 'REJECT':
      return 'REJECTED';
    case 'NEEDS_APPROVAL':
      return 'NEEDS_APPROVAL';
    case 'NEEDS_CLARIFICATION':
      return 'NEEDS_CLARIFICATION';
  }
}

function instructionDecisionEvent(
  goalId: string,
  instruction: StoredGoalInstruction,
  decision: InstructionApplicabilityResult,
  boundary: InstructionBoundary,
  currentTaskId: string | undefined,
  timestamp: number,
): {
  readonly id: string;
  readonly goalId: string;
  readonly taskId?: string;
  readonly type: string;
  readonly payload: JsonObject;
  readonly confidence: number;
  readonly timestamp: number;
} {
  const type =
    decision.decision === 'APPLY' ? 'goal.instruction.applied' : 'goal.instruction.rejected';
  return {
    id: `${instruction.id}:${type}:${randomUUID()}`,
    goalId,
    ...(currentTaskId === undefined ? {} : { taskId: currentTaskId }),
    type,
    payload: {
      instructionId: instruction.id,
      kind: instruction.kind,
      source: instruction.source,
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      boundary,
      ...(decision.decision === 'APPLY' ? { appliedRevision: instruction.baseRevision } : {}),
    },
    confidence: decision.decision === 'APPLY' || decision.decision === 'REJECT' ? 1 : 0.9,
    timestamp,
  };
}

function rememberAppliedInstruction(
  memory: ExecutionMemory,
  instruction: StoredGoalInstruction,
  recordedAt: number,
): ExecutionMemory {
  const decisions = Array.isArray(memory.decisions) ? memory.decisions : [];
  const notes = Array.isArray(memory.notes) ? memory.notes : [];
  if (decisions.some((decision) => decision.id === `instruction:${instruction.id}`)) {
    return memory;
  }
  return {
    ...memory,
    decisions: [
      ...decisions,
      {
        id: `instruction:${instruction.id}`,
        summary: `Applied ${instruction.kind} instruction ${instruction.id} at a safe boundary.`,
        status: instruction.kind === 'constraint' ? 'STABLE' : 'TENTATIVE',
        source: instruction.source,
        recordedAt,
        sourceRefs: [{ kind: 'instruction' as const, id: instruction.id }],
      },
    ].slice(-100),
    notes: [...notes, `instruction:${instruction.id}:applied`].slice(-200),
    sourceRefs: [
      ...(memory.sourceRefs ?? []),
      { kind: 'instruction' as const, id: instruction.id },
    ].slice(-300),
    updatedAt: recordedAt,
  };
}

function rememberInstructionInWorkingSet(
  workingSet: WorkingSet,
  instruction: StoredGoalInstruction,
  updatedAt: number,
): WorkingSet {
  const existing = Array.isArray(workingSet.appliedInstructions)
    ? workingSet.appliedInstructions
    : [];
  if (existing.some((item) => item.id === instruction.id)) return workingSet;
  const context: AppliedInstructionContext = {
    id: instruction.id,
    kind: instruction.kind,
    content:
      instruction.content.length <= 4_000
        ? instruction.content
        : `${instruction.content.slice(0, 3_997)}...`,
    appliedRevision: instruction.baseRevision,
  };
  return {
    ...workingSet,
    appliedInstructions: [...existing, context].slice(-8),
    updatedAt,
  };
}

function mergeExecutionMemory(context: ExecutionMemory, persisted: JsonObject): ExecutionMemory {
  const candidate = persisted as Partial<ExecutionMemory>;
  const persistedDecisions = Array.isArray(candidate.decisions) ? candidate.decisions : [];
  const persistedCompleted = Array.isArray(candidate.completedTaskIds)
    ? candidate.completedTaskIds.filter((value): value is string => typeof value === 'string')
    : [];
  const persistedFailed = Array.isArray(candidate.failedApproaches)
    ? candidate.failedApproaches.filter((value): value is string => typeof value === 'string')
    : [];
  const persistedNotes = Array.isArray(candidate.notes)
    ? candidate.notes.filter((value): value is string => typeof value === 'string')
    : [];
  const decisions = [...context.decisions, ...persistedDecisions].filter(
    (decision, index, all) => all.findIndex((item) => item.id === decision.id) === index,
  );
  const persistedSummaries = Array.isArray(candidate.completedTaskSummaries)
    ? candidate.completedTaskSummaries
    : [];
  const persistedIssues = Array.isArray(candidate.issues) ? candidate.issues : [];
  const persistedQuestions = Array.isArray(candidate.questions) ? candidate.questions : [];
  const persistedSourceRefs = Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs : [];
  const mergedSummaries = [...(context.completedTaskSummaries ?? []), ...persistedSummaries].filter(
    (summary, index, all) => all.findIndex((item) => item.taskId === summary.taskId) === index,
  );
  const mergedIssues = [...(context.issues ?? []), ...persistedIssues].filter(
    (issue, index, all) => all.findIndex((item) => item.id === issue.id) === index,
  );
  const mergedQuestions = [...(context.questions ?? []), ...persistedQuestions].filter(
    (question, index, all) => all.findIndex((item) => item.id === question.id) === index,
  );
  const mergedSourceRefs = [...(context.sourceRefs ?? []), ...persistedSourceRefs].filter(
    (source, index, all) =>
      all.findIndex((item) => item.kind === source.kind && item.id === source.id) === index,
  );
  const goalSummary =
    typeof candidate.goalSummary === 'string' && candidate.goalSummary.length > 0
      ? candidate.goalSummary
      : context.goalSummary;
  return {
    ...(goalSummary === undefined ? {} : { goalSummary }),
    decisions,
    completedTaskIds: [...new Set([...context.completedTaskIds, ...persistedCompleted])],
    ...(mergedSummaries.length === 0 ? {} : { completedTaskSummaries: mergedSummaries }),
    failedApproaches: [...new Set([...context.failedApproaches, ...persistedFailed])],
    ...(mergedIssues.length === 0 ? {} : { issues: mergedIssues }),
    ...(mergedQuestions.length === 0 ? {} : { questions: mergedQuestions }),
    notes: [...new Set([...context.notes, ...persistedNotes])],
    ...(mergedSourceRefs.length === 0 ? {} : { sourceRefs: mergedSourceRefs }),
    ...(typeof candidate.updatedAt === 'number' || context.updatedAt !== undefined
      ? { updatedAt: Math.max(context.updatedAt ?? 0, candidate.updatedAt ?? 0) }
      : {}),
  };
}

function mergeWorkingSet(context: WorkingSet, persisted: JsonObject): WorkingSet {
  const candidate = persisted as Partial<WorkingSet>;
  const persistedFiles = Array.isArray(candidate.files)
    ? candidate.files.filter((value): value is string => typeof value === 'string')
    : [];
  const persistedDirectories = Array.isArray(candidate.directories)
    ? candidate.directories.filter((value): value is string => typeof value === 'string')
    : [];
  const persistedInstructions = Array.isArray(candidate.appliedInstructions)
    ? candidate.appliedInstructions.filter(isAppliedInstructionContext)
    : [];
  const appliedInstructions = [
    ...(context.appliedInstructions ?? []),
    ...persistedInstructions,
  ].filter(
    (instruction, index, all) => all.findIndex((item) => item.id === instruction.id) === index,
  );
  return {
    files: [...new Set([...context.files, ...persistedFiles])],
    directories: [...new Set([...context.directories, ...persistedDirectories])],
    rationale:
      typeof candidate.rationale === 'string' && candidate.rationale.length > 0
        ? candidate.rationale
        : context.rationale,
    updatedAt:
      typeof candidate.updatedAt === 'number'
        ? Math.max(context.updatedAt, candidate.updatedAt)
        : context.updatedAt,
    ...(appliedInstructions.length === 0 ? {} : { appliedInstructions }),
  };
}

function isAppliedInstructionContext(value: unknown): value is AppliedInstructionContext {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.kind === 'string' &&
    typeof candidate.content === 'string' &&
    typeof candidate.appliedRevision === 'number'
  );
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

function createWorkerRetryContext(
  attempts: readonly StoredAttempt[],
  verifications: readonly StoredVerificationRun[],
): WorkerRetryContext | undefined {
  const previousAttempt = [...attempts].sort(
    (left, right) => right.attemptNumber - left.attemptNumber,
  )[0];
  if (previousAttempt === undefined) return undefined;
  const previousVerification = [...verifications].sort(
    (left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id),
  )[0];
  const repairObjective =
    previousVerification === undefined
      ? `Continue the Task after Attempt ${previousAttempt.attemptNumber}.`
      : `Address the previous Verification result: ${previousVerification.reason}`;
  return {
    previousAttemptId: previousAttempt.id,
    previousAttemptNumber: previousAttempt.attemptNumber,
    previousAttemptStatus: previousAttempt.status,
    ...(previousVerification === undefined
      ? {}
      : {
          previousVerificationStatus: previousVerification.status,
          previousVerificationReason: previousVerification.reason,
        }),
    previousVerificationEvidence: previousVerification?.evidence ?? [],
    repairObjective,
  };
}

async function defaultGoalVerifier(input: {
  readonly goal: StoredGoal;
  readonly tasks: readonly StoredTask[];
  readonly projectState: ProjectState;
  readonly workingSet: WorkingSet;
}): Promise<VerificationResult> {
  const tasks = input.tasks.filter((task) => task.status === 'COMPLETED');
  if (tasks.length === 0) {
    return {
      status: 'UNCERTAIN',
      criteria: [],
      deterministicChecks: [],
      evidence: [],
      reason: 'No completed Task is available for final verification.',
    };
  }
  const results: VerificationResult[] = [];
  for (const task of tasks) {
    results.push(
      await verifyTask({
        workspace: input.goal.workspace,
        task,
        projectState: input.projectState,
      }),
    );
  }
  const status = combineVerificationStatuses(results.map((result) => result.status));
  return {
    status,
    criteria: results.flatMap((result, index) =>
      result.criteria.map((criterion) => ({
        ...criterion,
        criterion: `Task ${tasks[index]?.sequence ?? index + 1}: ${criterion.criterion}`,
      })),
    ),
    deterministicChecks: results.flatMap((result) => result.deterministicChecks),
    evidence: results.flatMap((result) => result.evidence),
    reason:
      status === 'PASS'
        ? `Final Goal verification passed for ${tasks.length} completed Task(s).`
        : status === 'FAIL'
          ? 'At least one completed Task no longer satisfies its deterministic verification.'
          : 'Final Goal verification evidence is incomplete or uncertain.',
  };
}

function asJsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}

/**
 * Derive the durable roadmap projection from the current Task Contracts.
 *
 * Tasks are the execution source of truth; the roadmap is an auditable
 * projection.  A non-terminal Task keeps its tentative/locked intent, while
 * terminal Task states are reflected explicitly so the UI can explain why a
 * roadmap item is no longer actionable.
 */
function roadmapFromTasks(
  previous: readonly RoadmapItem[],
  tasks: readonly StoredTask[],
): readonly RoadmapItem[] {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  return [...tasks]
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .map((task) => {
      const previousItem = previousById.get(task.id);
      const status: RoadmapItem['status'] =
        task.status === 'COMPLETED'
          ? 'COMPLETED'
          : task.status === 'SKIPPED'
            ? 'SKIPPED'
            : previousItem?.status === 'TENTATIVE' || task.tentative
              ? 'TENTATIVE'
              : 'LOCKED';
      return {
        id: task.id,
        title: task.title,
        objective: task.objective,
        status,
      };
    });
}

/** Build a revision item for every Task Contract in the new projection. */
function roadmapRevisionItems(
  previous: readonly RoadmapItem[],
  tasks: readonly StoredTask[],
): readonly RoadmapRevisionItemInput[] {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  return [...tasks]
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .map((task) => {
      const previousItem = previousById.get(task.id);
      const status = roadmapFromTasks(previous, [task])[0]?.status ?? 'LOCKED';
      const snapshot: JsonObject = {
        id: task.id,
        title: task.title,
        objective: task.objective,
        acceptanceCriteria: task.acceptanceCriteria,
        verification: task.verification,
        constraints: task.constraints,
        maxAttempts: task.maxAttempts,
        status,
        sequence: task.sequence,
        tentative: task.tentative,
        ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      };
      const operation =
        previousItem === undefined
          ? 'added'
          : JSON.stringify(previousItem) ===
              JSON.stringify({
                id: task.id,
                title: task.title,
                objective: task.objective,
                status,
              })
            ? 'retained'
            : 'updated';
      return {
        taskId: task.id,
        sequence: task.sequence,
        operation,
        tentative: task.tentative,
        snapshot,
      };
    });
}

function combineVerificationStatuses(
  statuses: readonly VerificationResult['status'][],
): VerificationResult['status'] {
  if (statuses.length === 0 || statuses.some((status) => status === 'UNCERTAIN'))
    return 'UNCERTAIN';
  if (statuses.some((status) => status === 'FAIL')) return 'FAIL';
  return 'PASS';
}

function validateMaxSteps(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError('maxSteps must be an integer between 1 and 1000.');
  }
  return value;
}

function validateLeaseHeartbeat(value: number, ttlMs: number): number {
  if (!Number.isInteger(value) || value < 1 || value >= ttlMs) {
    throw new RangeError('leaseHeartbeatMs must be a positive integer smaller than leaseTtlMs.');
  }
  return value;
}
