import { describe, expect, it, vi } from 'vitest';

import { EventBus } from './event-bus.js';
import { EventIngestionPipeline, type SequencedAgentEvent } from './event-ingestion.js';

const source = { provider: 'mock', client: 'agentscope', environment: 'test', adapter: 'mock' };

function event(id: string, timestamp = 1_700_000_000_000) {
  return {
    id,
    sessionId: 'session-1',
    timestamp,
    source,
    type: 'planning' as const,
    payload: { summary: id },
    confidence: 1,
  };
}

function createPipeline(persist: (item: SequencedAgentEvent) => Promise<void> = async () => {}) {
  const bus = new EventBus();
  const persisted: SequencedAgentEvent[] = [];
  const pipeline = new EventIngestionPipeline({
    bus,
    hasSession: (sessionId) => sessionId === 'session-1',
    persist: async (item) => {
      persisted.push(item);
      await persist(item);
    },
    now: () => 1_700_000_000_000,
    maxFutureSkewMs: 1_000,
  });
  return { bus, pipeline, persisted };
}

describe('EventIngestionPipeline', () => {
  it('persists before publishing and assigns a monotonic sequence', async () => {
    const order: string[] = [];
    const bus = new EventBus();
    bus.subscribe(() => {
      order.push('published');
    });
    const persisted: SequencedAgentEvent[] = [];
    const pipeline = new EventIngestionPipeline({
      bus,
      hasSession: () => true,
      persist: async (item) => {
        persisted.push(item);
        order.push('persisted');
      },
      now: () => 1_700_000_000_000,
    });

    const result = await pipeline.ingest(event('event-1'));

    expect(result.accepted).toBe(true);
    expect(persisted[0]?.seq).toBe(1);
    expect(order).toEqual(['persisted', 'published']);
  });

  it('rejects unknown sessions, invalid timestamps, and duplicate ids', async () => {
    const { pipeline, persisted } = createPipeline();

    const unknownSession = await pipeline.ingest({ ...event('unknown'), sessionId: 'other' });
    expect(unknownSession).toMatchObject({ accepted: false, reason: 'unknown_session' });
    const future = await pipeline.ingest(event('future', 1_700_000_002_000));
    expect(future).toMatchObject({ accepted: false, reason: 'invalid_timestamp' });
    expect((await pipeline.ingest(event('event-1'))).accepted).toBe(true);
    const duplicate = await pipeline.ingest(event('event-1', 1_699_999_999_000));
    expect(duplicate).toMatchObject({ accepted: false, reason: 'duplicate_event_id' });
    expect(persisted).toHaveLength(1);
  });

  it('serializes concurrent events per session and preserves out-of-order timestamps', async () => {
    const persist = vi.fn(async () => {});
    const { pipeline, persisted } = createPipeline(persist);
    const [first, second] = await Promise.all([
      pipeline.ingest(event('first', 1_700_000_000_000)),
      pipeline.ingest(event('second', 1_699_999_999_000)),
    ]);

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(persisted.map((item) => item.seq)).toEqual([1, 2]);
    expect(persisted.map((item) => item.id)).toEqual(['first', 'second']);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('does not reserve an id or sequence when persistence fails', async () => {
    let fail = true;
    const { pipeline, persisted } = createPipeline(async () => {
      if (fail) {
        fail = false;
        throw new Error('storage unavailable');
      }
    });

    await expect(pipeline.ingest(event('retry'))).rejects.toThrow('storage unavailable');
    const retry = await pipeline.ingest(event('retry'));

    expect(retry.accepted).toBe(true);
    expect(persisted.map((item) => item.seq)).toEqual([1, 1]);
  });
});
