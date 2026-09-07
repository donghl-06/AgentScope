import { describe, expect, it } from 'vitest';

import { TurnCoordinator } from './turn-coordinator.js';
import { TurnSignalArbiter, type TurnSignal } from './turn-signal-arbiter.js';

function signal(signal: TurnSignal): TurnSignal {
  return signal;
}

describe('TurnSignalArbiter', () => {
  it('accepts reliable hook signals regardless of PTY threshold', () => {
    const arbiter = new TurnSignalArbiter(new TurnCoordinator({ sessionId: 'session-1' }));
    const started = arbiter.apply(
      signal({
        kind: 'task_submitted',
        prompt: 'Run the test suite',
        source: 'hook',
        confidence: 0.4,
        timestamp: 100,
      }),
    );

    expect(started).toMatchObject({
      accepted: true,
      reason: 'accepted',
      turn: { status: 'running', prompt: 'Run the test suite' },
    });
  });

  it('rejects noisy PTY signals while accepting high-confidence fallback signals', () => {
    const arbiter = new TurnSignalArbiter(new TurnCoordinator({ sessionId: 'session-1' }), {
      ptyConfidenceThreshold: 0.8,
    });

    expect(
      arbiter.apply(
        signal({
          kind: 'task_submitted',
          prompt: 'Maybe a task',
          source: 'pty',
          confidence: 0.79,
          timestamp: 100,
        }),
      ),
    ).toEqual({ accepted: false, reason: 'low_confidence' });

    expect(
      arbiter.apply(
        signal({
          kind: 'task_submitted',
          prompt: 'A confirmed task',
          source: 'pty',
          confidence: 0.9,
          timestamp: 110,
        }),
      ),
    ).toMatchObject({ accepted: true, turn: { status: 'running' } });

    expect(
      arbiter.apply(
        signal({
          kind: 'finished',
          reason: 'completed',
          source: 'pty',
          confidence: 0.5,
          timestamp: 120,
        }),
      ),
    ).toEqual({ accepted: false, reason: 'low_confidence' });
  });

  it('routes explicit waiting, blocked, resume, and finish signals', () => {
    const arbiter = new TurnSignalArbiter(new TurnCoordinator({ sessionId: 'session-1' }));
    arbiter.apply({
      kind: 'task_submitted',
      prompt: 'Needs approval',
      source: 'manual',
      confidence: 1,
      timestamp: 100,
    });

    expect(
      arbiter.apply({
        kind: 'waiting',
        source: 'hook',
        confidence: 1,
        timestamp: 110,
      }),
    ).toMatchObject({ accepted: true, turn: { status: 'waiting' } });
    expect(
      arbiter.apply({
        kind: 'blocked',
        source: 'hook',
        confidence: 1,
        timestamp: 120,
      }),
    ).toMatchObject({ accepted: true, turn: { status: 'blocked' } });
    expect(
      arbiter.apply({
        kind: 'resumed',
        source: 'hook',
        confidence: 1,
        timestamp: 130,
      }),
    ).toMatchObject({ accepted: true, turn: { status: 'running' } });
    expect(
      arbiter.apply({
        kind: 'finished',
        reason: 'completed',
        source: 'hook',
        confidence: 1,
        timestamp: 140,
      }),
    ).toMatchObject({ accepted: true, turn: { status: 'completed' } });
  });

  it('does not manufacture a terminal state without an active turn', () => {
    const arbiter = new TurnSignalArbiter(new TurnCoordinator({ sessionId: 'session-1' }));
    expect(
      arbiter.apply({
        kind: 'finished',
        reason: 'completed',
        source: 'observer',
        confidence: 1,
        timestamp: 100,
      }),
    ).toEqual({ accepted: false, reason: 'no_active_turn' });
  });
});
