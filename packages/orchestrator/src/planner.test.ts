import { describe, expect, it } from 'vitest';

import type { StoredGoal, StoredTask, StoredVerificationRun } from '@agentscope/storage';

import { ConservativePlanner, type ProjectState } from './index.js';

const projectState: ProjectState = {
  workspace: 'D:/workspace/example',
  capturedAt: 100,
  git: {
    rootPath: 'D:/workspace/example',
    isRepository: true,
    branch: 'main',
    head: 'abc',
    files: [],
    trackedFiles: ['src/feature.ts', 'package.json'],
    diffStat: [],
    capturedAt: 100,
  },
  packageManager: 'pnpm',
  manifests: [{ path: 'package.json', kind: 'node', present: true, scripts: ['test'] }],
  readmePath: 'README.md',
  techStack: ['TypeScript'],
  topLevelDirectories: ['src'],
  discoverableVerification: [
    {
      id: 'package-script:test',
      label: 'pnpm run test',
      executable: 'pnpm',
      args: ['run', 'test'],
      source: 'package-script',
    },
  ],
  recentCommits: [],
  relevantFiles: ['package.json', 'src/feature.ts'],
};

const goal: StoredGoal = {
  id: 'goal-planner',
  workspace: projectState.workspace,
  prompt: 'Implement the feature safely.',
  provider: 'claude',
  status: 'PLANNING',
  constraints: {},
  roadmap: [],
  projectState: {},
  executionMemory: {},
  workingSet: {},
  activeRevision: 0,
  createdAt: 100,
  updatedAt: 100,
};

const memory = { decisions: [], completedTaskIds: [], failedApproaches: [], notes: [] } as const;
const workingSet = {
  files: projectState.relevantFiles,
  directories: ['src'],
  rationale: 'test',
  updatedAt: 100,
} as const;

describe('ConservativePlanner', () => {
  it('creates one locked task and three tentative tasks with structured checks', () => {
    const plan = new ConservativePlanner().planInitial({
      goal,
      projectState,
      executionMemory: memory,
      workingSet,
    });

    expect(plan.firstTask).toMatchObject({
      id: 'goal-planner:task:1',
      tentative: false,
      maxAttempts: 3,
    });
    expect(plan.tentativeTasks).toHaveLength(3);
    expect(plan.roadmap.map((item) => item.status)).toEqual([
      'LOCKED',
      'TENTATIVE',
      'TENTATIVE',
      'TENTATIVE',
    ]);
    expect(plan.firstTask.verification).toEqual({
      checks: [
        {
          id: 'package-script:test',
          label: 'pnpm run test',
          executable: 'pnpm',
          args: ['run', 'test'],
        },
      ],
      deterministicFirst: true,
    });
  });

  it('never claims completion and chooses safe rolling actions from evidence', () => {
    const planner = new ConservativePlanner();
    const initial = planner.planInitial({
      goal,
      projectState,
      executionMemory: memory,
      workingSet,
    });
    const activeTask: StoredTask = {
      ...initial.firstTask,
      goalId: goal.id,
      status: 'RUNNING',
      createdAt: 100,
      updatedAt: 100,
      startedAt: 100,
    };
    expect(
      planner.planRolling({
        goal,
        tasks: [activeTask],
        projectState,
        executionMemory: memory,
        workingSet,
      }).action,
    ).toBe('INSPECT');

    const verification: StoredVerificationRun = {
      id: 'verification-fail',
      taskId: activeTask.id,
      status: 'FAIL',
      criteria: activeTask.acceptanceCriteria,
      deterministicChecks: [],
      evidence: [],
      reason: 'test failure',
      createdAt: 100,
      updatedAt: 100,
    };
    expect(
      planner.planRolling({
        goal,
        tasks: [{ ...activeTask, status: 'FAILED' }],
        latestVerification: verification,
        projectState,
        executionMemory: memory,
        workingSet,
      }).action,
    ).toBe('REPLAN');
  });
});
