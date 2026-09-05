import { describe, expect, it } from 'vitest';

import { createInitialSessionState, type SessionState } from '@agentscope/protocol';

import { estimateEta } from './index.js';

function state(overrides: Partial<SessionState> = {}): SessionState {
  return { ...createInitialSessionState('session-1', 0), ...overrides };
}

describe('ETA engine', () => {
  it('returns a wide insufficient-data range at zero progress', () => {
    const eta = estimateEta({
      state: state(),
      progress: { value: 0, confidence: 0, reasons: [] },
      elapsedSeconds: 10,
    });
    expect(eta).toMatchObject({ minSeconds: 60, maxSeconds: 3_600, confidence: 0 });
    expect(eta.reasons[0]?.code).toBe('insufficient_data');
  });

  it('widens ETA for failed verification and low confidence', () => {
    const eta = estimateEta({
      state: state({
        verification: {
          tests: 'failed',
          build: 'unknown',
          typecheck: 'unknown',
          overall: 'failed',
        },
      }),
      progress: { value: 0.5, confidence: 0.3, reasons: [] },
      elapsedSeconds: 120,
    });
    expect(eta.maxSeconds).toBeGreaterThan(eta.minSeconds);
    expect(eta.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['failed_verification_penalty', 'low_signal_penalty']),
    );
  });

  it('returns zero for terminal sessions and rejects invalid configuration', () => {
    expect(
      estimateEta({
        state: state({ status: 'completed', endedAt: 10 }),
        progress: { value: 1, confidence: 1, reasons: [] },
        elapsedSeconds: 100,
      }),
    ).toMatchObject({ minSeconds: 0, maxSeconds: 0 });
    expect(() =>
      estimateEta(
        { state: state(), progress: { value: 0, confidence: 0, reasons: [] }, elapsedSeconds: 0 },
        { minProgress: 0, lowSignalMinSeconds: 1, lowSignalMaxSeconds: 2, maxSeconds: 3 },
      ),
    ).toThrow(RangeError);
  });

  it('widens ETA when milestone scope is replanned', () => {
    const base = estimateEta({
      state: state(),
      progress: { value: 0.5, confidence: 0.8, reasons: [] },
      elapsedSeconds: 120,
    });
    const replanned = estimateEta({
      state: state(),
      progress: { value: 0.5, confidence: 0.8, reasons: [] },
      elapsedSeconds: 120,
      replanningDetected: true,
    });
    expect(replanned.maxSeconds).toBeGreaterThan(base.maxSeconds);
    expect(replanned.reasons.map((reason) => reason.code)).toContain('replanning_penalty');
  });

  it('derives replanning from a failed milestone and validates penalty bounds', () => {
    const eta = estimateEta({
      state: state({ milestones: [{ id: 'm1', title: 'scope', status: 'failed' }] }),
      progress: { value: 0.5, confidence: 0.8, reasons: [] },
      elapsedSeconds: 120,
    });
    expect(eta.reasons.map((reason) => reason.code)).toContain('replanning_penalty');
    expect(() =>
      estimateEta(
        {
          state: state(),
          progress: { value: 0.5, confidence: 0.8, reasons: [] },
          elapsedSeconds: 1,
        },
        {
          minProgress: 0.08,
          lowSignalMinSeconds: 1,
          lowSignalMaxSeconds: 2,
          maxSeconds: 100,
          replanningPenalty: 20,
        },
      ),
    ).toThrow(RangeError);
  });
});
