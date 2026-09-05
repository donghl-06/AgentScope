import { describe, expect, it } from 'vitest';

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
