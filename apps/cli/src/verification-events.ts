import { type AgentEvent, type EventSource } from '@agentscope/protocol';
import type { ObserverEvidence } from '@agentscope/observer-runtime';

const VERIFICATION_KINDS = new Set(['test', 'build', 'lint', 'typecheck']);

/**
 * Convert safe TestObserver evidence into the shared verification events.
 * Command text is reduced to its classified kind; the raw command is never
 * copied into the event payload.
 */
export function createVerificationEvent(
  sessionId: string,
  source: EventSource,
  evidence: ObserverEvidence,
): AgentEvent | undefined {
  if (evidence.source !== 'test_observer') return undefined;
  if (!isRecord(evidence.payload)) return undefined;
  const kind = stringValue(evidence.payload.kind);
  if (kind === undefined || !VERIFICATION_KINDS.has(kind)) return undefined;
  const timestamp = evidence.timestamp;
  const payloadBase = { testKind: kind };
  if (evidence.kind === 'command') {
    return {
      id: `${evidence.id}:verification-started`,
      sessionId,
      timestamp,
      source,
      type: 'test_started',
      payload: payloadBase,
      confidence: evidence.confidence,
    };
  }
  if (evidence.kind !== 'verification') return undefined;
  const outcome = stringValue(evidence.payload.outcome);
  const durationMs = numberValue(evidence.payload.durationMs);
  if (outcome === 'passed') {
    return {
      id: `${evidence.id}:verification-passed`,
      sessionId,
      timestamp,
      source,
      type: 'test_passed',
      payload: {
        ...payloadBase,
        ...(durationMs === undefined ? {} : { durationMs }),
      },
      confidence: evidence.confidence,
    };
  }
  if (outcome === 'failed') {
    return {
      id: `${evidence.id}:verification-failed`,
      sessionId,
      timestamp,
      source,
      type: 'test_failed',
      payload: {
        ...payloadBase,
        ...(durationMs === undefined ? {} : { durationMs }),
        failureSummary: 'Verification command failed.',
      },
      confidence: evidence.confidence,
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
