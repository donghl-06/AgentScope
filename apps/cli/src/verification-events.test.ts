import { describe, expect, it } from 'vitest';

import { createVerificationEvent } from './verification-events.js';

const source = {
  provider: 'codex',
  client: 'codex-cli',
  environment: 'win32',
  adapter: 'codex-cli',
};

function evidence(
  phase: 'command' | 'verification',
  payload: Record<string, unknown>,
): Parameters<typeof createVerificationEvent>[2] {
  return {
    id: `evidence-${phase}`,
    key: `command:fixture:${phase}`,
    timestamp: 1_700_000_000_100,
    source: 'test_observer',
    kind: phase,
    confidence: 0.9,
    reason: 'fixture',
    payload,
  };
}

describe('verification event projection', () => {
  it('maps safe command and result evidence without retaining command text', () => {
    expect(
      createVerificationEvent(
        'session-1',
        source,
        evidence('command', {
          kind: 'test',
          commandName: 'pnpm test -- secret-value-is-not-stored',
        }),
      ),
    ).toMatchObject({
      type: 'test_started',
      payload: { testKind: 'test' },
    });
    expect(
      JSON.stringify(
        createVerificationEvent(
          'session-1',
          source,
          evidence('command', {
            kind: 'test',
            commandName: 'pnpm test -- secret-value-is-not-stored',
          }),
        ),
      ),
    ).not.toContain('secret-value-is-not-stored');
    expect(
      createVerificationEvent(
        'session-1',
        source,
        evidence('verification', { kind: 'test', outcome: 'passed', durationMs: 42 }),
      ),
    ).toMatchObject({ type: 'test_passed', payload: { testKind: 'test', durationMs: 42 } });
    expect(
      createVerificationEvent(
        'session-1',
        source,
        evidence('verification', { kind: 'build', outcome: 'failed', durationMs: 7 }),
      ),
    ).toMatchObject({
      type: 'test_failed',
      payload: { testKind: 'build', failureSummary: 'Verification command failed.' },
    });
  });

  it('ignores unknown and interrupted verification outcomes', () => {
    expect(
      createVerificationEvent(
        'session-1',
        source,
        evidence('command', { kind: 'unknown', commandName: 'custom command' }),
      ),
    ).toBeUndefined();
    expect(
      createVerificationEvent(
        'session-1',
        source,
        evidence('verification', { kind: 'test', outcome: 'interrupted' }),
      ),
    ).toBeUndefined();
  });
});
