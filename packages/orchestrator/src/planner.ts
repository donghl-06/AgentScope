import type {
  JsonObject,
  RoadmapItem,
  StoredGoal,
  StoredTask,
  StoredVerificationRun,
} from '@agentscope/storage';

import type { ExecutionMemory, ProjectState, WorkingSet } from './index.js';

export type RollingPlannerAction =
  'NEXT_TASK' | 'INSPECT' | 'REPLAN' | 'GOAL_READY_FOR_FINAL_VERIFICATION' | 'NEEDS_HUMAN';

export interface PlannerTaskDraft {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verification: JsonObject;
  readonly constraints: JsonObject;
  readonly maxAttempts: number;
  readonly sequence: number;
  readonly tentative: boolean;
  readonly parentTaskId?: string;
}

export interface InitialPlan {
  readonly goalId: string;
  readonly roadmap: readonly RoadmapItem[];
  readonly firstTask: PlannerTaskDraft;
  readonly tentativeTasks: readonly PlannerTaskDraft[];
  readonly rationale: string;
}

export interface RollingPlanInput {
  readonly goal: StoredGoal;
  readonly tasks: readonly StoredTask[];
  readonly latestVerification?: StoredVerificationRun;
  readonly projectState: ProjectState;
  readonly executionMemory: ExecutionMemory;
  readonly workingSet: WorkingSet;
}

export interface RollingPlan {
  readonly goalId: string;
  readonly action: RollingPlannerAction;
  readonly nextTask?: PlannerTaskDraft;
  readonly rationale: string;
  /** Optional provider confidence; deterministic planners use a safe default. */
  readonly confidence?: number;
}

export interface Planner {
  planInitial(input: {
    readonly goal: StoredGoal;
    readonly projectState: ProjectState;
    readonly executionMemory: ExecutionMemory;
    readonly workingSet: WorkingSet;
  }): InitialPlan;
  planRolling(input: RollingPlanInput): RollingPlan;
}

export interface ConservativePlannerOptions {
  readonly maxAttempts?: number;
  readonly tentativeTaskCount?: number;
}

/**
 * A deterministic planner for the first Orchestrator slice.
 *
 * It intentionally produces proposals only. The caller must persist the proposal,
 * execute a Worker, and let the verifier decide whether anything is complete.
 */
export class ConservativePlanner implements Planner {
  private readonly maxAttempts: number;
  private readonly tentativeTaskCount: number;

  constructor(options: ConservativePlannerOptions = {}) {
    this.maxAttempts = validateBound(options.maxAttempts ?? 3, 'maxAttempts', 1, 10);
    this.tentativeTaskCount = validateBound(
      options.tentativeTaskCount ?? 3,
      'tentativeTaskCount',
      2,
      4,
    );
  }

  planInitial(input: {
    readonly goal: StoredGoal;
    readonly projectState: ProjectState;
    readonly executionMemory: ExecutionMemory;
    readonly workingSet: WorkingSet;
  }): InitialPlan {
    const goalSummary = summarizePrompt(input.goal.prompt);
    const verification = verificationSpec(input.projectState);
    const firstTask: PlannerTaskDraft = {
      id: `${input.goal.id}:task:1`,
      title: `Implement goal: ${goalSummary}`,
      objective: input.goal.prompt,
      acceptanceCriteria: [
        'The requested Goal change is implemented in the current workspace.',
        'No unrelated files are changed.',
      ],
      verification,
      constraints: {
        workspace: input.goal.workspace,
        singleWorker: true,
        noRemotePush: true,
      },
      maxAttempts: this.maxAttempts,
      sequence: 1,
      tentative: false,
    };
    const tentativeTasks = [
      this.followUpTask(input.goal, firstTask, 2, 'Run the discovered deterministic checks.'),
      this.followUpTask(
        input.goal,
        firstTask,
        3,
        'Review changed files against the acceptance criteria.',
      ),
      this.followUpTask(
        input.goal,
        firstTask,
        4,
        'Perform final Goal verification and record evidence.',
      ),
    ].slice(0, this.tentativeTaskCount);
    const roadmap = [
      {
        id: firstTask.id,
        title: firstTask.title,
        objective: firstTask.objective,
        status: 'LOCKED' as const,
      },
      ...tentativeTasks.map((task) => ({
        id: task.id,
        title: task.title,
        objective: task.objective,
        status: 'TENTATIVE' as const,
      })),
    ];
    return {
      goalId: input.goal.id,
      roadmap,
      firstTask,
      tentativeTasks,
      rationale:
        'The first implementation Task is locked; validation and final review remain tentative until new evidence arrives.',
    };
  }

