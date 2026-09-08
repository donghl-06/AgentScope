import { describe, expect, it } from 'vitest';

import { evidenceBelongsToTurn, evidencePayloadSummary } from './evidence.js';

const turn = {
  id: 'session-1:turn:1',
  submittedAt: 100,
  startedAt: 110,
  endedAt: 200,
} as const;

function evidence(overrides: Partial<Parameters<typeof evidenceBelongsToTurn>[0]> = {}) {
  return {
    id: 'evidence-1',
    sessionId: 'session-1',
    key: 'file:README.md',
    timestamp: 150,
    source: 'filesystem',
    kind: 'file',
    confidence: 1,
    reason: 'File changed.',
    payload: { path: 'README.md' },
    ...overrides,
  };
}

describe('turn evidence association', () => {
  it('uses an explicit turn ID when available', () => {
    expect(evidenceBelongsToTurn(evidence({ turnId: turn.id }), turn)).toBe(true);
    expect(evidenceBelongsToTurn(evidence({ turnId: 'session-1:turn:2' }), turn)).toBe(false);
  });

  it('falls back to the turn time window for legacy API responses', () => {
    expect(evidenceBelongsToTurn(evidence({ timestamp: 111 }), turn)).toBe(true);
    expect(evidenceBelongsToTurn(evidence({ timestamp: 99 }), turn)).toBe(false);
    expect(evidenceBelongsToTurn(evidence({ timestamp: 201 }), turn)).toBe(false);
  });

  it('recognizes a turn ID embedded in the legacy payload', () => {
    expect(evidenceBelongsToTurn(evidence({ payload: { turnId: turn.id } }), turn)).toBe(true);
  });
});

describe('evidence payload summaries', () => {
  it('summarizes file and verification fields without serializing the full payload', () => {
    expect(
      evidencePayloadSummary({
        path: 'src/app.ts',
        kind: 'modify',
        commandName: 'pnpm test',
        outcome: 'passed',
        exitCode: 0,
        prompt: 'do not show this',
      }),
    ).toBe(
      'path: src/app.ts · change: modify · command: pnpm test · outcome: passed · exitCode: 0',
    );
  });

  it('summarizes Git change counts and redacts credential-shaped command text', () => {
    expect(
      evidencePayloadSummary({
        added: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
        modified: ['README.md'],
        commandName: 'token=sk-test-12345678901234567890',
      }),
    ).toBe(
      'command: token=[REDACTED] · added: src/a.ts, src/b.ts, src/c.ts (+1) · modified: README.md',
    );
  });

  it('returns nothing when no known safe fields are present', () => {
    expect(evidencePayloadSummary({ prompt: 'hidden' })).toBeUndefined();
    expect(evidencePayloadSummary('not an object')).toBeUndefined();
  });
});
