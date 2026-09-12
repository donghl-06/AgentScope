import { describe, expect, it } from 'vitest';

import type { GitSnapshot } from '@agentscope/observer-git';
import type { StoredTask } from '@agentscope/storage';

import {
  extractVerificationCommands,
  verifyTask,
  type ProjectState,
  type VerificationCommandRunResult,
} from './index.js';

const gitSnapshot: GitSnapshot = {
  rootPath: 'D:/workspace/example',
  isRepository: true,
  branch: 'main',
  head: 'abc',
  files: [{ path: 'src/feature.ts', indexStatus: ' ', worktreeStatus: 'M' }],
  trackedFiles: ['src/feature.ts'],
  diffStat: [{ path: 'src/feature.ts', additions: 2, deletions: 1 }],
  capturedAt: 100,
};
const gitObserver = { capture: async () => gitSnapshot } as never;
const projectState = {
  workspace: 'D:/workspace/example',
  discoverableVerification: [],
} as unknown as ProjectState;

function taskWithChecks(checks: unknown[]): StoredTask {
  return {
    id: 'task-verify',
    goalId: 'goal-verify',
    title: 'Verify a task',
    objective: 'Run deterministic checks.',
    acceptanceCriteria: ['The checks pass.'],
    verification: { checks },
    constraints: {},
    maxAttempts: 3,
    status: 'VERIFYING',
    sequence: 1,
    tentative: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

const completedWorker = {
  attemptId: 'attempt-verify',
  sessionId: 'session-verify',
  status: 'completed' as const,
  exitCode: 0,
  summary: 'done',
  changedFiles: ['src/feature.ts'],
  reportedVerification: {},
};

describe('verifyTask', () => {
  it('returns PASS only after deterministic checks pass', async () => {
    const result = await verifyTask({
      workspace: projectState.workspace,
      task: taskWithChecks([
        { id: 'test', label: 'pnpm run test', executable: 'pnpm', args: ['run', 'test'] },
      ]),
      projectState,
      workerResult: completedWorker,
      gitObserver,
      runCommand: async (): Promise<VerificationCommandRunResult> => ({
        exitCode: 0,
        stdoutBytes: 10,
        stderrBytes: 0,
        timedOut: false,
      }),
    });
    expect(result.status).toBe('PASS');
    expect(result.criteria[0]?.status).toBe('PASS');
    expect(result.evidence[0]).toMatchObject({ kind: 'git', diffFiles: ['src/feature.ts'] });
  });

  it('returns FAIL for a non-zero deterministic check', async () => {
    const result = await verifyTask({
      workspace: projectState.workspace,
      task: taskWithChecks([
        { id: 'test', label: 'pnpm run test', executable: 'pnpm', args: ['run', 'test'] },
      ]),
      projectState,
      workerResult: completedWorker,
      gitObserver,
      runCommand: async (): Promise<VerificationCommandRunResult> => ({
        exitCode: 1,
        stdoutBytes: 0,
        stderrBytes: 15,
        timedOut: false,
      }),
    });
    expect(result.status).toBe('FAIL');
    expect(result.criteria[0]?.reason).toContain('Deterministic check failed');
  });

  it('returns UNCERTAIN when no checks or unsafe checks are available', async () => {
    const noChecks = await verifyTask({
      workspace: projectState.workspace,
      task: taskWithChecks([]),
      projectState,
      workerResult: completedWorker,
      gitObserver,
    });
    expect(noChecks.status).toBe('UNCERTAIN');

    const unsafe = await verifyTask({
      workspace: projectState.workspace,
      task: taskWithChecks([
        { id: 'unsafe', label: 'shell', executable: 'pnpm', args: ['run', 'test && echo unsafe'] },
      ]),
      projectState,
      workerResult: completedWorker,
      gitObserver,
      runCommand: async () => {
        throw new Error('unsafe command should not run');
      },
    });
    expect(unsafe.status).toBe('UNCERTAIN');
    expect(unsafe.deterministicChecks[0]?.reason).toContain('unsafe');
  });

  it('extracts only structured executable/args checks', () => {
    expect(
      extractVerificationCommands(
        taskWithChecks([
          { id: 'ok', executable: 'pnpm', args: ['run', 'test'] },
          { id: 'bad', executable: 'pnpm', args: 'run test' },
        ]),
      ),
    ).toHaveLength(1);
  });
});
