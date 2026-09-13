import type {
  JsonObject,
  StoredGoal,
  StoredTask,
  StoredVerificationRun,
} from '@agentscope/storage';

import type { ExecutionMemory, ProjectState, WorkingSet } from './index.js';
import type { PlannerTaskDraft, RollingPlan } from './planner.js';

export interface PlannerAuditInput {
  readonly schemaVersion: 1;
  readonly goal: {
    readonly id: string;
    readonly status: StoredGoal['status'];
    readonly activeRevision: number;
    readonly taskCount: number;
  };
  readonly tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly objective: string;
    readonly status: StoredTask['status'];
    readonly sequence: number;
    readonly tentative: boolean;
  }[];
  readonly evidence: JsonObject;
  readonly projectState: JsonObject;
  readonly executionMemory: JsonObject;
  readonly workingSet: JsonObject;
}

export interface PlannerChangeDiff {
  readonly kind: 'none' | 'add' | 'retain' | 'change-proposal';
  readonly taskId?: string;
  readonly changedFields?: readonly string[];
}

export interface PlannerAuditOutput {
  readonly schemaVersion: 1;
  readonly action: RollingPlan['action'];
  readonly rationale: string;
  readonly confidence: number;
  readonly changeDiff: PlannerChangeDiff;
  readonly nextTaskId?: string;
}

export function buildPlannerAuditInput(input: {
  readonly goal: StoredGoal;
  readonly tasks: readonly StoredTask[];
  readonly latestVerification?: StoredVerificationRun;
  readonly projectState: ProjectState;
  readonly executionMemory: ExecutionMemory;
  readonly workingSet: WorkingSet;
}): PlannerAuditInput {
  return {
    schemaVersion: 1,
    goal: {
      id: input.goal.id,
      status: input.goal.status,
      activeRevision: input.goal.activeRevision,
      taskCount: input.tasks.length,
    },
    tasks: input.tasks.map((task) => ({
      id: task.id,
      title: redactText(task.title, 300),
      objective: redactText(task.objective, 1_000),
      status: task.status,
      sequence: task.sequence,
      tentative: task.tentative,
    })),
    evidence: {
      ...(input.latestVerification === undefined
        ? { available: false }
        : {
            available: true,
            id: input.latestVerification.id,
            taskId: input.latestVerification.taskId,
            status: input.latestVerification.status,
            reason: redactText(input.latestVerification.reason, 1_000),
            evidenceCount: input.latestVerification.evidence.length,
            deterministicCheckCount: input.latestVerification.deterministicChecks.length,
          }),
    },
    projectState: {
      capturedAt: input.projectState.capturedAt,
      packageManager: input.projectState.packageManager,
      manifestCount: input.projectState.manifests.length,
      relevantFiles: input.projectState.relevantFiles,
      verificationCommandIds: input.projectState.discoverableVerification.map(
        (command) => command.id,
      ),
      recentCommitCount: input.projectState.recentCommits.length,
      git: {
        isRepository: input.projectState.git.isRepository,
        trackedFileCount: input.projectState.git.trackedFiles.length,
        diffEntryCount: input.projectState.git.diffStat.length,
      },
    },
    executionMemory: {
      goalSummaryPresent: typeof input.executionMemory.goalSummary === 'string',
      decisionCount: input.executionMemory.decisions.length,
      lockedDecisionIds: input.executionMemory.decisions
        .filter((decision) => decision.status === 'LOCKED')
        .map((decision) => decision.id),
      completedTaskCount: input.executionMemory.completedTaskIds.length,
      issueCount: input.executionMemory.issues?.length ?? 0,
      openIssueCount:
        input.executionMemory.issues?.filter((issue) => issue.status === 'OPEN').length ?? 0,
      questionCount: input.executionMemory.questions?.length ?? 0,
      openQuestionCount:
        input.executionMemory.questions?.filter((question) => question.status === 'OPEN').length ??
        0,
      failedApproachCount: input.executionMemory.failedApproaches.length,
      sourceRefCount: input.executionMemory.sourceRefs?.length ?? 0,
    },
    workingSet: {
      fileCount: input.workingSet.files.length,
      directoryCount: input.workingSet.directories.length,
      files: input.workingSet.files,
      directories: input.workingSet.directories,
      appliedInstructionIds:
        input.workingSet.appliedInstructions?.map((instruction) => instruction.id) ?? [],
      evictionCount: input.workingSet.evictions?.length ?? 0,
    },
  };
}

export function buildPlannerAuditOutput(
  plan: RollingPlan,
  tasks: readonly StoredTask[],
): PlannerAuditOutput {
  const nextTask = plan.nextTask;
  const confidence = clampConfidence(plan.confidence ?? defaultConfidence(plan.action));
  return {
    schemaVersion: 1,
    action: plan.action,
    rationale: redactText(plan.rationale, 2_000),
    confidence,
    changeDiff: nextTask === undefined ? { kind: 'none' } : taskChangeDiff(nextTask, tasks),
    ...(nextTask === undefined ? {} : { nextTaskId: nextTask.id }),
  };
}

function taskChangeDiff(draft: PlannerTaskDraft, tasks: readonly StoredTask[]): PlannerChangeDiff {
  const existing = tasks.find((task) => task.id === draft.id);
  if (existing === undefined) return { kind: 'add', taskId: draft.id };
  const comparisons: readonly (readonly [string, unknown, unknown])[] = [
    ['title', existing.title, draft.title],
    ['objective', existing.objective, draft.objective],
    ['acceptanceCriteria', existing.acceptanceCriteria, draft.acceptanceCriteria],
    ['verification', existing.verification, draft.verification],
    ['constraints', existing.constraints, draft.constraints],
    ['maxAttempts', existing.maxAttempts, draft.maxAttempts],
    ['sequence', existing.sequence, draft.sequence],
    ['tentative', existing.tentative, draft.tentative],
    ['parentTaskId', existing.parentTaskId, draft.parentTaskId],
  ];
  const changedFields = comparisons
    .filter(([, left, right]) => JSON.stringify(left) !== JSON.stringify(right))
    .map(([field]) => field);
  return {
    kind: changedFields.length === 0 ? 'retain' : 'change-proposal',
    taskId: draft.id,
    ...(changedFields.length === 0 ? {} : { changedFields }),
  };
}

function defaultConfidence(action: RollingPlan['action']): number {
  switch (action) {
    case 'NEEDS_HUMAN':
    case 'INSPECT':
      return 1;
    case 'GOAL_READY_FOR_FINAL_VERIFICATION':
      return 0.95;
    case 'NEXT_TASK':
    case 'REPLAN':
      return 0.9;
  }
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function redactText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED_SECRET]')
    .replace(
      /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(["']?)[^\s,"']+/giu,
      '$1$2[REDACTED_SECRET]',
    )
    .trim();
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 3)}...`;
}
