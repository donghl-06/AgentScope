import { describe, expect, it } from 'vitest';

import {
  assertSessionStateInvariants,
  createInitialSessionState,
  isTerminalSessionStatus,
} from './session.js';

describe('SessionState contract', () => {
  it('creates a non-terminal initial state with explicit verification defaults', () => {
    const state = createInitialSessionState('session-1', 1_700_000_000_000);

    expect(state.status).toBe('starting');
    expect(state.endedAt).toBeUndefined();
    expect(state.milestones).toEqual([]);
    expect(state.verification.overall).toBe('unknown');
    expect(state.progress.reasons[0]?.code).toBe('no_signal');
    expect(isTerminalSessionStatus(state.status)).toBe(false);
    expect(() => assertSessionStateInvariants(state)).not.toThrow();
  });

  it('rejects terminal states without endedAt and invalid progress bounds', () => {
    const initial = createInitialSessionState('session-1', 1_700_000_000_000);
    const terminal = { ...initial, status: 'completed' as const };
    expect(() => assertSessionStateInvariants(terminal)).toThrow(/endedAt/);

    const invalidProgress = {
      ...initial,
      progress: { ...initial.progress, value: 1.1 },
    };
    expect(() => assertSessionStateInvariants(invalidProgress)).toThrow(/Progress value/);
  });
});
