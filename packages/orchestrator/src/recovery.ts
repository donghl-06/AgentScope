import type {
  OrchestratorRepository,
  StoredAttempt,
  StoredGoal,
  StoredGoalRunLease,
  StoredTask,
} from '@agentscope/storage';

export const RECOVERY_CLASSIFICATIONS = [
  'SAFE_TO_RESUME',
  'STILL_RUNNING',
  'RETRYABLE',
  'NEEDS_HUMAN',
  'TERMINAL',
] as const;
export type RecoveryClassification = (typeof RECOVERY_CLASSIFICATIONS)[number];

export type RecoveryProcessStatus = 'running' | 'stopped' | 'unknown';
export type RecoverySessionStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unknown';

export interface RecoveryEvidence {
  readonly now: number;
  readonly providerProcess: RecoveryProcessStatus;
  readonly sessionStatus: RecoverySessionStatus;
  readonly lease?: Pick<StoredGoalRunLease, 'ownerId' | 'expiresAt'>;
}

export interface RecoveryInput {
  readonly goal: StoredGoal;
  readonly tasks: readonly StoredTask[];
  readonly attempts: readonly StoredAttempt[];
  readonly evidence: RecoveryEvidence;
}

export interface RecoveryDecision {
  readonly classification: RecoveryClassification;
  readonly reasonCode:
    | 'goal_terminal'
    | 'lease_active'
    | 'provider_running'
    | 'session_running'
    | 'attempt_failed_retryable'
    | 'state_complete_boundary'
    | 'state_unknown';
  readonly reason: string;
  readonly taskId?: string;
  readonly attemptId?: string;
}

export interface OrchestratorRecoveryReport {
  readonly goalsInspected: number;
  readonly goalsPaused: number;
  readonly tasksPaused: number;
  readonly attemptsPaused: number;
}

export function classifyGoalRecovery(input: RecoveryInput): RecoveryDecision {
  if (['COMPLETED', 'FAILED', 'ABORTED'].includes(input.goal.status)) {
    return {
      classification: 'TERMINAL',
      reasonCode: 'goal_terminal',
      reason: `Goal is already terminal (${input.goal.status}).`,
    };
  }
  if (input.evidence.lease !== undefined && input.evidence.lease.expiresAt > input.evidence.now) {
    return {
      classification: 'STILL_RUNNING',
      reasonCode: 'lease_active',
      reason: `An active run lease is held by ${input.evidence.lease.ownerId}.`,
    };
  }

  const activeTask = input.tasks.find((task) =>
    ['RUNNING', 'VERIFYING', 'REPAIRING'].includes(task.status),
  );
  const resumableTask =
    activeTask ?? input.tasks.find((task) => task.status === 'NEEDS_HUMAN');
  const activeAttempt = input.attempts.find((attempt) =>
    ['CREATED', 'RUNNING'].includes(attempt.status),
  );
  if (activeAttempt !== undefined) {
    if (input.evidence.providerProcess === 'running') {
      return {
        classification: 'STILL_RUNNING',
        reasonCode: 'provider_running',
        reason: 'The Provider process is confirmed to be running.',
        ...(activeTask === undefined ? {} : { taskId: activeTask.id }),
        attemptId: activeAttempt.id,
      };
    }
    if (input.evidence.sessionStatus === 'starting' || input.evidence.sessionStatus === 'running') {
      return {
        classification: 'STILL_RUNNING',
        reasonCode: 'session_running',
        reason: 'The linked AgentScope Session is still active.',
        ...(activeTask === undefined ? {} : { taskId: activeTask.id }),
        attemptId: activeAttempt.id,
      };
    }
    return {
      classification: 'NEEDS_HUMAN',
      reasonCode: 'state_unknown',
      reason: 'An active Attempt exists, but its external process state is not proven stopped.',
      ...(activeTask === undefined ? {} : { taskId: activeTask.id }),
      attemptId: activeAttempt.id,
    };
  }

  const latestFailedAttempt = [...input.attempts]
    .filter((attempt) => ['FAILED', 'INTERRUPTED'].includes(attempt.status))
    .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
  if (
    latestFailedAttempt !== undefined &&
    activeTask !== undefined &&
    latestFailedAttempt.attemptNumber < activeTask.maxAttempts
  ) {
    return {
      classification: 'RETRYABLE',
      reasonCode: 'attempt_failed_retryable',
      reason: `Attempt ${latestFailedAttempt.attemptNumber} failed and another bounded attempt is available.`,
      taskId: activeTask.id,
      attemptId: latestFailedAttempt.id,
    };
  }
  if (
    input.evidence.providerProcess === 'stopped' &&
    input.evidence.sessionStatus !== 'starting' &&
    input.evidence.sessionStatus !== 'running' &&
    (resumableTask !== undefined || input.goal.status === 'NEEDS_HUMAN')
  ) {
    return {
      classification: 'SAFE_TO_RESUME',
      reasonCode: 'state_complete_boundary',
      reason: 'The external process is explicitly stopped and the next persisted boundary is resumable.',
      ...(resumableTask === undefined ? {} : { taskId: resumableTask.id }),
    };
  }
  if (activeTask !== undefined || input.goal.status === 'PLANNING') {
    return {
      classification: 'SAFE_TO_RESUME',
      reasonCode: 'state_complete_boundary',
      reason: 'No active external Worker remains and the next boundary is persisted.',
      ...(activeTask === undefined ? {} : { taskId: activeTask.id }),
    };
  }
  return {
    classification: 'NEEDS_HUMAN',
    reasonCode: 'state_unknown',
    reason: 'The Goal is non-terminal but no safe continuation boundary can be proven.',
  };
}

