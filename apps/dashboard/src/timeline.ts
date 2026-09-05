import type { StoredEvent } from '@agentscope/storage';

export function mergeTimelineEvents(
  existing: readonly StoredEvent[],
  incoming: readonly StoredEvent[],
): readonly StoredEvent[] {
  const byId = new Map<string, StoredEvent>();
  for (const stored of existing) byId.set(stored.event.id, stored);
  for (const stored of incoming) byId.set(stored.event.id, stored);
  return [...byId.values()].sort((left, right) => left.seq - right.seq);
}

export function lastTimelineSeq(events: readonly StoredEvent[]): number {
  return events.reduce((last, stored) => Math.max(last, stored.seq), 0);
}

export function hasTimelineGap(lastSeq: number, nextSeq: number): boolean {
  return nextSeq > lastSeq + 1;
}
