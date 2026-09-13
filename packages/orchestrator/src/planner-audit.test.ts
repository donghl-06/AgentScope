import { describe, expect, it } from 'vitest';

import type { StoredGoal, StoredTask } from '@agentscope/storage';

import { buildPlannerAuditInput, buildPlannerAuditOutput } from './planner-audit.js';
import type { ExecutionMemory, ProjectState, WorkingSet } from './index.js';

const goal = {
  id: 'audit-goal',
  prompt: 'Inspect the project.',
  provider: 'mock',
  status: 'RUNNING',
  activeRevision: 4,
} as StoredGoal;

const task = {
  id: 'audit-goal:task:1',
  goalId: goal.id,
  title: 'Inspect files',
  objective: 'Read the project metadata.',
  status: 'COMPLETED',
  sequence: 1,
  tentative: false,
} as StoredTask;

const projectState = {
  capturedAt: 10,
  packageManager: 'pnpm',
  manifests: [{ path: 'package.json' }],
  relevantFiles: ['package.json'],
  discoverableVerification: [{ id: 'package-script:test' }],
  recentCommits: ['abc Initial commit'],
  git: { isRepository: true, trackedFiles: ['package.json'], diffStat: [] },
} as unknown as ProjectState;

const executionMemory: ExecutionMemory = {
  decisions: [
    {
      id: 'locked:no-push',
      summary: 'Do not push.',
      status: 'LOCKED',
      source: 'user',
      recordedAt: 1,
    },
  ],
  completedTaskIds: [task.id],
  failedApproaches: [],
  notes: [],
};

const workingSet: WorkingSet = {
  files: ['package.json'],
  directories: [],
  rationale: 'test',
  updatedAt: 10,
};

describe('rolling planner audit envelopes', () => {
  it('records only bounded decision inputs and redacts secret-shaped text', () => {
    const input = buildPlannerAuditInput({
      goal,
      tasks: [task],
      latestVerification: {
        id: 'audit-verification',
        taskId: task.id,
        status: 'FAIL',
        reason: 'apiKey=sk-1234567890abcdefghijklmnop',
        evidence: [{ path: 'src/feature.ts' }],
        deterministicChecks: [],
      } as never,
      projectState,
      executionMemory,
      workingSet,
    });
    expect(input).toMatchObject({
      schemaVersion: 1,
      goal: { id: goal.id, activeRevision: 4, taskCount: 1 },
      evidence: { status: 'FAIL', evidenceCount: 1 },
      projectState: { relevantFiles: ['package.json'], git: { trackedFileCount: 1 } },
      executionMemory: { lockedDecisionIds: ['locked:no-push'], completedTaskCount: 1 },
      workingSet: { fileCount: 1, files: ['package.json'] },
    });
    expect(JSON.stringify(input)).not.toContain('sk-1234567890abcdefghijklmnop');
  });

  it('emits a confidence and contract diff for a proposed new Task', () => {
    const plan = {
      goalId: goal.id,
      action: 'NEXT_TASK' as const,
      rationale: 'Create the next safe task.',
      confidence: 1.5,
      nextTask: {
        id: 'audit-goal:task:2',
        title: 'Verify changes',
        objective: 'Run deterministic checks.',
        acceptanceCriteria: ['Checks pass.'],
        verification: {},
        constraints: {},
        maxAttempts: 2,
        sequence: 2,
        tentative: true,
      },
    };
    expect(buildPlannerAuditOutput(plan, [task])).toEqual({
      schemaVersion: 1,
      action: 'NEXT_TASK',
      rationale: 'Create the next safe task.',
      confidence: 1,
      changeDiff: { kind: 'add', taskId: 'audit-goal:task:2' },
      nextTaskId: 'audit-goal:task:2',
    });
  });

  it('marks an unchanged existing Task as retain and defaults conservative confidence', () => {
    const plan = {
      goalId: goal.id,
      action: 'GOAL_READY_FOR_FINAL_VERIFICATION' as const,
      rationale: 'All terminal Tasks are ready.',
    };
    expect(buildPlannerAuditOutput(plan, [task])).toMatchObject({
      confidence: 0.95,
      changeDiff: { kind: 'none' },
    });
  });
});
