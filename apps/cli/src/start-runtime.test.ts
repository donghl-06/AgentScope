import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { runStartCommand, type ShutdownSignals } from './start-runtime.js';

class FakeSignals implements ShutdownSignals {
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

describe('start command runtime', () => {
  it('starts with the configured defaults and closes on SIGINT', async () => {
    const signals = new FakeSignals();
    const output: string[] = [];
    let closed = 0;
    const pending = runStartCommand({
      cwd: 'C:/workspace',
      env: {},
      signals,
      write: (text) => output.push(text),
      startServer: async (options) => {
        expect(options).toMatchObject({
          filename: path.resolve('C:/workspace', '.agentscope/agentscope.db'),
          host: '127.0.0.1',
          port: 8787,
        });
        return {
          address: 'http://127.0.0.1:8787',
          close: async () => {
            closed += 1;
          },
        };
      },
    });

    await Promise.resolve();
    signals.emit('SIGINT');
    expect(await pending).toBe(0);
    expect(closed).toBe(1);
    expect(output).toEqual(['AgentScope server listening at http://127.0.0.1:8787\n']);
  });
});
