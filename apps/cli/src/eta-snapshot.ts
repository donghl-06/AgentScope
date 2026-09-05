import type { AgentEventType, EtaResult } from '@agentscope/protocol';

const SNAPSHOT_EVENT_TYPES = new Set<AgentEventType>([
  'session_started',
  'session_finished',
  'blocked',
  'unblocked',
  'test_passed',
  'test_failed',
  'milestone_completed',
]);

/**
 * ETA history is a user-facing trend, not an event log. Persist terminal and
 * verification transitions, plus one initial sample, while leaving noisy file
 * and tool events out of the snapshot table.
 */
export function shouldPersistEtaSnapshot(
  eventType: AgentEventType,
  previous: EtaResult | undefined,
): boolean {
  return previous === undefined || SNAPSHOT_EVENT_TYPES.has(eventType);
}
