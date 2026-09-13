import { createHash } from 'node:crypto';

import type { JsonObject, StoredGoal, StoredOrchestratorEvent } from '@agentscope/storage';

export type OrchestratorNotificationKind =
  | 'needs-human'
  | 'approval'
  | 'budget-warning'
  | 'budget-exceeded'
  | 'completed'
  | 'failed'
  | 'recovery-failed';

export interface OrchestratorNotificationCandidate {
  readonly goalId: string;
  readonly eventKey: string;
  readonly kind: OrchestratorNotificationKind;
  readonly payload: JsonObject;
}

/**
 * Map only actionable lifecycle evidence to notifications. Progress and
 * metric events intentionally return undefined: they are useful in the UI,
 * but should not interrupt a user with a browser notification.
 */
export function notificationForOrchestratorEvent(
  event: Pick<StoredOrchestratorEvent, 'id' | 'goalId' | 'taskId' | 'type' | 'payload'>,
): OrchestratorNotificationCandidate | undefined {
  const taskSuffix = event.taskId === undefined ? 'goal' : event.taskId;
  switch (event.type) {
    case 'goal.needs_human': {
      const reason = stringField(event.payload, 'reason') ?? 'The Goal requires human attention.';
      return {
        goalId: event.goalId,
        eventKey: `needs-human:${taskSuffix}:${stableKey(reason)}`,
        kind: 'needs-human',
        payload: {
          reason,
          ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
        },
      };
    }
    case 'goal.approval.requested':
    case 'goal.approval.waiting': {
      const approvalId = stringField(event.payload, 'approvalId') ?? event.id;
      return {
        goalId: event.goalId,
        eventKey: `approval:${approvalId}:${event.type.endsWith('requested') ? 'requested' : 'waiting'}`,
        kind: 'approval',
        payload: {
          approvalId,
          ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
          ...(stringField(event.payload, 'riskLevel') === undefined
            ? {}
            : { riskLevel: stringField(event.payload, 'riskLevel') }),
        },
      };
    }
    case 'goal.budget.warning':
    case 'goal.budget.exceeded': {
      const key = stringField(event.payload, 'key') ?? event.id;
      const exceeded = event.type === 'goal.budget.exceeded';
      return {
        goalId: event.goalId,
        eventKey: `budget:${exceeded ? 'exceeded' : 'warning'}:${stableKey(key)}`,
        kind: exceeded ? 'budget-exceeded' : 'budget-warning',
        payload: {
          key,
          ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
          ...(stringField(event.payload, 'metric') === undefined
            ? {}
            : { metric: stringField(event.payload, 'metric') }),
          ...(numberField(event.payload, 'observed') === undefined
            ? {}
            : { observed: numberField(event.payload, 'observed') }),
          ...(numberField(event.payload, 'limit') === undefined
            ? {}
            : { limit: numberField(event.payload, 'limit') }),
        },
      };
    }
    case 'goal.run_failed':
    case 'goal.recovery.failed': {
      const reason = stringField(event.payload, 'reason') ?? 'Goal recovery failed.';
      return {
        goalId: event.goalId,
        eventKey: `recovery-failed:${stableKey(reason)}`,
        kind: 'recovery-failed',
        payload: { reason },
      };
    }
    default:
      return undefined;
  }
}

export function notificationForGoalStatus(
  goal: Pick<StoredGoal, 'id' | 'status'>,
): OrchestratorNotificationCandidate | undefined {
  if (goal.status !== 'COMPLETED' && goal.status !== 'FAILED') return undefined;
  const completed = goal.status === 'COMPLETED';
  return {
    goalId: goal.id,
    eventKey: `goal-status:${goal.status.toLowerCase()}`,
    kind: completed ? 'completed' : 'failed',
    payload: { status: goal.status },
  };
}

function stringField(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(payload: JsonObject, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stableKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}
