import type { StoredTask, StoredVerificationRun } from '@agentscope/storage';

import type { GoalProgressReason, GoalProgressValue } from './goal-progress.js';

export type TaskProgressPhase =
  | 'pending'
  | 'working'
  | 'verifying'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'needs-human'
  | 'skipped';

export interface TaskProgressSnapshot extends GoalProgressValue {
  readonly taskId: string;
  readonly status: StoredTask['status'];
  readonly phase: TaskProgressPhase;
  readonly verificationStatus: StoredVerificationRun['status'] | 'pending' | 'unknown';
  readonly evidenceCount: number;
}

export interface TaskProgressInput {
  readonly task: Pick<StoredTask, 'id' | 'status'>;
  readonly verifications?: readonly StoredVerificationRun[];
  /** Number of structured provider/observer signals associated with this Task. */
  readonly evidenceCount?: number;
}

/** Project a Task's lifecycle and verification evidence without claiming provider internals. */
export function projectTaskProgress(input: TaskProgressInput): TaskProgressSnapshot {
  const verifications = input.verifications ?? [];
  const latestVerification = [...verifications].sort(
    (left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id),
  )[0];
  const evidenceCount = Math.max(0, Math.floor(input.evidenceCount ?? 0));
  const verificationStatus = latestVerification?.status ?? 'pending';
  const phase = phaseForStatus(input.task.status);
  const reasons: GoalProgressReason[] = [];

  if (evidenceCount === 0) {
    reasons.push({
      code: 'task_evidence_sparse',
      message: 'No structured provider or observer evidence is available for this Task.',
    });
  } else {
    reasons.push({
      code: 'task_evidence_observed',
      message: `${evidenceCount} structured evidence signal(s) are associated with this Task.`,
    });
  }

  switch (input.task.status) {
    case 'PENDING':
      return result(input, phase, verificationStatus, evidenceCount, 0, 0.1, [
        ...reasons,
        { code: 'task_pending', message: 'Task is queued and has not started.' },
      ]);
    case 'RUNNING':
      return result(
        input,
        phase,
        verificationStatus,
        evidenceCount,
        0.35,
        confidenceForActive(evidenceCount),
        [
          ...reasons,
          {
            code: 'task_working',
            message: 'Task is running; detailed progress is provider-dependent.',
          },
        ],
      );
    case 'VERIFYING':
      return result(
        input,
        phase,
        verificationStatus,
        evidenceCount,
        0.65,
        confidenceForVerifying(latestVerification, evidenceCount),
        [
          ...reasons,
          {
            code: 'task_verifying',
            message:
              'Task execution is complete enough to verify, but completion is not promoted yet.',
          },
        ],
      );
    case 'REPAIRING':
      return result(
        input,
        phase,
        verificationStatus,
        evidenceCount,
        0.45,
        confidenceForActive(evidenceCount),
        [
          ...reasons,
          { code: 'task_repairing', message: 'Task is being repaired after a verification gap.' },
        ],
      );
    case 'COMPLETED':
      return result(
        input,
        phase,
        verificationStatus,
        evidenceCount,
        1,
        confidenceForCompleted(latestVerification),
        [
          ...reasons,
          {
            code: 'task_completed',
            message:
              latestVerification?.status === 'PASS'
                ? 'Task completed with a passing verification.'
                : 'Task completed, but a passing verification record is not available.',
          },
        ],
      );
    case 'FAILED':
      return result(input, phase, verificationStatus, evidenceCount, 0.2, 0.25, [
        ...reasons,
        {
          code: 'task_failed',
          message: 'Task failed; progress is bounded by the recorded failure.',
        },
      ]);
    case 'NEEDS_HUMAN':
      return result(input, phase, verificationStatus, evidenceCount, 0.3, 0.3, [
        ...reasons,
        {
          code: 'task_needs_human',
          message: 'Task is waiting for human input before safe continuation.',
        },
      ]);
    case 'SKIPPED':
      return result(input, phase, verificationStatus, evidenceCount, 0.5, 0.35, [
        ...reasons,
        {
          code: 'task_skipped',
          message: 'Task was skipped and contributes partial progress until the Goal is confirmed.',
        },
      ]);
  }
}

function result(
  input: TaskProgressInput,
  phase: TaskProgressPhase,
  verificationStatus: TaskProgressSnapshot['verificationStatus'],
  evidenceCount: number,
  value: number,
  confidence: number,
  reasons: readonly GoalProgressReason[],
): TaskProgressSnapshot {
  return {
    taskId: input.task.id,
    status: input.task.status,
    phase,
    verificationStatus,
    evidenceCount,
    value: clamp(value),
    confidence: clamp(confidence),
    reasons: dedupeReasons(reasons),
  };
}

function phaseForStatus(status: StoredTask['status']): TaskProgressPhase {
  switch (status) {
    case 'PENDING':
      return 'pending';
    case 'RUNNING':
      return 'working';
    case 'VERIFYING':
      return 'verifying';
    case 'REPAIRING':
      return 'repairing';
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'NEEDS_HUMAN':
      return 'needs-human';
    case 'SKIPPED':
      return 'skipped';
  }
}

function confidenceForActive(evidenceCount: number): number {
  return evidenceCount === 0 ? 0.25 : Math.min(0.65, 0.3 + evidenceCount / 20);
}

function confidenceForVerifying(
  verification: StoredVerificationRun | undefined,
  evidenceCount: number,
): number {
  if (verification?.status === 'PASS') return 0.8;
  if (verification?.status === 'FAIL') return 0.6;
  return evidenceCount === 0 ? 0.35 : 0.5;
}

function confidenceForCompleted(verification: StoredVerificationRun | undefined): number {
  return verification?.status === 'PASS' ? 1 : 0.45;
}

function dedupeReasons(reasons: readonly GoalProgressReason[]): readonly GoalProgressReason[] {
  return [...new Map(reasons.map((reason) => [reason.code, reason])).values()];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
