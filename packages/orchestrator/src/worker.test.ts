import { describe, expect, it } from 'vitest';

import type { StoredTask } from '@agentscope/storage';

import {
  SerialWorkerRuntime,
  WorkerBusyError,
  buildWorkerPrompt,
  classifyWorkerFailure,
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
  it.each([
    ['rate limit provider-token-123', 'rate_limit', true],
    ['ECONNREFUSED provider-token-123', 'network', true],
    ['Not logged in · provider-token-123', 'auth', false],
    ['permission denied by provider-token-123', 'permission', false],
    ['malformed JSON provider-token-123', 'invalid_output', true],
  ] as const)('classifies %s as %s', (diagnostic, code, retryable) => {
    const failure = classifyWorkerFailure({
      provider: 'claude',
      status: 'failed',
      exitCode: 1,
      diagnostic,
    });
    expect(failure).toMatchObject({ code, retryable });
    expect(failure?.summary).not.toContain('provider-token-123');
    expect(failure?.diagnosticRef).toMatch(/^worker:claude:/u);
  });

  it('distinguishes user interruption and successful completion', () => {
    expect(
      classifyWorkerFailure({ provider: 'codex', status: 'interrupted', exitCode: 130 }),
    ).toMatchObject({ code: 'user_interrupt', retryable: false, exitCode: 130 });
    expect(
      classifyWorkerFailure({ provider: 'codex', status: 'completed', exitCode: 0 }),
    ).toBeUndefined();
  });

  it('honors a normalized provider error code without retaining its diagnostic', () => {
    expect(
      classifyWorkerFailure({
        provider: 'codex-app-server',
        status: 'failed',
        exitCode: 1,
        errorCode: 'invalid_output',
        diagnostic: 'provider-token-456',
      }),
    ).toMatchObject({ code: 'invalid_output', retryable: true });
  });

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
