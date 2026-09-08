import type { StoredObserverEvidence, StoredTurn } from '@agentscope/storage';

const MAX_PARTS = 5;
const MAX_TEXT_LENGTH = 96;

/**
 * Associate observer evidence with a turn using its explicit ID whenever the
 * API provides one. Older long-lived server processes can decode the same
 * database row without exposing the newer turn_id column, so a timestamp
 * window is a safe compatibility fallback for evidence captured during that
 * turn.
 */
export function evidenceBelongsToTurn(
  evidence: StoredObserverEvidence,
  turn: Pick<StoredTurn, 'id' | 'submittedAt' | 'startedAt' | 'endedAt'>,
): boolean {
  if (evidence.turnId !== undefined) return evidence.turnId === turn.id;
  if (typeof evidence.payload === 'object' && evidence.payload !== null) {
    const payload = evidence.payload as { readonly turnId?: unknown };
    if (payload.turnId !== undefined) return payload.turnId === turn.id;
  }

  const start = turn.startedAt ?? turn.submittedAt;
  const end = turn.endedAt ?? Number.POSITIVE_INFINITY;
  return evidence.timestamp >= start && evidence.timestamp <= end;
}

/** Return a compact, non-transcript summary of known observer payload fields. */
export function evidencePayloadSummary(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const parts: string[] = [];

  addText(parts, 'path', record.path);
  addText(parts, 'change', record.kind);
  addText(parts, 'command', record.commandName);
  addText(parts, 'outcome', record.outcome);
  addText(parts, 'verification', record.verification);
  addNumber(parts, 'exitCode', record.exitCode);
  addNumber(parts, 'pid', record.pid);
  addText(parts, 'branch', record.branch);
  addText(parts, 'state', record.state);
  addList(parts, 'added', record.added);
  addList(parts, 'modified', record.modified);
  addList(parts, 'deleted', record.deleted);
  addCount(parts, 'files', record.files);
  addCount(parts, 'diffs', record.diffStat);

  return parts.length === 0 ? undefined : parts.slice(0, MAX_PARTS).join(' · ');
}

function addText(parts: string[], label: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) return;
  parts.push(`${label}: ${redact(value)}`);
}

function addNumber(parts: string[], label: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  parts.push(`${label}: ${value}`);
}

function addList(parts: string[], label: string, value: unknown): void {
  if (!Array.isArray(value)) return;
  const entries = value.filter((item): item is string => typeof item === 'string');
  if (entries.length === 0) return;
  const shown = entries.slice(0, 3).map(redact).join(', ');
  const suffix = entries.length > 3 ? ` (+${entries.length - 3})` : '';
  parts.push(`${label}: ${shown}${suffix}`);
}

function addCount(parts: string[], label: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) return;
  parts.push(`${label}: ${value.length}`);
}

function redact(value: string): string {
  const redacted = value
    .replace(/\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/gu, '[REDACTED]')
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, (match) =>
      match.replace(/([:=]\s*)[^\s,;]+$/u, '$1[REDACTED]'),
    );
  return redacted.length <= MAX_TEXT_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_TEXT_LENGTH - 3)}...`;
}
