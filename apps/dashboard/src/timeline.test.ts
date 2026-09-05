import { describe, expect, it } from 'vitest';

import type { StoredEvent } from '@agentscope/storage';

import { hasTimelineGap, lastTimelineSeq, mergeTimelineEvents } from './timeline.js';

function event(id: string, seq: number): StoredEvent {
  return {
    seq,
    event: {
      id,
      sessionId: 'session-1',
      timestamp: seq,
      type: 'agent_message',
      source: {
        provider: 'claude',
        client: 'claude-code',
        environment: 'test',
        adapter: 'claude-code',
      },
      payload: { summary: id },
      confidence: 0.9,
    },
  };
}

describe('timeline recovery helpers', () => {
  it('deduplicates by event id and keeps sequence order', () => {
    expect(
      mergeTimelineEvents(
        [event('one', 1), event('three', 3)],
        [event('two', 2), event('three', 3)],
      ),
    ).toEqual([event('one', 1), event('two', 2), event('three', 3)]);
    expect(lastTimelineSeq([event('one', 1), event('three', 3)])).toBe(3);
  });

  it('detects a sequence gap without treating the next event as a gap', () => {
    expect(hasTimelineGap(3, 4)).toBe(false);
    expect(hasTimelineGap(3, 6)).toBe(true);
  });
});
