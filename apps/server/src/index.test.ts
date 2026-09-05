import { afterEach, describe, expect, it } from 'vitest';

import { createInitialSessionState } from '@agentscope/protocol';
import { openStorage, StorageRepository } from '@agentscope/storage';

import { createServer } from './index.js';
import { LiveHub, type LiveSocket } from './live-hub.js';

const source = { provider: 'mock', client: 'agentscope', environment: 'test', adapter: 'mock' };
const openApps: Array<{ close: () => Promise<void> }> = [];

class TestSocket implements LiveSocket {
  readonly messages: string[] = [];
  send(payload: string): void {
    this.messages.push(payload);
  }
}

afterEach(async () => {
  while (openApps.length > 0) await openApps.pop()?.close();
});

describe('server HTTP API', () => {
  it('serves health, sessions, events, and project overview', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const state = createInitialSessionState('session-1', 1_700_000_000_000);
    repository.createSession({
      id: 'session-1',
      projectId: 'project-1',
      provider: 'mock',
      adapter: 'mock',
      startedAt: state.startedAt,
      capabilities: { structuredEvents: true },
      state,
    });
    repository.appendEvent(
      {
        id: 'event-1',
        sessionId: 'session-1',
        timestamp: 1_700_000_000_100,
        source,
        type: 'planning',
        payload: { summary: 'plan' },
        confidence: 1,
      },
      { ...state, status: 'running' },
    );
    const app = createServer({ repository });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    expect((await app.inject('/healthz')).json()).toMatchObject({ status: 'ok' });
    expect((await app.inject('/api/sessions?project=project-1')).json()).toMatchObject({
      items: [{ id: 'session-1', status: 'running' }],
    });
    expect((await app.inject('/api/sessions/session-1/events')).json()).toMatchObject({
      items: [{ seq: 1, event: { id: 'event-1' } }],
    });
    expect((await app.inject('/api/projects/project-1/overview')).json()).toMatchObject({
      projectId: 'project-1',
      active: 1,
      total: 1,
    });
  });

  it('returns consistent errors for invalid queries and missing sessions', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const app = createServer({ repository: new StorageRepository(client) });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    const missing = await app.inject('/api/sessions/missing');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: 'not_found', message: 'Session not found: missing' },
    });
    const invalid = await app.inject('/api/sessions?limit=0');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'invalid_query' } });
  });

  it('publishes only committed repository events to the live hub', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const state = createInitialSessionState('session-1', 1_700_000_000_000);
    repository.createSession({
      id: 'session-1',
      projectId: 'project-1',
      provider: 'mock',
      adapter: 'mock',
      startedAt: state.startedAt,
      capabilities: {},
      state,
    });
    const hub = new LiveHub();
    const socket = new TestSocket();
    hub.attach(socket);
    const app = createServer({ repository, liveHub: hub });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    repository.appendEvent(
      {
        id: 'event-1',
        sessionId: 'session-1',
        timestamp: 1_700_000_000_100,
        source,
        type: 'planning',
        payload: { summary: 'plan' },
        confidence: 1,
      },
      { ...state, status: 'running' },
    );

    expect(JSON.parse(socket.messages.at(-1)!)).toMatchObject({
      type: 'event.appended',
      sessionId: 'session-1',
      projectId: 'project-1',
      seq: 1,
      cursor: '1',
    });
  });
});