  planRolling(input: RollingPlanInput): RollingPlan {
    const current = input.tasks.find(
      (task) =>
        task.status === 'RUNNING' || task.status === 'VERIFYING' || task.status === 'REPAIRING',
    );
    if (current !== undefined) {
      return {
        goalId: input.goal.id,
        action: 'INSPECT',
        rationale: `Task ${current.id} is still active; do not create a competing Task.`,
      };
    }
    const latest = input.latestVerification;
    if (latest?.status === 'UNCERTAIN') {
      return {
        goalId: input.goal.id,
        action: 'INSPECT',
        rationale:
          'Verification evidence is uncertain; collect more deterministic evidence before replanning.',
      };
    }
    if (latest?.status === 'FAIL') {
      const task = input.tasks.find((candidate) => candidate.id === latest.taskId);
      const attempts = task === undefined ? 0 : task.maxAttempts;
      const completedAttempts = input.executionMemory.notes.filter((note) =>
        note.includes(`attempt:${latest.taskId}:`),
      ).length;
      if (completedAttempts >= attempts) {
        return {
          goalId: input.goal.id,
          action: 'NEEDS_HUMAN',
          rationale: 'The Task reached its bounded retry budget; human review is required.',
        };
      }
      return {
        goalId: input.goal.id,
        action: 'REPLAN',
        rationale: 'Verification failed; create a repair Task using the recorded evidence.',
      };
    }
    const pending = input.tasks
      .filter((task) => task.status === 'PENDING')
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (pending !== undefined) {
      return {
        goalId: input.goal.id,
        action: 'NEXT_TASK',
        nextTask: draftFromStoredTask(pending),
        rationale:
          'The next tentative Task is now eligible after the previous evidence was accepted.',
      };
    }
    if (
      input.tasks.length > 0 &&
      input.tasks.every((task) => task.status === 'COMPLETED' || task.status === 'SKIPPED')
    ) {
      return {
        goalId: input.goal.id,
        action: 'GOAL_READY_FOR_FINAL_VERIFICATION',
        rationale:
          'All planned Tasks are terminal; run final verification against the original Goal.',
      };
    }
    return {
      goalId: input.goal.id,
      action: 'NEEDS_HUMAN',
      rationale: 'No safe deterministic next action can be selected from the current state.',
    };
  }

  private followUpTask(
    goal: StoredGoal,
    parent: PlannerTaskDraft,
    sequence: number,
    objective: string,
  ): PlannerTaskDraft {
    return {
      id: `${goal.id}:task:${sequence}`,
      title: objective,
      objective,
      acceptanceCriteria: [
        'The evidence for this follow-up is recorded.',
        'The original Goal remains satisfied.',
      ],
      verification: parent.verification,
      constraints: parent.constraints,
      maxAttempts: this.maxAttempts,
      sequence,
      tentative: true,
      parentTaskId: parent.id,
    };
  }
}

function verificationSpec(projectState: ProjectState): JsonObject {
  return {
    checks: projectState.discoverableVerification.map((command) => ({
      id: command.id,
      label: command.label,
      executable: command.executable,
      args: command.args,
    })),
    deterministicFirst: true,
  };
}

function draftFromStoredTask(task: StoredTask): PlannerTaskDraft {
  return {
    id: task.id,
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
}

function summarizePrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/gu, ' ').trim();
  if (oneLine.length <= 80) return oneLine;
  return `${oneLine.slice(0, 77)}...`;
}

function validateBound(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
