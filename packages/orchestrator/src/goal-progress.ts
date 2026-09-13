import type { StoredGoal, StoredTask, StoredVerificationRun } from '@agentscope/storage';

export interface GoalProgressReason {
  readonly code: string;
  readonly message: string;
}

export interface GoalProgressValue {
  readonly value: number;
  readonly confidence: number;
  readonly reasons: readonly GoalProgressReason[];
}

export interface GoalProgressSnapshot extends GoalProgressValue {
  readonly goalId: string;
  readonly taskCount: number;
  readonly completedTaskCount: number;
  readonly remainingTaskCount: number;
  readonly skippedTaskCount: number;
  readonly verificationStatus: 'pending' | 'pass' | 'fail' | 'uncertain' | 'unknown';
}

export interface GoalProgressInput {
  readonly goal: Pick<StoredGoal, 'id' | 'status'>;
  readonly tasks: readonly StoredTask[];
  readonly verifications?: readonly StoredVerificationRun[];
}

/**
 * Project a conservative Goal-level progress value from durable lifecycle evidence.
 *
 * A completed Task contributes fully to the weighted total, but the Goal remains
 * below 100% until its final verification has promoted the Goal itself. Unknown
 * evidence lowers confidence rather than being turned into invented precision.
 */
export function projectGoalProgress(input: GoalProgressInput): GoalProgressSnapshot {
  const verifications = input.verifications ?? [];
  const latestVerificationByTask = latestVerifications(verifications);
  const taskCount = input.tasks.length;
  const completedTaskCount = input.tasks.filter((task) => task.status === 'COMPLETED').length;
  const skippedTaskCount = input.tasks.filter((task) => task.status === 'SKIPPED').length;
  const remainingTaskCount = input.tasks.filter(
    (task) => task.status !== 'COMPLETED' && task.status !== 'SKIPPED',
  ).length;
  const reasons: GoalProgressReason[] = [];

  if (taskCount === 0) {
    return {
      goalId: input.goal.id,
      taskCount: 0,
      completedTaskCount: 0,
      remainingTaskCount: 0,
      skippedTaskCount: 0,
      verificationStatus: 'unknown',
      value: input.goal.status === 'COMPLETED' ? 1 : 0,
      confidence: input.goal.status === 'COMPLETED' ? 1 : 0,
      reasons: [
        {
          code: 'no_tasks',
          message: 'No Task evidence is available for this Goal yet.',
        },
        ...(input.goal.status === 'COMPLETED'
          ? []
          : [
              {
                code: 'goal_not_verified',
                message:
                  'The Goal cannot be considered complete without Task and verification evidence.',
              },
            ]),
      ],
    };
  }

  let totalWeight = 0;
  let weightedValue = 0;
  let confidenceTotal = 0;
  let activeTask: StoredTask | undefined;
  for (const task of input.tasks) {
    const weight = task.tentative ? 0.8 : 1;
    totalWeight += weight;
    const verification = latestVerificationByTask.get(task.id);
    const projection = taskContribution(task, verification);
    weightedValue += projection.value * weight;
    confidenceTotal += projection.confidence * weight;
    if (
      activeTask === undefined &&
      ['RUNNING', 'VERIFYING', 'REPAIRING', 'NEEDS_HUMAN'].includes(task.status)
    ) {
      activeTask = task;
    }
    reasons.push(...projection.reasons);
  }

  const baseValue = clamp(weightedValue / totalWeight);
  const baseConfidence = clamp(confidenceTotal / totalWeight);
  const finalVerification = findFinalVerification(input.goal.id, verifications);
  const verificationStatus = finalVerification?.status.toLowerCase() as
    GoalProgressSnapshot['verificationStatus'] | undefined;
  const normalizedVerificationStatus =
    verificationStatus === 'pass' ||
    verificationStatus === 'fail' ||
    verificationStatus === 'uncertain'
      ? verificationStatus
      : finalVerification === undefined
        ? 'pending'
        : 'unknown';

  if (completedTaskCount > 0) {
    reasons.push({
      code: 'tasks_completed',
      message: `${completedTaskCount} of ${taskCount} Task(s) have reached a completed lifecycle state.`,
    });
  }
  if (remainingTaskCount > 0) {
    reasons.push({
      code: 'tasks_remaining',
      message: `${remainingTaskCount} Task(s) still require execution or verification.`,
    });
  }
  if (skippedTaskCount > 0) {
    reasons.push({
      code: 'tasks_skipped',
      message: `${skippedTaskCount} Task(s) were skipped and still require Goal-level confirmation.`,
    });
  }
  if (activeTask !== undefined) {
    reasons.push({
      code: `active_task_${activeTask.status.toLowerCase()}`,
      message: `Task ${activeTask.id} is currently ${activeTask.status.toLowerCase()}; progress remains evidence-bounded.`,
    });
  }

  let value = baseValue;
  let confidence = baseConfidence;
  if (input.goal.status === 'COMPLETED') {
    if (normalizedVerificationStatus === 'pass') {
      value = 1;
      confidence = 1;
      reasons.push({
        code: 'goal_final_verification_passed',
        message: 'The Goal reached completed status after a passing final verification.',
      });
    } else {
      value = Math.min(value, 0.95);
      confidence = Math.min(confidence, 0.5);
      reasons.push({
        code: 'goal_completion_evidence_missing',
        message: 'The Goal is marked completed but no passing final verification is available.',
      });
    }
  } else {
    const cap = progressCap(input.goal.status, normalizedVerificationStatus);
    if (value > cap) {
      value = cap;
      reasons.push({
        code: 'goal_completion_gate',
        message: `Goal progress is capped at ${Math.round(cap * 100)}% until the current lifecycle gate is satisfied.`,
      });
    }
    if (normalizedVerificationStatus === 'pending') {
      confidence = Math.min(confidence, 0.75);
      reasons.push({
        code: 'final_verification_pending',
        message: 'Final Goal verification has not been recorded yet.',
      });
    } else if (normalizedVerificationStatus === 'fail') {
      confidence = Math.min(confidence, 0.6);
      reasons.push({
        code: 'final_verification_failed',
        message: 'Final verification failed; any resulting gap Task must be addressed.',
      });
    } else if (normalizedVerificationStatus === 'uncertain') {
      confidence = Math.min(confidence, 0.5);
      reasons.push({
        code: 'final_verification_uncertain',
        message: 'Final verification is uncertain and cannot promote the Goal to complete.',
      });
    }
  }

  return {
    goalId: input.goal.id,
    taskCount,
    completedTaskCount,
    remainingTaskCount,
    skippedTaskCount,
    verificationStatus: normalizedVerificationStatus,
    value: clamp(value),
    confidence: clamp(confidence),
    reasons: dedupeReasons(reasons),
  };
}

