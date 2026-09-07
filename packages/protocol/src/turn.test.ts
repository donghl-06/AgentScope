import { describe, expect, it } from 'vitest';

import { assertTurnState, isTurnState, ProtocolValidationError } from './schema.js';
import { assertTurnStateInvariants, createInitialTurnState, isTerminalTurnStatus } from './turn.js';

describe('Turn protocol', () => {
  it('creates and validates a queued turn without changing the V0 session shape', () => {
    const turn = createInitialTurnState('turn-1', 'session-1', 1, 1_700_000_000_000, {
      title: 'Inspect project',
      prompt: 'Read the project files',
    });

    expect(turn.status).toBe('queued');
    expect(isTerminalTurnStatus(turn.status)).toBe(false);
    expect(isTurnState(turn)).toBe(true);
    expect(() => assertTurnState(turn)).not.toThrow();
    expect(() => assertTurnStateInvariants(turn)).not.toThrow();
  });

  it('requires positive sequence and preserves terminal timestamp rules', () => {
    const turn = createInitialTurnState('turn-1', 'session-1', 1, 100);
    expect(() => assertTurnStateInvariants({ ...turn, sequence: 0 })).toThrow(
      'Turn sequence must be a positive safe integer.',
    );
    expect(() => assertTurnStateInvariants({ ...turn, status: 'completed' })).toThrow(
      'Only terminal turns may have endedAt.',
    );
    expect(() => assertTurnState({ ...turn, extra: true })).toThrow(ProtocolValidationError);
  });

  it('accepts a completed turn with a valid lifecycle', () => {
    const turn = {
      ...createInitialTurnState('turn-1', 'session-1', 1, 100),
      status: 'completed' as const,
      startedAt: 110,
      endedAt: 120,
    };
    expect(() => assertTurnStateInvariants(turn)).not.toThrow();
    expect(isTerminalTurnStatus(turn.status)).toBe(true);
  });
});
