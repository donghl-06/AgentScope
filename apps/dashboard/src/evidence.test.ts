import { describe, expect, it } from 'vitest';

import { evidencePayloadSummary } from './evidence.js';

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
