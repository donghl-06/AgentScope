import { describe, expect, it, vi } from 'vitest';

import { EventBus, type EventListener } from './event-bus.js';

const event = {
  id: 'event-1',
  sessionId: 'session-1',
  timestamp: 1_700_000_000_000,
  source: { provider: 'mock', client: 'agentscope', environment: 'test', adapter: 'mock' },
  type: 'planning' as const,
  payload: { summary: 'plan' },
  confidence: 1,
};

describe('EventBus', () => {
  it('delivers events to global and matching session subscribers only', async () => {
    const bus = new EventBus();
    const global = vi.fn();
    const session = vi.fn();
    const otherSession = vi.fn();
    bus.subscribe(global);
    bus.subscribe(session, 'session-1');
    bus.subscribe(otherSession, 'session-2');

    const result = await bus.publish(event);

    expect(result).toEqual({ delivered: 2, errors: [] });
    expect(global).toHaveBeenCalledWith(event);
    expect(session).toHaveBeenCalledWith(event);
    expect(otherSession).not.toHaveBeenCalled();
  });

  it('supports unsubscribe and isolates listener errors', async () => {
    const bus = new EventBus();
    const failing: EventListener = () => {
      throw new Error('listener failed');
    };
    const healthy = vi.fn();
    const onListenerError = vi.fn();
    const unsubscribe = bus.subscribe(failing, 'session-1');
    bus.subscribe(healthy, 'session-1');
    const busWithDiagnostics = new EventBus({ onListenerError });
    busWithDiagnostics.subscribe(failing, 'session-1');
    busWithDiagnostics.subscribe(healthy, 'session-1');

    unsubscribe();
    const result = await bus.publish(event);
    const diagnosticResult = await busWithDiagnostics.publish(event);

    expect(result).toEqual({ delivered: 1, errors: [] });
    expect(diagnosticResult.delivered).toBe(2);
    expect(diagnosticResult.errors).toHaveLength(1);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(onListenerError).toHaveBeenCalledTimes(1);
  });

  it('clears subscriptions and rejects publishes after close', async () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    bus.close();

    await expect(bus.publish(event)).rejects.toThrow(/closed/);
    expect(listener).not.toHaveBeenCalled();
    expect(() => bus.subscribe(listener)).toThrow(/closed/);
  });
});