interface TaskContribution {
  readonly value: number;
  readonly confidence: number;
  readonly reasons: readonly GoalProgressReason[];
}

function taskContribution(
  task: StoredTask,
  verification: StoredVerificationRun | undefined,
): TaskContribution {
  const verificationReason = verificationReasonFor(verification);
  switch (task.status) {
    case 'COMPLETED':
      return {
        value: 1,
        confidence: verification?.status === 'PASS' ? 1 : 0.45,
        reasons: [
          {
            code: `task_${task.id}_completed`,
            message:
              verification?.status === 'PASS'
                ? `Task ${task.id} completed with a passing verification.`
                : `Task ${task.id} is completed, but its passing verification evidence is incomplete.`,
          },
          ...(verificationReason === undefined ? [] : [verificationReason]),
        ],
      };
    case 'SKIPPED':
      return {
        value: 0.5,
        confidence: 0.35,
        reasons: [
          {
            code: `task_${task.id}_skipped`,
            message: `Task ${task.id} was skipped; it contributes partial progress pending Goal confirmation.`,
          },
        ],
      };
    case 'VERIFYING':
      return {
        value: 0.65,
        confidence: verification?.status === 'PASS' ? 0.8 : 0.55,
        reasons: [
          {
            code: `task_${task.id}_verifying`,
            message: `Task ${task.id} is in verification; completion is not promoted yet.`,
          },
        ],
      };
    case 'REPAIRING':
      return {
        value: 0.45,
        confidence: 0.5,
        reasons: [
          {
            code: `task_${task.id}_repairing`,
            message: `Task ${task.id} is being repaired after verification evidence identified a gap.`,
          },
        ],
      };
    case 'RUNNING':
      return {
        value: 0.35,
        confidence: 0.35,
        reasons: [
          {
            code: `task_${task.id}_running`,
            message: `Task ${task.id} is running; progress uses a conservative lifecycle phase estimate.`,
          },
        ],
      };
    case 'NEEDS_HUMAN':
      return {
        value: 0.3,
        confidence: 0.3,
        reasons: [
          {
            code: `task_${task.id}_needs_human`,
            message: `Task ${task.id} needs human input before it can advance safely.`,
          },
        ],
      };
    case 'FAILED':
      return {
        value: 0.2,
        confidence: 0.25,
        reasons: [
          {
            code: `task_${task.id}_failed`,
            message: `Task ${task.id} failed; recorded evidence prevents claiming full progress.`,
          },
        ],
      };
    case 'PENDING':
      return {
        value: 0,
        confidence: 0.1,
        reasons: [],
      };
  }
}

function latestVerifications(
  verifications: readonly StoredVerificationRun[],
): ReadonlyMap<string, StoredVerificationRun> {
  const latest = new Map<string, StoredVerificationRun>();
  for (const verification of verifications) {
    const existing = latest.get(verification.taskId);
    if (
      existing === undefined ||
      verification.createdAt > existing.createdAt ||
      (verification.createdAt === existing.createdAt && verification.id > existing.id)
    ) {
      latest.set(verification.taskId, verification);
    }
  }
  return latest;
}

function findFinalVerification(
  goalId: string,
  verifications: readonly StoredVerificationRun[],
): StoredVerificationRun | undefined {
  return [...verifications]
    .filter((verification) => verification.id.startsWith(`${goalId}:final-verification:`))
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

function verificationReason(verification: StoredVerificationRun): GoalProgressReason {
  return {
    code: `verification_${verification.status.toLowerCase()}`,
    message: `Latest verification evidence is ${verification.status.toLowerCase()}.`,
  };
}

function verificationReasonFor(
  verification: StoredVerificationRun | undefined,
): GoalProgressReason | undefined {
  if (verification === undefined) return undefined;
  return verificationReason(verification);
}

function progressCap(
  status: StoredGoal['status'],
  verificationStatus: GoalProgressSnapshot['verificationStatus'],
): number {
  if (verificationStatus === 'pass' && status === 'VERIFYING') return 0.98;
  switch (status) {
    case 'CREATED':
      return 0.1;
    case 'PLANNING':
      return 0.25;
    case 'RUNNING':
      return 0.9;
    case 'VERIFYING':
      return 0.95;
    case 'PAUSED':
    case 'NEEDS_HUMAN':
      return 0.85;
    case 'FAILED':
    case 'ABORTED':
      return 0.9;
    case 'COMPLETED':
      return 1;
  }
}

function dedupeReasons(reasons: readonly GoalProgressReason[]): readonly GoalProgressReason[] {
  return [...new Map(reasons.map((reason) => [reason.code, reason])).values()];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
