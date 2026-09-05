export type ObserverEvidenceSource =
  'native' | 'process' | 'test_observer' | 'git' | 'filesystem' | 'agent';

export type ObserverEvidenceKind =
  'lifecycle' | 'command' | 'file' | 'verification' | 'workspace' | 'message';

export interface ObserverEvidence<T = unknown> {
  readonly id: string;
  readonly key: string;
  readonly timestamp: number;
  readonly source: ObserverEvidenceSource;
  readonly kind: ObserverEvidenceKind;
  readonly confidence: number;
  readonly reason: string;
  readonly payload: T;
}

export interface EvidenceRecordResult {
  readonly accepted: boolean;
  readonly selected: ObserverEvidence;
  readonly replaced?: ObserverEvidence;
}

export const EVIDENCE_PRIORITY: Readonly<Record<ObserverEvidenceSource, number>> = {
  native: 0,
  process: 1,
  test_observer: 1,
  git: 2,
  filesystem: 2,
  agent: 3,
};

export class ObserverEvidenceLedger {
  private readonly records = new Map<string, ObserverEvidence>();

  record<T>(evidence: ObserverEvidence<T>): EvidenceRecordResult {
    validateEvidence(evidence);
    const previous = this.records.get(evidence.key);
    if (previous === undefined) {
      this.records.set(evidence.key, evidence);
      return { accepted: true, selected: evidence };
    }
    const selected = compareEvidence(evidence, previous) < 0 ? evidence : previous;
    const accepted = selected.id === evidence.id;
    if (accepted) this.records.set(evidence.key, evidence);
    return {
      accepted,
      selected,
      ...(accepted ? { replaced: previous } : {}),
    };
  }

  recordMany(evidence: readonly ObserverEvidence[]): readonly EvidenceRecordResult[] {
    return evidence.map((item) => this.record(item));
  }

  get(key: string): ObserverEvidence | undefined {
    return this.records.get(key);
  }

  list(): readonly ObserverEvidence[] {
    return [...this.records.values()].sort(compareEvidence);
  }

  clear(): void {
    this.records.clear();
  }
}

/** Returns a negative value when left is the stronger evidence. */
export function compareEvidence(left: ObserverEvidence, right: ObserverEvidence): number {
  const priority = EVIDENCE_PRIORITY[left.source] - EVIDENCE_PRIORITY[right.source];
  if (priority !== 0) return priority;
  const confidence = right.confidence - left.confidence;
  if (confidence !== 0) return confidence;
  const timestamp = right.timestamp - left.timestamp;
  if (timestamp !== 0) return timestamp;
  return left.id.localeCompare(right.id);
}

function validateEvidence(evidence: ObserverEvidence): void {
  if (evidence.id.length === 0) throw new RangeError('Evidence id must not be empty.');
  if (evidence.key.length === 0) throw new RangeError('Evidence key must not be empty.');
  if (!Number.isFinite(evidence.timestamp) || evidence.timestamp < 0) {
    throw new RangeError('Evidence timestamp must be a non-negative finite number.');
  }
  if (!Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1) {
    throw new RangeError('Evidence confidence must be between 0 and 1.');
  }
  if (evidence.reason.length === 0) throw new RangeError('Evidence reason must not be empty.');
}
