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
      dashboard: false,
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

    await new Promise<void>((resolve) => setImmediate(resolve));
    signals.emit('SIGINT');
    expect(await pending).toBe(0);
    expect(closed).toBe(1);
    expect(output).toEqual(['AgentScope server listening at http://127.0.0.1:8787\n']);
  });

  it('starts and closes the Dashboard with the server', async () => {
    const signals = new FakeSignals();
    const output: string[] = [];
    let serverClosed = 0;
    let dashboardClosed = 0;
    const pending = runStartCommand({
      cwd: 'C:/workspace',
      env: {},
      signals,
      dashboard: true,
      write: (text) => output.push(text),
      startServer: async () => ({
        address: 'http://127.0.0.1:8787',
        close: async () => {
          serverClosed += 1;
        },
      }),
      startDashboard: async (options) => {
        expect(options).toEqual({ cwd: 'C:/workspace', host: '127.0.0.1', port: 5173 });
        return {
          address: 'http://127.0.0.1:5173',
          close: async () => {
            dashboardClosed += 1;
          },
          waitForExit: () => new Promise<number | null>(() => {}),
        };
      },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    signals.emit('SIGINT');
    expect(await pending).toBe(0);
    expect(serverClosed).toBe(1);
    expect(dashboardClosed).toBe(1);
    expect(output).toEqual([
      'AgentScope server listening at http://127.0.0.1:8787\n',
      'AgentScope Dashboard listening at http://127.0.0.1:5173\n',
    ]);
  });
});
