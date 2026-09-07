import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { runInteractiveProvider } from './interactive-runner.js';
import type { TerminalDriver, TerminalProcess } from '@agentscope/terminal';

class FakeTerminalProcess implements TerminalProcess {
  readonly pid = 777;
  private dataListener: ((data: string) => void) | undefined;
  private exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  readonly writes: string[] = [];
  killCount = 0;

  readonly onData = (listener: (data: string) => void) => {
    this.dataListener = listener;
    return { dispose: () => (this.dataListener = undefined) };
  };

  readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void) => {
    this.exitListener = listener;
    return { dispose: () => (this.exitListener = undefined) };
  };

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {}

  kill(): void {
    this.killCount += 1;
  }

  finish(exitCode: number): void {
    this.dataListener?.('PTY_OUTPUT');
    this.exitListener?.({ exitCode });
  }

  emitData(data: string): void {
    this.dataListener?.(data);
  }
}

class FakeSignals extends EventEmitter {
  override on(signal: NodeJS.Signals, listener: () => void): this {
    return super.on(signal, listener);
  }
}

describe('interactive provider runner', () => {
  it('records a PTY session while preserving terminal output', async () => {
    const terminalProcess = new FakeTerminalProcess();
    const driver: TerminalDriver = {
      spawn: () => {
        setTimeout(() => terminalProcess.finish(0), 0);
        return terminalProcess;
      },
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const outputChunks: string[] = [];
    output.on('data', (chunk) => outputChunks.push(chunk.toString()));

    const exitCode = await runInteractiveProvider({
      adapter: 'claude',
      args: ['--bare'],
      filename: ':memory:',
      workspacePath: process.cwd(),
      executable: process.execPath,
      terminalDriver: driver,
      input: input as unknown as typeof process.stdin,
      output: output as unknown as typeof process.stdout,
      signals: new FakeSignals(),
    });

    expect(exitCode).toBe(0);
    expect(outputChunks).toEqual(['PTY_OUTPUT']);
  });

  it('confirms only the explicit API-key startup prompt when enabled', async () => {
    const terminalProcess = new FakeTerminalProcess();
    const driver: TerminalDriver = {
      spawn: () => {
        setTimeout(() => terminalProcess.emitData('Do you want to use this API key? [y/N]'), 0);
        setTimeout(() => terminalProcess.finish(0), 10);
        return terminalProcess;
      },
    };
    const input = new PassThrough();
    const output = new PassThrough();

    const exitCode = await runInteractiveProvider({
      adapter: 'claude',
      args: [],
      filename: ':memory:',
      workspacePath: process.cwd(),
      executable: process.execPath,
      env: { ANTHROPIC_API_KEY: 'test-key' },
      autoAcceptApiKey: true,
      terminalDriver: driver,
      input: input as unknown as typeof process.stdin,
      output: output as unknown as typeof process.stdout,
      signals: new FakeSignals(),
    });

    expect(exitCode).toBe(0);
    expect(terminalProcess.writes).toEqual(['yes\r']);
  });
});
