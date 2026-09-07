import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { prepareInteractiveEnvironment, runInteractiveProvider } from './interactive-runner.js';
import type { TerminalDriver, TerminalProcess } from '@agentscope/terminal';
import { openStorage, StorageRepository } from '@agentscope/storage';

class FakeTerminalProcess implements TerminalProcess {
  readonly pid = 777;
  private dataListener: ((data: string) => void) | undefined;
  private exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  readonly writes: string[] = [];
  killCount = 0;
  writeHandler: ((data: string) => void) | undefined;

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
    this.writeHandler?.(data);
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
  it('aliases a custom endpoint API key as auth token without overwriting an explicit token', () => {
    expect(
      prepareInteractiveEnvironment({
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
        ANTHROPIC_API_KEY: 'api-key',
      }),
    ).toMatchObject({
      ANTHROPIC_API_KEY: 'api-key',
      ANTHROPIC_AUTH_TOKEN: 'api-key',
    });
    expect(
      prepareInteractiveEnvironment({
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
        ANTHROPIC_API_KEY: 'api-key',
        ANTHROPIC_AUTH_TOKEN: 'explicit-token',
      }).ANTHROPIC_AUTH_TOKEN,
    ).toBe('explicit-token');
    expect(
      prepareInteractiveEnvironment({ ANTHROPIC_API_KEY: 'api-key' }).ANTHROPIC_AUTH_TOKEN,
    ).toBeUndefined();
  });

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

  it('persists two normal interactive turns from PTY activity and prompts', async () => {
    const terminalProcess = new FakeTerminalProcess();
    terminalProcess.writeHandler = (data) => {
      if (data === 'FIRST\r') {
        terminalProcess.emitData('Working on first...\r\n> Try "next"');
      } else if (data === 'SECOND\r') {
        terminalProcess.emitData('Working on second...\r\n> Try "next"');
        setTimeout(() => terminalProcess.finish(0), 0);
      }
    };
    const driver: TerminalDriver = {
      spawn: () => {
        setTimeout(() => terminalProcess.emitData('> Try "task"'), 0);
        return terminalProcess;
      },
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-tty-'));
    const filename = path.join(directory, 'session.db');
    const running = runInteractiveProvider({
      adapter: 'claude',
      args: [],
      filename,
      workspacePath: process.cwd(),
      executable: process.execPath,
      sessionId: 'session-tty',
      terminalDriver: driver,
      input: input as unknown as typeof process.stdin,
      output: output as unknown as typeof process.stdout,
      signals: new FakeSignals(),
    });
    setTimeout(() => input.write('FIRST\r'), 5);
    setTimeout(() => input.write('SECOND\r'), 15);
    const exitCode = await running;
    const storage = openStorage({ filename, migrate: false });
    try {
      const turns = new StorageRepository(storage.client).listTurns('session-tty');
      expect(exitCode).toBe(0);
      expect(turns).toHaveLength(2);
      expect(turns.map((turn) => [turn.title, turn.status])).toEqual([
        ['FIRST', 'completed'],
        ['SECOND', 'completed'],
      ]);
    } finally {
      storage.client.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
