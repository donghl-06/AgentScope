import { randomUUID } from 'node:crypto';

import type {
  JsonObject,
  OrchestratorRepository,
  StoredAttempt,
  StoredGoal,
  StoredTask,
  StoredVerificationRun,
} from '@agentscope/storage';

export type RetryReasonCode =
  | 'verification_failed'
  | 'verification_uncertain'
  | 'attempt_failed'
  | 'attempt_interrupted'
  | 'attempt_needs_human';

export interface RetryTaskPlan {
  readonly goalId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly reasonCode: RetryReasonCode;
  readonly reason: string;
  readonly repairObjective: string;
  readonly previousAttempt?: StoredAttempt;
  readonly previousVerification?: StoredVerificationRun;
  readonly verificationEvidence: readonly JsonObject[];
}

export interface RetryTaskPlanInput {
  readonly goal: StoredGoal;
  readonly task: StoredTask;
  readonly attempts: readonly StoredAttempt[];
  readonly verifications: readonly StoredVerificationRun[];
}

export interface BeginTaskRetryOptions {
  readonly goalId: string;
  readonly taskId: string;
  readonly reason?: string;
  readonly confirmExternalProcessStopped?: boolean;
  readonly now?: number;
}

export class RetryNotAllowedError extends Error {
  readonly code = 'retry_not_allowed';

  constructor(message: string) {
    super(message);
    this.name = 'RetryNotAllowedError';
  }
}

/**
 * Build a bounded retry plan without mutating persistence.
 * A retry is only valid when the latest evidence identifies a failed boundary.
 */
export function planTaskRetry(input: RetryTaskPlanInput): RetryTaskPlan {
  if (input.task.goalId !== input.goal.id) {
    throw new RetryNotAllowedError(`Task ${input.task.id} belongs to another Goal.`);
  }
  if (['COMPLETED', 'SKIPPED', 'FAILED'].includes(input.task.status)) {
    throw new RetryNotAllowedError(
      `Task ${input.task.id} is ${input.task.status} and cannot be retried.`,
    );
  }
  const activeAttempt = input.attempts.find((attempt) =>
    ['CREATED', 'RUNNING'].includes(attempt.status),
  );
  if (activeAttempt !== undefined) {
    throw new RetryNotAllowedError(
      `Task ${input.task.id} still has active Attempt ${activeAttempt.id}.`,
    );
  }
  if (input.attempts.length >= input.task.maxAttempts) {
    throw new RetryNotAllowedError(
      `Task ${input.task.id} reached its maximum of ${input.task.maxAttempts} Attempts.`,
    );
  }
  const previousAttempt = [...input.attempts].sort(
    (left, right) => right.attemptNumber - left.attemptNumber,
  )[0];
  const previousVerification = [...input.verifications].sort(
    (left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id),
  )[0];
  const reasonCode = retryReasonCode(previousAttempt, previousVerification);
  if (reasonCode === undefined) {
    throw new RetryNotAllowedError(
      `Task ${input.task.id} has no failed, interrupted, or uncertain boundary to retry.`,
    );
  }
  const reason = retryReason(reasonCode, previousAttempt, previousVerification);
  return {
    goalId: input.goal.id,
    taskId: input.task.id,
    attemptNumber: input.attempts.length + 1,
    reasonCode,
    reason,
    repairObjective: buildRepairObjective(input.task, reason, previousVerification),
    ...(previousAttempt === undefined ? {} : { previousAttempt }),
    ...(previousVerification === undefined ? {} : { previousVerification }),
    verificationEvidence: previousVerification?.evidence ?? [],
  };
}

/**
 * Validate a retry against the current database snapshot and persist only the
 * auditable boundary transition. The new Attempt is created by OrchestratorEngine
 * after it acquires the run lease, so this function can never create a duplicate
 * Worker by itself.
 */
export function beginTaskRetry(
  repository: OrchestratorRepository,
  options: BeginTaskRetryOptions,
): RetryTaskPlan {
  const goal = repository.getGoal(options.goalId);
  if (!['PAUSED', 'NEEDS_HUMAN'].includes(goal.status)) {
    throw new RetryNotAllowedError(
      `Goal ${goal.id} must be PAUSED or NEEDS_HUMAN before an explicit retry.`,
    );
  }
  const task = repository.getTask(options.taskId);
  const attempts = repository.listAttempts(task.id);
  const verifications = repository.listVerificationRuns(task.id);
  const plan = planTaskRetry({ goal, task, attempts, verifications });
  if (
    (goal.status === 'NEEDS_HUMAN' || task.status === 'NEEDS_HUMAN') &&
    options.confirmExternalProcessStopped !== true
  ) {
    throw new RetryNotAllowedError(
      `Retrying ${task.id} requires confirmation that the external Provider process is stopped.`,
    );
  }
  if (task.status === 'REPAIRING' || task.status === 'NEEDS_HUMAN') {
    repository.transitionTask(task.id, 'RUNNING', options.now ?? Date.now());
  }
  repository.appendEvent({
    id: `${task.id}:retry:requested:${randomUUID()}`,
    goalId: goal.id,
    taskId: task.id,
    ...(plan.previousAttempt === undefined ? {} : { attemptId: plan.previousAttempt.id }),
    type: 'task.retry.requested',
    payload: {
      attemptNumber: plan.attemptNumber,
      reasonCode: plan.reasonCode,
      reason: options.reason ?? plan.reason,
      repairObjective: plan.repairObjective,
      previousVerification: plan.previousVerification?.status,
      verificationEvidence: plan.verificationEvidence,
    },
    confidence: 1,
    timestamp: options.now ?? Date.now(),
  });
  return plan;
}

function retryReasonCode(
  attempt: StoredAttempt | undefined,
  verification: StoredVerificationRun | undefined,
): RetryReasonCode | undefined {
  if (verification?.status === 'FAIL') return 'verification_failed';
  if (verification?.status === 'UNCERTAIN') return 'verification_uncertain';
  if (attempt?.status === 'FAILED') return 'attempt_failed';
  if (attempt?.status === 'INTERRUPTED') return 'attempt_interrupted';
  if (attempt?.status === 'NEEDS_HUMAN') return 'attempt_needs_human';
  return undefined;
}

function retryReason(
  reasonCode: RetryReasonCode,
  attempt: StoredAttempt | undefined,
  verification: StoredVerificationRun | undefined,
): string {
  if (reasonCode === 'verification_failed') {
    return `Verification failed${verification?.reason === undefined ? '' : `: ${verification.reason}`}`;
  }
  if (reasonCode === 'verification_uncertain') {
    return `Verification is uncertain${verification?.reason === undefined ? '' : `: ${verification.reason}`}`;
  }
  if (reasonCode === 'attempt_failed') return `Attempt ${attempt?.attemptNumber ?? '?'} failed.`;
  if (reasonCode === 'attempt_interrupted') {
    return `Attempt ${attempt?.attemptNumber ?? '?'} was interrupted.`;
  }
  return `Attempt ${attempt?.attemptNumber ?? '?'} requires human recovery.`;
}

function buildRepairObjective(
  task: StoredTask,
  reason: string,
  verification: StoredVerificationRun | undefined,
): string {
  return [
    task.objective,
    '',
    'Repair objective:',
    reason,
    ...(verification?.evidence.length === 0 || verification === undefined
      ? []
      : [
          'Use the previous verification evidence as diagnostic context; do not treat it as new proof.',
        ]),
  ].join('\n');
}
