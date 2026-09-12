import { describe, expect, it } from 'vitest';

import type { StoredTask } from '@agentscope/storage';

import {
  SerialWorkerRuntime,
  WorkerBusyError,
  buildWorkerPrompt,
  type ProjectState,
  type WorkingSet,
} from './index.js';

const projectState = {
  workspace: 'D:/workspace/example',
  discoverableVerification: [],
} as unknown as ProjectState;
const workingSet: WorkingSet = {
  files: ['src/feature.ts'],
  directories: ['src'],
  rationale: 'test',
  updatedAt: 1,
};
const task: StoredTask = {
  id: 'task-worker',
  goalId: 'goal-worker',
  title: 'Implement worker boundary',
  objective: 'Implement the bounded Task.',
  acceptanceCriteria: ['The boundary is serial.'],
  verification: {
    checks: [{ executable: 'pnpm', args: ['run', 'test'] }],
  },
  constraints: { noRemotePush: true },
  maxAttempts: 3,
  status: 'RUNNING',
  sequence: 1,
  tentative: false,
  createdAt: 1,
  updatedAt: 1,
};

describe('SerialWorkerRuntime', () => {
  it('builds a constrained task prompt and prevents parallel launches', async () => {
    let release: (() => void) | undefined;
    const runtime = new SerialWorkerRuntime({
      launch: async (request) => {
        expect(request.prompt).toContain('The boundary is serial.');
        expect(request.prompt).toContain('pnpm run test');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          attemptId: request.attemptId,
          sessionId: 'session-worker',
          status: 'completed',
          exitCode: 0,
          summary: 'done',
          changedFiles: ['src/feature.ts'],
          reportedVerification: { tests: 'passed' },
        };
      },
    });
    const first = runtime.execute({
      attemptId: 'attempt-1',
      provider: 'claude',
      workspace: projectState.workspace,
      task,
      projectState,
      workingSet,
    });
    await Promise.resolve();
    expect(runtime.activeAttempt).toBe('attempt-1');
    await expect(
      runtime.execute({
        attemptId: 'attempt-2',
        provider: 'claude',
        workspace: projectState.workspace,
        task,
        projectState,
        workingSet,
      }),
    ).rejects.toBeInstanceOf(WorkerBusyError);
    release?.();
    await expect(first).resolves.toMatchObject({ attemptId: 'attempt-1', status: 'completed' });
    expect(runtime.active).toBe(false);
  });

  it('releases the serial slot when a launcher fails', async () => {
    const runtime = new SerialWorkerRuntime({
      launch: async () => {
        throw new Error('provider unavailable');
      },
    });
    await expect(
      runtime.execute({
        attemptId: 'attempt-fail',
        provider: 'codex',
        workspace: projectState.workspace,
        task,
        projectState,
        workingSet,
      }),
    ).rejects.toThrow('provider unavailable');
    expect(runtime.active).toBe(false);
  });

  it('does not include arbitrary repository contents in the prompt', () => {
    const prompt = buildWorkerPrompt(task, projectState, workingSet);
    expect(prompt).toContain('src/feature.ts');
    expect(prompt).not.toContain('.env');
  });
});
