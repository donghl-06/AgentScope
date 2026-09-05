import { describe, expect, it } from 'vitest';

import { ObserverEvidenceLedger, compareEvidence, type ObserverEvidence } from './index.js';

function evidence(overrides: Partial<ObserverEvidence> = {}): ObserverEvidence {
  return {
    id: 'evidence-1',
    key: 'command:build',
    timestamp: 100,
    source: 'filesystem',
    kind: 'command',
    confidence: 0.4,
    reason: 'inferred from workspace activity',
    payload: { observed: true },
    ...overrides,
  };
}

describe('observer evidence fusion', () => {
  it('prefers native evidence over process, filesystem and agent signals', () => {
    const ledger = new ObserverEvidenceLedger();
    ledger.record(evidence({ id: 'file', source: 'filesystem' }));
    ledger.record(evidence({ id: 'process', source: 'process', confidence: 0.5 }));
    const result = ledger.record(evidence({ id: 'native', source: 'native', confidence: 0.1 }));

    expect(result.accepted).toBe(true);
    expect(ledger.get('command:build')?.id).toBe('native');
  });

  it('uses confidence, timestamp and id as deterministic tie breakers', () => {
    expect(
      compareEvidence(
        evidence({ id: 'high', confidence: 0.8 }),
        evidence({ id: 'low', confidence: 0.2 }),
      ),
    ).toBeLessThan(0);
    expect(
      compareEvidence(
        evidence({ id: 'new', timestamp: 200 }),
        evidence({ id: 'old', timestamp: 100 }),
      ),
    ).toBeLessThan(0);
    expect(compareEvidence(evidence({ id: 'a' }), evidence({ id: 'b' }))).toBeLessThan(0);
  });

  it('deduplicates by key and validates bounded confidence', () => {
    const ledger = new ObserverEvidenceLedger();
    expect(ledger.record(evidence({ id: 'weak', confidence: 0.1 })).accepted).toBe(true);
    expect(ledger.record(evidence({ id: 'older', confidence: 0.1, timestamp: 1 })).accepted).toBe(
      false,
    );
    expect(ledger.list()).toHaveLength(1);
    expect(() => ledger.record(evidence({ confidence: 1.1 }))).toThrow(RangeError);
  });
});
