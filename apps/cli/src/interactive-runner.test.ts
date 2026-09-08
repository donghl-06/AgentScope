import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  ConsoleInputDecoder,
  prepareInteractiveEnvironment,
  recoverPastedInput,
  runInteractiveProvider,
} from './interactive-runner.js';
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
  it('decodes Windows Console key-down records for task boundary detection', () => {
    const decoder = new ConsoleInputDecoder();
    const one = '\u001b[49;2;49;1;0;1_';
    const release = '\u001b[49;2;49;0;0;1_';
    const enter = '\u001b[13;28;13;1;0;1_';
    expect(decoder.decode(one.slice(0, 8))).toBe('');
    expect(decoder.decode(one.slice(8) + release + enter)).toBe('1\r');
    expect(decoder.decode('\u001b[<35;57;11MReply with OK\r')).toBe('Reply with OK\r');
    expect(decoder.decode('\u001b[82;1u\u001b[13;1u')).toBe('R\r');
    expect(decoder.decode('\u001b[82;1:3u')).toBe('');
    expect(
      decoder.decode(
        '\u001bP>|xterm.js(6.1.0-beta.292)\u001b\\\u001b[200~请只回复：TTY_DIAG_OK\u001b[201~\r',
      ),
    ).toBe('请只回复：TTY_DIAG_OK\r');
  });

  it('recovers a long bracketed paste when the terminal decoder yields no text', () => {
    const prompt = '请只做当前工作区的只读检查，完成后只回复 PASTE_OK。';
    const raw = `\u001b[200~${prompt}\u001b[201~\r`;
    expect(recoverPastedInput(raw, '')).toBe(`${prompt}\r`);
    expect(recoverPastedInput(raw, prompt)).toBe(prompt);
  });

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
      if (data.endsWith('FIRST\r')) {
        terminalProcess.emitData('Working on first...\r\n> Try "next"');
      } else if (data.endsWith('SECOND\r')) {
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
    setTimeout(() => input.write('\u001b[<35;57;11MFIRST\r'), 5);
    setTimeout(() => input.write('\u001b[<35;57;12MSECOND\r'), 15);
    const exitCode = await running;
    const storage = openStorage({ filename, migrate: false });
    try {
      const repository = new StorageRepository(storage.client);
      const turns = repository.listTurns('session-tty');
      const evidence = repository.listObserverEvidence('session-tty');
      const events = repository.listEvents('session-tty').items;
      expect(exitCode).toBe(0);
      expect(turns).toHaveLength(2);
      expect(turns.map((turn) => [turn.title, turn.status])).toEqual([
        ['FIRST', 'completed'],
        ['SECOND', 'completed'],
      ]);
      expect(turns.map((turn) => Math.round(turn.state.progress.value * 100))).toEqual([60, 60]);
      expect(turns.map((turn) => turn.state.currentActivity?.label)).toEqual([
        'task completed',
        'task completed',
      ]);
      expect(repository.getSession('session-tty').state.currentActivity?.label).toBe(
        'task completed',
      );
      expect(repository.getSession('session-tty').state.progress.value).toBeGreaterThan(0);
      // One content-free terminal-input observation plus lifecycle evidence
      // for the two submitted turns.
      expect(evidence.length).toBeGreaterThanOrEqual(7);
      const turnEvidence = evidence.filter((item) => item.turnId !== undefined);
      expect(turnEvidence.filter((item) => item.source === 'interactive-pty')).toHaveLength(4);
      expect(turnEvidence.filter((item) => item.source === 'process')).toHaveLength(4);
      expect(turnEvidence.filter((item) => item.source === 'git')).toHaveLength(4);
      expect(new Set(turnEvidence.map((item) => item.turnId))).toEqual(
        new Set(['session-tty:turn:1', 'session-tty:turn:2']),
      );
      expect(events.map(({ event }) => event.type)).toEqual([
        'session_started',
        'turn_started',
        'turn_finished',
        'turn_started',
        'turn_finished',
        'session_finished',
      ]);
    } finally {
      storage.client.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts a new turn when the provider omits its ready-prompt marker', async () => {
    const terminalProcess = new FakeTerminalProcess();
    terminalProcess.writeHandler = (data) => {
      if (data.endsWith('SECOND\r')) setTimeout(() => terminalProcess.finish(0), 0);
      else if (data.endsWith('FIRST\r'))
        terminalProcess.emitData('Model response without a prompt marker\r\n');
    };
    const driver: TerminalDriver = {
      spawn: () => terminalProcess,
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-tty-boundary-'));
    const filename = path.join(directory, 'session.db');
    const running = runInteractiveProvider({
      adapter: 'claude',
      args: [],
      filename,
      workspacePath: directory,
      executable: process.execPath,
      sessionId: 'session-unmarked-boundary',
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
      const repository = new StorageRepository(storage.client);
      const turns = repository.listTurns('session-unmarked-boundary');
      expect(exitCode).toBe(0);
      expect(turns.map((turn) => [turn.title, turn.status])).toEqual([
        ['FIRST', 'completed'],
        ['SECOND', 'completed'],
      ]);
    } finally {
      storage.client.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('associates debounced filesystem evidence with the active turn window', async () => {
    const terminalProcess = new FakeTerminalProcess();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-tty-file-'));
    const filename = path.join(workspace, 'session.db');
    const changedPath = path.join(workspace, 'evidence.txt');
    terminalProcess.writeHandler = (data) => {
      if (!data.endsWith('FILE\r')) return;
      fs.writeFileSync(changedPath, 'file evidence\n', 'utf8');
      setTimeout(() => terminalProcess.emitData('Working...\r\n> Try "next"'), 220);
      setTimeout(() => terminalProcess.finish(0), 240);
    };
    const driver: TerminalDriver = {
      spawn: () => {
        setTimeout(() => terminalProcess.emitData('> Try "task"'), 0);
        return terminalProcess;
      },
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const running = runInteractiveProvider({
      adapter: 'claude',
      args: [],
      filename,
      workspacePath: workspace,
      executable: process.execPath,
      sessionId: 'session-file-window',
      terminalDriver: driver,
      input: input as unknown as typeof process.stdin,
      output: output as unknown as typeof process.stdout,
      signals: new FakeSignals(),
    });
    setTimeout(() => input.write('FILE\r'), 5);
    const exitCode = await running;
    const storage = openStorage({ filename, migrate: false });
    try {
      const repository = new StorageRepository(storage.client);
      const evidence = repository
        .listObserverEvidence('session-file-window')
        .find((item) => item.key === 'file:evidence.txt');
      expect(exitCode).toBe(0);
      expect(repository.getSession('session-file-window').capabilities.fileEvents).toBe(true);
      expect(evidence).toMatchObject({
        turnId: 'session-file-window:turn:1',
        source: 'filesystem',
        payload: { path: 'evidence.txt', kind: 'create' },
      });
    } finally {
      storage.client.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('projects observer activity and ETA while a TTY turn is still running', async () => {
    const terminalProcess = new FakeTerminalProcess();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-tty-live-'));
    const filename = path.join(workspace, 'session.db');
    const changedPath = path.join(workspace, 'live.txt');
    terminalProcess.writeHandler = (data) => {
      if (!data.endsWith('LIVE\r')) return;
      fs.writeFileSync(changedPath, 'live evidence\n', 'utf8');
      terminalProcess.emitData('Working on LIVE...\r\n');
    };
    const driver: TerminalDriver = { spawn: () => terminalProcess };
    const input = new PassThrough();
    const output = new PassThrough();
    const running = runInteractiveProvider({
      adapter: 'claude',
      args: [],
      filename,
      workspacePath: workspace,
      executable: process.execPath,
      sessionId: 'session-tty-live',
      terminalDriver: driver,
      input: input as unknown as typeof process.stdin,
      output: output as unknown as typeof process.stdout,
      signals: new FakeSignals(),
    });

    setTimeout(() => input.write('LIVE\r'), 100);
    await new Promise((resolve) => setTimeout(resolve, 350));

    const liveStorage = openStorage({ filename, migrate: false });
    try {
      const liveRepository = new StorageRepository(liveStorage.client);
      const session = liveRepository.getSession('session-tty-live');
      const turns = liveRepository.listTurns('session-tty-live');
      const events = liveRepository.listEvents('session-tty-live').items;
      expect(session.status).toBe('running');
      expect(session.state.currentActivity?.kind).toBe('file');
      expect(session.state.eta).toBeDefined();
      expect(turns).toHaveLength(1);
      expect(turns[0]?.status).toBe('running');
      expect(turns[0]?.state.currentActivity?.kind).toBe('file');
      expect(events.some(({ event }) => event.type === 'observer_activity')).toBe(true);
    } finally {
      liveStorage.client.close();
    }

    terminalProcess.finish(0);
    expect(await running).toBe(0);
    fs.rmSync(workspace, { recursive: true, force: true });
  });
});
