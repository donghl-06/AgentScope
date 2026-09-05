import { describe, expect, it } from 'vitest';

import { createInitialSessionState, type SessionState } from '@agentscope/protocol';

import { computeProgress } from './index.js';

function state(overrides: Partial<SessionState> = {}): SessionState {
  return { ...createInitialSessionState('session-1', 0), ...overrides };
}

describe('progress engine', () => {
  it('keeps low-signal implementation below full completion', () => {
    const result = computeProgress({
      state: state({ currentActivity: { kind: 'implementation', label: 'editing', startedAt: 1 } }),
    });
    expect(result.value).toBeLessThan(1);
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.reasons.map((reason) => reason.code)).toContain('low_signal');
  });

  it('reports verified completion as 100%', () => {
    const result = computeProgress({
      state: state({
        status: 'completed',
        endedAt: 100,
        verification: { tests: 'passed', build: 'passed', typecheck: 'passed', overall: 'passed' },
      }),
      capabilities: { structuredEvents: true, commandEvents: true },
    });
    expect(result.value).toBe(1);
    expect(result.reasons.map((reason) => reason.code)).toContain('verified_completion');
  });

  it('caps blocked and failed sessions and preserves deterministic reasons', () => {
    const blocked = computeProgress({
      state: state({
        status: 'blocked',
        currentActivity: { kind: 'implementation', label: 'waiting', startedAt: 1 },
      }),
    });
    const failed = computeProgress({
      state: state({
        status: 'failed',
        endedAt: 100,
        verification: {
          tests: 'failed',
          build: 'unknown',
          typecheck: 'unknown',
          overall: 'failed',
        },
      }),
    });
    expect(blocked.value).toBeLessThanOrEqual(0.5);
    expect(failed.value).toBeLessThanOrEqual(0.6);
    expect(failed.reasons.map((reason) => reason.code)).toContain('verification_failed');
  });
});
