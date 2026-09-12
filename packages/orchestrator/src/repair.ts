import type { StoredTask, StoredVerificationRun } from '@agentscope/storage';

export type RepairAction = 'RETRY' | 'NEEDS_HUMAN' | 'COMPLETE';

export interface RepairDecision {
  readonly action: RepairAction;
  readonly attemptNumber: number;
  readonly reason: string;
}

/** Decide the next bounded action without mutating persistence. */
export function decideRepair(
  task: StoredTask,
  completedAttemptCount: number,
  verification: Pick<StoredVerificationRun, 'status' | 'reason'>,
): RepairDecision {
  if (!Number.isInteger(completedAttemptCount) || completedAttemptCount < 0) {
    throw new RangeError('completedAttemptCount must be a non-negative integer.');
  }
  if (verification.status === 'PASS') {
    return {
      action: 'COMPLETE',
      attemptNumber: completedAttemptCount,
      reason: 'Independent verification passed.',
    };
  }
  if (verification.status === 'UNCERTAIN') {
    return {
      action: 'NEEDS_HUMAN',
      attemptNumber: completedAttemptCount,
      reason: `Verification is uncertain: ${verification.reason}`,
    };
  }
  if (completedAttemptCount < task.maxAttempts) {
    return {
      action: 'RETRY',
      attemptNumber: completedAttemptCount + 1,
      reason: `Verification failed; bounded repair attempt ${completedAttemptCount + 1} of ${task.maxAttempts} is allowed.`,
    };
  }
  return {
    action: 'NEEDS_HUMAN',
    attemptNumber: completedAttemptCount,
    reason: `Verification failed after the maximum of ${task.maxAttempts} attempts.`,
  };
}
