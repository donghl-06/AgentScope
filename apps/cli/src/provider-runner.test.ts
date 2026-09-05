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
    expect(result.eventCount).toBe(2);
    expect(stdout.join('')).toContain('provider-1');
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
      fs.rmSync(directory, { recursive: true, force: true });
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
      expect(session.state.progress.value).toBeLessThanOrEqual(0.6);
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
});