/**
 * Conservatively fences work that was active when the host process stopped.
 *
 * A restarted process cannot prove that a provider process is still alive, so
 * it must never launch a second Worker for the same Task automatically. The
 * explicit NEEDS_HUMAN state lets a later run resume only after the operator
 * has inspected the external process and made that decision.
 */
export function recoverOrchestrator(
  repository: OrchestratorRepository,
  now = Date.now(),
): OrchestratorRecoveryReport {
  let goalsInspected = 0;
  let goalsPaused = 0;
  let tasksPaused = 0;
  let attemptsPaused = 0;

  for (const goal of repository.listGoals()) {
    if (!isRecoverableGoal(goal)) continue;
    goalsInspected += 1;
    const tasks = repository.listTasks(goal.id);
    const attempts = tasks.flatMap((task) => repository.listAttempts(task.id));
    const recoveryDecision = classifyGoalRecovery({
      goal,
      tasks,
      attempts,
      evidence: { now, providerProcess: 'unknown', sessionStatus: 'unknown' },
    });
    for (const task of tasks) {
      const attempts = repository.listAttempts(task.id);
      for (const attempt of attempts) {
        if (attempt.status !== 'RUNNING') continue;
        repository.updateAttempt(attempt.id, { status: 'NEEDS_HUMAN' }, now);
        attemptsPaused += 1;
        repository.appendEvent({
          id: `${goal.id}:recovery:${now}:attempt:${attempt.id}`,
          goalId: goal.id,
          taskId: task.id,
          attemptId: attempt.id,
          type: 'orchestrator.recovery.attempt_fenced',
          payload: { reason: 'The host restarted while the Attempt was running.' },
          confidence: 1,
          timestamp: now,
        });
      }
      if (!isRecoverableTask(task)) continue;
      repository.transitionTask(task.id, 'NEEDS_HUMAN', now);
      tasksPaused += 1;
      repository.appendEvent({
        id: `${goal.id}:recovery:${now}:task:${task.id}`,
        goalId: goal.id,
        taskId: task.id,
        type: 'orchestrator.recovery.task_fenced',
        payload: { reason: 'The host restarted before Task completion was verified.' },
        confidence: 1,
        timestamp: now,
      });
    }
    repository.transitionGoal(goal.id, 'NEEDS_HUMAN', now);
    goalsPaused += 1;
    repository.appendEvent({
      id: `${goal.id}:recovery:${now}:goal`,
      goalId: goal.id,
      type: 'orchestrator.recovery.goal_fenced',
      payload: {
        reason: 'The host restarted before Goal completion was verified.',
        recoveryClassification: recoveryDecision.classification,
        recoveryReasonCode: recoveryDecision.reasonCode,
      },
      confidence: 1,
      timestamp: now,
    });
  }

  return { goalsInspected, goalsPaused, tasksPaused, attemptsPaused };
}

function isRecoverableGoal(goal: StoredGoal): boolean {
  return goal.status === 'PLANNING' || goal.status === 'RUNNING' || goal.status === 'VERIFYING';
}

function isRecoverableTask(task: StoredTask): boolean {
  return task.status === 'RUNNING' || task.status === 'VERIFYING' || task.status === 'REPAIRING';
}
