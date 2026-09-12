import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openStorage, StorageRepository } from '@agentscope/storage';

import { runProvider } from './provider-runner.js';
import type { ProviderRunSignals } from './provider-runner.js';

const workspacePath = process.cwd();

class FakeSignals implements ProviderRunSignals {
  private readonly listeners = new Map<NodeJS.Signals, () => void>();

  once(signal: NodeJS.Signals, listener: () => void): void {
    this.listeners.set(signal, listener);
  }

  removeListener(signal: NodeJS.Signals): void {
    this.listeners.delete(signal);
  }

  emit(signal: NodeJS.Signals): void {
    this.listeners.get(signal)?.();
  }
}

function script(result: string, exitCode: number): string {
  return `process.stdout.write(${JSON.stringify(`${result}\n`)}); process.exit(${exitCode});`;
}

describe('provider runner', () => {
  it('persists a Claude session from structured process output', async () => {
    const stdout: string[] = [];
    const result = await runProvider({
      adapter: 'claude',
      executable: process.execPath,
      args: [
        '-e',
        script(
          '{"type":"system","subtype":"init","session_id":"provider-1"}\n{"type":"result","subtype":"success","is_error":false}',
          0,
        ),
      ],
      filename: ':memory:',
      workspacePath,
      sessionId: 'session-1',
      writeStdout: (chunk) => stdout.push(chunk),
    });

    expect(result).toMatchObject({ sessionId: 'session-1', status: 'completed', exitCode: 0 });
    // Claude structured output is normalized into lifecycle, provider metadata,
    // native-event, and terminal events rather than only start/finish.
    expect(result.eventCount).toBe(5);
    expect(stdout.join('')).toContain('provider-1');
  });

  it('persists explicit resume metadata without merging execution ids', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-continuation-'));
    const filename = path.join(directory, 'session.db');
    try {
      await runProvider({
        adapter: 'claude',
        executable: process.execPath,
        args: [
          '-e',
          script(
            '{"type":"system","subtype":"init","session_id":"provider-resume"}\n{"type":"result","subtype":"success","is_error":false}',
            0,
          ),
          '--resume',
          'provider-resume',
        ],
        filename,
        workspacePath,
        sessionId: 'execution-resume-1',
      });
      const storage = openStorage({ filename, migrate: false });
      try {
        const session = new StorageRepository(storage.client).getSession('execution-resume-1');
        expect(session.state.continuation).toEqual({
          mode: 'resume',
          reference: 'provider-resume',
        });
        expect(session.state.conversation).toEqual({
          id: 'provider-resume',
          source: 'explicit-resume',
        });
        expect(session.id).toBe('execution-resume-1');
      } finally {
        storage.client.close();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists a Codex session with the Codex provider label', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-codex-'));
    const filename = path.join(directory, 'session.db');
    try {
      await runProvider({
        adapter: 'codex',
        executable: process.execPath,
        args: [
          '-e',
          script(
            '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n{"type":"turn.completed"}',
            0,
          ),
        ],
        filename,
        workspacePath,
        sessionId: 'codex-session-1',
      });
      const storage = openStorage({ filename, migrate: false });
      const repository = new StorageRepository(storage.client);
      expect(repository.getSession('codex-session-1').provider).toBe('codex');
      expect(repository.listObserverEvidence('codex-session-1')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'process', key: expect.stringContaining('process:') }),
          expect.objectContaining({ source: 'git', kind: 'workspace' }),
        ]),
      );
      storage.client.close();
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('persists Codex structured telemetry through the provider runner', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-codex-telemetry-'));
    const filename = path.join(directory, 'session.db');
    const executableName = `agentscope-codex-fixture-${Date.now()}`;
    const scriptPath = path.join(directory, 'codex-fixture.js');
    const shimPath =
      process.platform === 'win32'
        ? path.join(directory, `${executableName}.cmd`)
        : path.join(directory, executableName);
    const originalPath = process.env.PATH;
    const output = [
      {
        type: 'thread.started',
        thread_id: 'thread-telemetry',
      },
      {
        type: 'turn.started',
      },
      {
        type: 'item.started',
        item: {
          type: 'command_execution',
          id: 'call-success',
          status: 'in_progress',
          command: 'pnpm test',
        },
      },
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'call-success',
          status: 'completed',
          exit_code: 0,
        },
      },
      {
        type: 'item.started',
        item: {
          type: 'command_execution',
          id: 'call-failure',
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'call-failure',
          status: 'failed',
          exit_code: 2,
        },
      },
      {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'redacted response',
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 12,
          cached_input_tokens: 3,
          output_tokens: 5,
          reasoning_output_tokens: 2,
          total_tokens: 20,
          turn_count: 1,
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n');

    fs.writeFileSync(scriptPath, `process.stdout.write(${JSON.stringify(`${output}\n`)});`);
    if (process.platform === 'win32') {
      fs.writeFileSync(shimPath, `@echo off\r\n"%dp0%\\codex-fixture.js" %*\r\n`);
    } else {
      fs.writeFileSync(
        shimPath,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`,
      );
      fs.chmodSync(shimPath, 0o755);
    }
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ''}`;

    try {
      const result = await runProvider({
        adapter: 'codex',
        executable: executableName,
        args: ['Reply with OK only'],
        filename,
        workspacePath: directory,
        sessionId: 'codex-structured-telemetry',
      });

      expect(result).toMatchObject({
        sessionId: 'codex-structured-telemetry',
        status: 'failed',
        exitCode: 1,
      });

      const storage = openStorage({ filename, migrate: false });
      try {
        const repository = new StorageRepository(storage.client);
        const session = repository.getSession('codex-structured-telemetry');
        const events = repository.listEvents(session.id).items;
        const telemetry = session.state.telemetry;

        expect(session.capabilities).toMatchObject({
          structuredEvents: true,
          toolCalls: true,
          tokenUsage: true,
        });
        expect(session.status).toBe('failed');
        expect(session.state.verification).toMatchObject({
          tests: 'passed',
          build: 'unknown',
          typecheck: 'unknown',
          overall: 'pending',
        });
        expect(telemetry?.usage).toMatchObject({
          inputTokens: 12,
          outputTokens: 5,
          cacheReadInputTokens: 3,
          reasoningTokens: 2,
          totalTokens: 20,
          turnCount: 1,
        });
        expect(telemetry).toMatchObject({
          toolCallCount: 2,
          toolCallFinishedCount: 2,
          toolCallErrorCount: 1,
          nativeEventCounts: expect.objectContaining({
            'thread.started': 1,
            'turn.started': 1,
            'item.started': 2,
            'item.completed': 3,
            'turn.completed': 1,
          }),
        });
        expect(events.map(({ event }) => event.type)).toEqual(
          expect.arrayContaining([
            'provider_event',
            'tool_call_started',
            'tool_call_finished',
            'command_started',
            'command_finished',
            'test_started',
            'test_passed',
            'usage_updated',
            'session_finished',
          ]),
        );
        expect(events.at(-1)?.event).toMatchObject({
          type: 'session_finished',
          payload: { reason: 'failed', exitCode: 0 },
        });
        expect(
          events
            .filter(({ event }) => event.type === 'provider_event')
            .some(({ event }) => JSON.stringify(event).includes('redacted command')),
        ).toBe(false);
      } finally {
        storage.client.close();
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('correlates Codex commands and workspace file changes with observer evidence', async () => {
    const observedPath = path.join(
      workspacePath,
      `.agentscope-provider-observer-${Date.now()}.txt`,
    );
    const observedName = path.basename(observedPath);
    const fakeExecutable = path.join(workspacePath, 'exec');
    const evidence: Array<{ source: string; kind: string; key: string }> = [];
    const output = [
      '{"type":"thread.started","thread_id":"thread-observer"}',
      '{"type":"item.started","item":{"type":"command_execution"}}',
      '{"type":"item.completed","item":{"type":"command_execution","status":"completed","exit_code":0}}',
      '{"type":"turn.completed"}',
    ].join('\n');
    const outputWithNewline = output + '\n';
    fs.writeFileSync(
      fakeExecutable,
      [
        "import fs from 'node:fs';",
        `setTimeout(() => { fs.writeFileSync(${JSON.stringify(observedPath)}, 'workspace evidence');`,
        `process.stdout.write(${JSON.stringify(outputWithNewline)});`,
        'setTimeout(() => process.exit(0), 300); }, 1_000);',
      ].join('\n'),
    );
    try {
      await runProvider({
        adapter: 'codex',
        executable: process.execPath,
        args: [],
        filename: ':memory:',
        workspacePath,
        sessionId: 'codex-observer-session',
        onObserverEvidence: (item) =>
          evidence.push({ source: item.source, kind: item.kind, key: item.key }),
      });
      expect(evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'git', kind: 'workspace' }),
          expect.objectContaining({ source: 'filesystem', key: `file:${observedName}` }),
          expect.objectContaining({ source: 'test_observer', kind: 'command' }),
          expect.objectContaining({ source: 'test_observer', kind: 'verification' }),
          expect.objectContaining({ source: 'process', kind: 'lifecycle' }),
        ]),
      );
    } finally {
      fs.rmSync(fakeExecutable, { force: true });
      fs.rmSync(observedPath, { force: true });
    }
  });

  it('uses the process exit code when provider result claims success', async () => {
    const result = await runProvider({
      adapter: 'claude',
      executable: process.execPath,
      args: ['-e', script('{"type":"result","subtype":"success","is_error":false}', 3)],
      filename: ':memory:',
      workspacePath,
      sessionId: 'session-failed',
    });

    expect(result).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('isolates observer sink failures from provider lifecycle completion', async () => {
    const diagnostics: string[] = [];
    const result = await runProvider({
      adapter: 'claude',
      executable: process.execPath,
      args: ['-e', script('{"type":"result","subtype":"success","is_error":false}', 0)],
      filename: ':memory:',
      workspacePath,
      onObserverEvidence: () => {
        throw new Error('synthetic observer sink failure');
      },
      writeStderr: (chunk) => diagnostics.push(chunk),
    });

    expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(diagnostics.join('')).toContain('synthetic observer sink failure');
  });

  it('keeps a sibling provider session independent after observer failure', async () => {
    const diagnostics: string[] = [];
    const [failedObserver, healthyObserver] = await Promise.all([
      runProvider({
        adapter: 'claude',
        executable: process.execPath,
        args: ['-e', script('{"type":"result","subtype":"success","is_error":false}', 0)],
        filename: ':memory:',
        workspacePath,
        sessionId: 'session-observer-failure',
        onObserverEvidence: () => {
          throw new Error('observer failure in one session');
        },
        writeStderr: (chunk) => diagnostics.push(chunk),
      }),
      runProvider({
        adapter: 'claude',
        executable: process.execPath,
        args: ['-e', script('{"type":"result","subtype":"success","is_error":false}', 0)],
        filename: ':memory:',
        workspacePath,
        sessionId: 'session-observer-healthy',
      }),
    ]);

    expect(failedObserver).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(healthyObserver).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(diagnostics.join('')).toContain('observer failure in one session');
  });

  it('keeps a session alive when the provider emits a malformed record before completion', async () => {
    const result = await runProvider({
      adapter: 'claude',
      executable: process.execPath,
      args: ['-e', script('not-json\n{"type":"result","subtype":"success","is_error":false}', 0)],
      filename: ':memory:',
      workspacePath,
      sessionId: 'session-parser-recovery',
    });

    expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
  });

  it.each(['claude', 'codex'] as const)(
    'persists a terminal failure when %s cannot spawn',
    async (adapter) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-spawn-error-'));
      const filename = path.join(directory, 'session.db');
      const executable = path.join(directory, 'missing-provider.exe');
      try {
        const result = await runProvider({
          adapter,
          executable,
          args: [],
          filename,
          workspacePath,
          sessionId: `${adapter}-spawn-error`,
        });

        expect(result).toMatchObject({ status: 'failed', exitCode: 1 });
        const storage = openStorage({ filename, migrate: false });
        const repository = new StorageRepository(storage.client);
        const session = repository.getSession(`${adapter}-spawn-error`);
        expect(session.status).toBe('failed');
        expect(repository.listEvents(session.id).items.at(-1)?.event).toMatchObject({
          type: 'session_finished',
          payload: { reason: 'failed' },
        });
        storage.client.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('persists explainable progress and terminal ETA after provider events', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-progress-'));
    const filename = path.join(directory, 'session.db');
    try {
      await runProvider({
        adapter: 'claude',
        executable: process.execPath,
        args: [
          '-e',
          script(
            '{"type":"system","subtype":"init","session_id":"provider-progress"}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}\n{"type":"result","subtype":"success","is_error":false}',
            0,
          ),
        ],
        filename,
        workspacePath,
        sessionId: 'session-progress',
      });
      const storage = openStorage({ filename, migrate: false });
      const repository = new StorageRepository(storage.client);
      const session = repository.getSession('session-progress');
      expect(session.state.progress.reasons.map((reason) => reason.code)).toContain(
        'completion_unverified',
      );
      expect(session.state.progress.value).toBe(1);
      expect(session.state.eta).toMatchObject({ minSeconds: 0, maxSeconds: 0 });
      expect(repository.listEtaSnapshots('session-progress').length).toBeGreaterThan(0);
      storage.client.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stops the child and returns interrupted when SIGINT is received', async () => {
    const signals = new FakeSignals();
    const running = runProvider({
      adapter: 'claude',
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      filename: ':memory:',
      workspacePath,
      sessionId: 'session-interrupted',
      signals,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    signals.emit('SIGINT');

    await expect(running).resolves.toMatchObject({ status: 'interrupted', exitCode: 130 });
  });

  it('honors SIGINT that arrives while the provider is starting', async () => {
    const signals = new FakeSignals();
    const running = runProvider({
      adapter: 'claude',
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      filename: ':memory:',
      workspacePath,
      sessionId: 'session-interrupted-during-start',
      signals,
    });
    signals.emit('SIGINT');

    await expect(running).resolves.toMatchObject({
      status: 'interrupted',
      exitCode: 130,
    });
  });

  it('preserves Unicode and spaces in the workspace path', async () => {
    const directory = path.join(
      os.tmpdir(),
      `AgentScope workspace 空格-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    fs.mkdirSync(directory, { recursive: true });
    try {
      const result = await runProvider({
        adapter: 'claude',
        executable: process.execPath,
        args: ['-e', script('{"type":"result","subtype":"success","is_error":false}', 0)],
        filename: path.join(directory, 'session.db'),
        workspacePath: directory,
        sessionId: 'session-unicode-workspace',
      });

      expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
