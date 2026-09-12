import type { RoadmapItem, StoredGoal, StoredTask } from '@agentscope/storage';

import type { PlannerTaskDraft } from './planner.js';

export type PlannerRoadmapMergeDecision = 'ACCEPT' | 'PRESERVE_USER' | 'NEEDS_HUMAN';

export interface PlannerRoadmapMergeResult {
  readonly decision: PlannerRoadmapMergeDecision;
  readonly reason: string;
}

/**
 * Apply the conservative planner merge policy at the boundary before a draft
 * can be persisted.  A planner never rewrites an existing Task Contract: user
 * edits remain authoritative, and completed/locked work is immutable.
 */
export function evaluatePlannerTaskMerge(input: {
  readonly goal: StoredGoal;
  readonly tasks: readonly StoredTask[];
  readonly draft: PlannerTaskDraft;
}): PlannerRoadmapMergeResult {
  const existing = input.tasks.find((task) => task.id === input.draft.id);
  if (existing !== undefined) {
    if (sameTaskContract(existing, input.draft)) {
      return {
        decision: 'PRESERVE_USER',
        reason: `Planner proposal for Task ${existing.id} matches the persisted Contract; no rewrite is needed.`,
      };
    }
    if (existing.status !== 'PENDING' || existing.startedAt !== undefined) {
      return {
        decision: 'NEEDS_HUMAN',
        reason: `Planner proposed a change to historical or active Task ${existing.id}; the Contract is immutable.`,
      };
    }
    const roadmapItem = input.goal.roadmap.find((item) => item.id === existing.id);
    if (roadmapItem?.status === 'LOCKED' || existing.tentative === false) {
      return {
        decision: 'NEEDS_HUMAN',
        reason: `Planner proposed a change to LOCKED Task ${existing.id}; preserve the user boundary.`,
      };
    }
    return {
      decision: 'PRESERVE_USER',
      reason: `Planner proposal for tentative Task ${existing.id} was ignored so the existing Contract remains authoritative.`,
    };
  }

  const immutableBoundary = Math.max(
    0,
    ...input.tasks
      .filter((task) => isImmutableTask(input.goal.roadmap, task))
      .map((task) => task.sequence),
  );
  if (!Number.isInteger(input.draft.sequence) || input.draft.sequence <= immutableBoundary) {
    return {
      decision: 'NEEDS_HUMAN',
      reason: `Planner proposed Task ${input.draft.id} inside the immutable execution boundary.`,
    };
  }
  const sequenceOwner = input.tasks.find((task) => task.sequence === input.draft.sequence);
  if (sequenceOwner !== undefined) {
    return {
      decision: 'NEEDS_HUMAN',
      reason: `Planner proposed Task ${input.draft.id} with sequence ${input.draft.sequence}, already owned by ${sequenceOwner.id}.`,
    };
  }
  return {
    decision: 'ACCEPT',
    reason: `Planner proposed a new Task ${input.draft.id} outside the immutable execution boundary.`,
  };
}

function sameTaskContract(task: StoredTask, draft: PlannerTaskDraft): boolean {
  return (
    task.title === draft.title &&
    task.objective === draft.objective &&
    JSON.stringify(task.acceptanceCriteria) === JSON.stringify(draft.acceptanceCriteria) &&
    JSON.stringify(task.verification) === JSON.stringify(draft.verification) &&
    JSON.stringify(task.constraints) === JSON.stringify(draft.constraints) &&
    task.maxAttempts === draft.maxAttempts &&
    task.sequence === draft.sequence &&
    task.tentative === draft.tentative &&
    task.parentTaskId === draft.parentTaskId
  );
}

function isImmutableTask(roadmap: readonly RoadmapItem[], task: StoredTask): boolean {
  return (
    task.status !== 'PENDING' ||
    task.startedAt !== undefined ||
    task.tentative === false ||
    roadmap.find((item) => item.id === task.id)?.status === 'LOCKED'
  );
}
