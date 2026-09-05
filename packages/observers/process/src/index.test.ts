import { describe, expect, it } from 'vitest';

import { ProcessObserver, type ProcessInspection, type ProcessObservation } from './index.js';

describe('process observer', () => {
  it('emits a bounded lifecycle and does not expose command lines or environment', async () => {
    const observations: ProcessObservation[] = [];
    let inspection: ProcessInspection = { state: 'running' };
    const observer = new ProcessObserver({
      pid: 42,
      pollMs: 10,
      now: () => 100,
      inspect: async () => inspection,
      onObservation: (event) => observations.push(event),
    });

    observer.start(10);
    await observer.pollOnce();
    inspection = { state: 'exited' };
    await observer.pollOnce();

    expect(observations).toEqual([
      { kind: 'started', pid: 42, observedAt: 10, startedAt: 10, reason: 'spawned' },
      {
        kind: 'finished',
        pid: 42,
        observedAt: 100,
        startedAt: 10,
        endedAt: 100,
        reason: 'poll_exit',
      },
    ]);
  });

  it('uses explicit child exit metadata and is idempotent', () => {
    const observations: ProcessObservation[] = [];
    const observer = new ProcessObserver({
      pid: 7,
      now: () => 80,
      onObservation: (event) => observations.push(event),
    });
    observer.start(20);
    observer.notifyExit(130, 'SIGINT', 50);
    observer.notifyExit(0, undefined, 60);
    expect(observations.at(-1)).toMatchObject({ exitCode: 130, signal: 'SIGINT', endedAt: 50 });
    expect(observer.isFinished).toBe(true);
  });

  it('does not mark an unknown inspection as an exit', async () => {
    const observations: ProcessObservation[] = [];
    const observer = new ProcessObserver({
      pid: 9,
      inspect: async () => ({ state: 'unknown' }),
      onObservation: (event) => observations.push(event),
    });
    observer.start(1);
    await observer.pollOnce();
    expect(observations).toHaveLength(1);
    expect(observer.isFinished).toBe(false);
  });

  it('serializes overlapping polls into one inspection', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const observer = new ProcessObserver({
      pid: 11,
      inspect: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { state: 'running' };
      },
      onObservation: () => {},
    });
    observer.start(1);
    const first = observer.pollOnce();
    const second = observer.pollOnce();
    expect(calls).toBe(1);
    release?.();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });
});
