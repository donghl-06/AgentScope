import { describe, expect, it } from 'vitest';

import { TerminalSession } from './session.js';
import type { TerminalDriver, TerminalProcess } from './types.js';

class FakeProcess implements TerminalProcess {
  readonly pid = 1234;
  readonly dataListeners = new Set<(data: string) => void>();
  readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  killCount = 0;
  writes: string[] = [];
  resizeCalls: Array<[number, number]> = [];

  readonly onData = (listener: (data: string) => void) => {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  };

  readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void) => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push([cols, rows]);
  }

  kill(): void {
    this.killCount += 1;
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: { exitCode: number; signal?: number }): void {
    for (const listener of [...this.exitListeners]) listener(event);
  }
}

function setup(): { process: FakeProcess; session: TerminalSession } {
  const process = new FakeProcess();
  const driver: TerminalDriver = { spawn: () => process };
  return { process, session: TerminalSession.spawn(driver, { command: 'fake', args: [] }) };
}

describe('TerminalSession', () => {
  it('forwards data, input, resize, and interrupt', () => {
    const { process, session } = setup();
    const output: string[] = [];
    session.onData(data => output.push(data));

    process.emitData('hello');
    session.write('input');
    session.resize({ cols: 100, rows: 30 });
    session.interrupt();

    expect(output).toEqual(['hello']);
    expect(process.writes).toEqual(['input', String.fromCharCode(3)]);
    expect(process.resizeCalls).toEqual([[100, 30]]);
  });

  it('does not kill an already exited process', () => {
    const { process, session } = setup();
    const exits: Array<{ exitCode: number }> = [];
    session.onExit(event => exits.push(event));

    process.emitExit({ exitCode: 0 });
    session.dispose();
    session.kill();

    expect(session.state).toBe('exited');
    expect(session.exit).toEqual({ exitCode: 0 });
    expect(process.killCount).toBe(0);
    expect(exits).toEqual([{ exitCode: 0 }]);
  });

  it('guards repeated cleanup and finishes as disposed after exit', () => {
    const { process, session } = setup();

    session.dispose();
    session.dispose();
    session.kill();

    expect(session.state).toBe('disposing');
    expect(process.killCount).toBe(1);

    process.emitExit({ exitCode: 143, signal: 15 });
    expect(session.state).toBe('disposed');
    expect(session.exit).toEqual({ exitCode: 143, signal: 15 });
    expect(() => session.write('after-exit')).toThrow(/state disposed/);
  });
});
