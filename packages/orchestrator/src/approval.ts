import { createHash } from 'node:crypto';

import type {
  JsonObject,
  StoredApprovalRequest,
  StoredGoal,
  StoredTask,
} from '@agentscope/storage';

import type { RiskAssessment } from './risk.js';

export const TASK_APPROVAL_ACTION = 'execute-task';

export interface TaskApprovalScope {
  readonly goalId: string;
  readonly taskId: string;
  readonly activeRevision: number;
  readonly contractHash: string;
  readonly categories: readonly string[];
}

export function buildTaskApprovalScope(
  goal: Pick<StoredGoal, 'id' | 'activeRevision'>,
  task: Pick<
    StoredTask,
    | 'id'
    | 'title'
    | 'objective'
    | 'acceptanceCriteria'
    | 'verification'
    | 'constraints'
    | 'maxAttempts'
    | 'sequence'
    | 'tentative'
    | 'parentTaskId'
  >,
  assessment: RiskAssessment,
): TaskApprovalScope {
  const contract = {
    title: task.title,
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    verification: task.verification,
    constraints: task.constraints,
    maxAttempts: task.maxAttempts,
    sequence: task.sequence,
    tentative: task.tentative,
    ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
  };
  const contractHash = createHash('sha256').update(stableJson(contract)).digest('hex');
  return {
    goalId: goal.id,
    taskId: task.id,
    activeRevision: goal.activeRevision,
    contractHash,
    categories: assessment.categories,
  };
}

export function approvalScopeJson(scope: TaskApprovalScope): JsonObject {
  return {
    goalId: scope.goalId,
    taskId: scope.taskId,
    activeRevision: scope.activeRevision,
    contractHash: scope.contractHash,
    categories: scope.categories,
  };
}

export function findMatchingTaskApproval(
  approvals: readonly StoredApprovalRequest[],
  scope: TaskApprovalScope,
): StoredApprovalRequest | undefined {
  const expected = stableJson(approvalScopeJson(scope));
  return [...approvals]
    .filter(
      (approval) =>
        approval.action === TASK_APPROVAL_ACTION && stableJson(approval.scope) === expected,
    )
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`;
}
