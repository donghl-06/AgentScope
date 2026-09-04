import { describe, expect, it } from 'vitest';

import { listMockFixtures, MockAdapter } from './mock-adapter.js';

describe('MockAdapter', () => {
  it('exposes all deterministic V0 fixtures', () => {
    expect(listMockFixtures()).toEqual([
      'basic-success',
      'test-failure',
      'blocked-then-resumed',
      'interrupted',
      'low-signal',
    ]);
  });

  it('streams a successful fixture with deterministic timestamps', async () => {
    const adapter = new MockAdapter({
      fixture: 'basic-success',
      speed: 0,
      now: () => 1_700_000_000_000,
    });
    const session = await adapter.start({ sessionId: 'session-1', workspacePath: '.', args: [] });
    const events = [];
    for await (const event of session.events()) events.push(event);

    expect(events[0]).toMatchObject({ type: 'session_started', timestamp: 1_700_000_000_000 });
    expect(events.at(-1)).toMatchObject({
      type: 'session_finished',
      payload: { reason: 'completed', exitCode: 0 },
    });
    expect(events.map((event) => event.timestamp)).toEqual(
      [...events]
        .sort((left, right) => left.timestamp - right.timestamp)
        .map((event) => event.timestamp),
    );
  });

  it('supports low-signal and interrupted fixtures', async () => {
    const lowSignalAdapter = new MockAdapter({ fixture: 'low-signal', speed: 0 });
    expect(lowSignalAdapter.capabilities()).toMatchObject({
      structuredEvents: false,
      fileEvents: false,
      commandEvents: false,
      milestones: false,
    });
    expect(new MockAdapter().capabilities()).toMatchObject({
      structuredEvents: true,
      fileEvents: true,
      commandEvents: true,
      milestones: true,
    });

    const lowSignal = await lowSignalAdapter.start({
      sessionId: 'low',
      workspacePath: '.',
      args: [],
    });
    const interrupted = await new MockAdapter({ fixture: 'interrupted', speed: 0 }).start({
      sessionId: 'interrupted',
      workspacePath: '.',
      args: [],
    });
    const lowEvents = [];
    const interruptedEvents = [];
    for await (const event of lowSignal.events()) lowEvents.push(event);
    for await (const event of interrupted.events()) interruptedEvents.push(event);

    expect(lowEvents.some((event) => event.confidence < 1)).toBe(true);
    expect(interruptedEvents.at(-1)).toMatchObject({
      type: 'session_finished',
      payload: { reason: 'interrupted' },
    });
  });

  it('isolates subscriber errors and supports cleanup', async () => {
    const session = await new MockAdapter({ speed: 0 }).start({
      sessionId: 'session-1',
      workspacePath: '.',
      args: ['--fixture', 'test-failure'],
    });
    const received: string[] = [];
    const unsubscribe = session.subscribe(() => {
      throw new Error('subscriber failed');
    });
    session.subscribe((event) => {
      received.push(event.type);
    });
    for await (const event of session.events()) {
      // Drain the stream to verify cleanup and listener isolation.
      expect(event.sessionId).toBe('session-1');
    }

    expect(received.at(-1)).toBe('session_finished');
    unsubscribe();
    await session.detach();
    await session.stop();
  });
});
