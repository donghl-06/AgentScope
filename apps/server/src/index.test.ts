import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createInitialSessionState, createInitialTurnState } from '@agentscope/protocol';
import { openStorage, StorageRepository } from '@agentscope/storage';

import { createServer } from './index.js';
import { LiveHub, type LiveSocket } from './live-hub.js';
import { startServer } from './runtime.js';

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
    const app = createServer({ repository, recoverOnStart: false });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    expect((await app.inject('/healthz')).json()).toMatchObject({ status: 'ok' });
    const diagnostics = await app.inject('/api/diagnostics');
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.headers['x-request-id']).toBeDefined();
    expect(diagnostics.json()).toMatchObject({
      websocket: { clientCount: 0 },
      storage: { eventAppendAttempts: 1, eventAppendSuccesses: 1 },
    });
    expect((await app.inject('/api/sessions?project=project-1')).json()).toMatchObject({
      items: [{ id: 'session-1', status: 'running' }],
    });
    expect((await app.inject('/api/sessions/session-1/events')).json()).toMatchObject({
      items: [{ seq: 1, event: { id: 'event-1' } }],
    });
    const turn = createInitialTurnState('turn-1', 'session-1', 1, 1_700_000_000_200, {
      title: 'Inspect project',
      prompt: 'Inspect project files',
    });
    repository.createTurn({ state: { ...turn, status: 'running', startedAt: 1_700_000_000_201 } });
    expect((await app.inject('/api/sessions/session-1/turns')).json()).toMatchObject([
      { id: 'turn-1', sequence: 1, status: 'running', title: 'Inspect project' },
    ]);
    expect((await app.inject('/api/turns/turn-1')).json()).toMatchObject({
      id: 'turn-1',
      prompt: 'Inspect project files',
    });
    repository.appendEvent(
      {
        id: 'turn-event-1',
        sessionId: 'session-1',
        timestamp: 1_700_000_000_202,
        source,
        type: 'turn_started',
        payload: { turnId: 'turn-1', sequence: 1 },
        confidence: 1,
      },
      { ...state, status: 'running' },
    );
    expect((await app.inject('/api/turns/turn-1/events?limit=1')).json()).toMatchObject({
      items: [{ event: { id: 'turn-event-1', type: 'turn_started' } }],
    });
    repository.saveObserverEvidence({
      id: 'evidence-1',
      sessionId: 'session-1',
      key: 'file:app.ts',
      timestamp: 1_700_000_000_101,
      source: 'filesystem',
      kind: 'file',
      confidence: 0.65,
      reason: 'workspace change',
      payload: { path: 'app.ts', kind: 'modify' },
    });
    expect((await app.inject('/api/sessions/session-1/evidence')).json()).toMatchObject([
      { id: 'evidence-1', key: 'file:app.ts', source: 'filesystem' },
    ]);
    repository.saveObserverEvidence({
      id: 'evidence-turn-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      key: 'turn:file:app.ts',
      timestamp: 1_700_000_000_201,
      source: 'filesystem',
      kind: 'file',
      confidence: 0.65,
      reason: 'turn workspace change',
      payload: { path: 'app.ts', kind: 'modify' },
    });
    expect((await app.inject('/api/turns/turn-1/evidence')).json()).toMatchObject([
      { id: 'evidence-turn-1', turnId: 'turn-1' },
    ]);
    repository.saveEtaSnapshot('session-1', {
      minSeconds: 30,
      maxSeconds: 120,
      confidence: 0.4,
      reasons: [{ code: 'signal', message: 'Observed activity' }],
    });
    expect((await app.inject('/api/sessions/session-1/eta-snapshots')).json()).toMatchObject([
      { minSeconds: 30, maxSeconds: 120, confidence: 0.4 },
    ]);
    expect((await app.inject('/api/projects/project-1/overview')).json()).toMatchObject({
      projectId: 'project-1',
      active: 1,
      total: 1,
    });
  });

  it('serves cursor pages for turns and observer evidence', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const state = createInitialSessionState('session-pages', 1_700_000_000_000);
    repository.createSession({
      id: 'session-pages',
      provider: 'mock',
      adapter: 'mock',
      startedAt: state.startedAt,
      capabilities: {},
      state,
    });
    for (let index = 1; index <= 3; index += 1) {
      repository.createTurn({
        state: createInitialTurnState(
          `page-turn-${index}`,
          'session-pages',
          index,
          state.startedAt + index,
          { title: `Page task ${index}` },
        ),
      });
      repository.saveObserverEvidence({
        id: `page-evidence-${index}`,
        sessionId: 'session-pages',
        turnId: `page-turn-${index}`,
        key: `page:${index}`,
        timestamp: state.startedAt + index,
        source: 'process',
        kind: 'lifecycle',
        confidence: 1,
        reason: `Page evidence ${index}`,
        payload: { index },
      });
    }
    const app = createServer({ repository, recoverOnStart: false });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    const firstTurns = await app.inject('/api/sessions/session-pages/turns/page?limit=2');
    expect(firstTurns.statusCode).toBe(200);
    const firstTurnPage = firstTurns.json() as {
      items: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(firstTurnPage.items.map((item) => item.id)).toEqual(['page-turn-1', 'page-turn-2']);
    expect(firstTurnPage.nextCursor).toBeDefined();
    const secondTurns = await app.inject(
      `/api/sessions/session-pages/turns/page?limit=2&cursor=${encodeURIComponent(firstTurnPage.nextCursor!)}`,
    );
    expect(secondTurns.json()).toMatchObject({ items: [{ id: 'page-turn-3' }] });

    const firstEvidence = await app.inject('/api/sessions/session-pages/evidence/page?limit=2');
    expect(firstEvidence.statusCode).toBe(200);
    const firstEvidencePage = firstEvidence.json() as {
      items: Array<{ key: string }>;
      nextCursor?: string;
    };
    expect(firstEvidencePage.items.map((item) => item.key)).toEqual(['page:1', 'page:2']);
    const secondEvidence = await app.inject(
      `/api/sessions/session-pages/evidence/page?limit=2&cursor=${encodeURIComponent(firstEvidencePage.nextCursor!)}`,
    );
    expect(secondEvidence.json()).toMatchObject({ items: [{ key: 'page:3' }] });

    const turnEvidence = await app.inject('/api/turns/page-turn-2/evidence/page?limit=1');
    expect(turnEvidence.json()).toMatchObject({ items: [{ key: 'page:2' }] });
  });

  it('returns consistent errors for invalid queries and missing sessions', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const app = createServer({ repository: new StorageRepository(client), recoverOnStart: false });
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
    expect(invalid.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('hides and permanently deletes terminal sessions while protecting active ones', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const startedAt = 1_700_000_000_000;
    const completedState = {
      ...createInitialSessionState('cleanup-session', startedAt),
      status: 'completed' as const,
      endedAt: startedAt + 5_000,
    };
    repository.createSession({
      id: 'cleanup-session',
      provider: 'mock',
      adapter: 'mock',
      startedAt,
      capabilities: {},
      state: completedState,
    });
    repository.createSession({
      id: 'active-session',
      provider: 'mock',
      adapter: 'mock',
      startedAt,
      capabilities: {},
      state: createInitialSessionState('active-session', startedAt),
    });
    const hub = new LiveHub();
    const socket = new TestSocket();
    hub.attach(socket);
    const app = createServer({ repository, liveHub: hub, recoverOnStart: false });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    const hidden = await app.inject({ method: 'POST', url: '/api/sessions/cleanup-session/hide' });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toEqual({ id: 'cleanup-session', hidden: true });
    expect((await app.inject('/api/sessions')).json()).toMatchObject({
      items: [{ id: 'active-session' }],
    });
    const visibleWithHidden = (await app.inject('/api/sessions?includeHidden=true')).json() as {
      items: Array<{ id: string; hiddenAt?: number }>;
    };
    expect(visibleWithHidden.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'cleanup-session', hiddenAt: expect.any(Number) }),
      ]),
    );

    const restored = await app.inject({
      method: 'POST',
      url: '/api/sessions/cleanup-session/unhide',
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ id: 'cleanup-session', hidden: false });

    const activeDelete = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/active-session',
    });
    expect(activeDelete.statusCode).toBe(409);
    expect(activeDelete.json()).toMatchObject({ error: { code: 'conflict' } });

    const deleted = await app.inject({ method: 'DELETE', url: '/api/sessions/cleanup-session' });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: 'cleanup-session', deleted: true });
    expect(socket.messages.map((message) => JSON.parse(message))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'session.deleted', sessionId: 'cleanup-session' }),
      ]),
    );
    expect((await app.inject('/api/sessions/cleanup-session')).statusCode).toBe(404);
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
    const app = createServer({ repository, liveHub: hub, recoverOnStart: false });
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

  it('polls external SQLite writers and publishes their events to WebSocket clients', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-server-external-'));
    const filename = path.join(directory, 'session.db');
    const serverStorage = openStorage({ filename, migrate: true });
    const writerStorage = openStorage({ filename, migrate: false });
    const repository = new StorageRepository(serverStorage.client);
    const writer = new StorageRepository(writerStorage.client);
    const hub = new LiveHub();
    const socket = new TestSocket();
    hub.attach(socket);
    const app = createServer({
      repository,
      liveHub: hub,
      recoverOnStart: false,
      externalPollIntervalMs: 10,
    });
    openApps.push({
      close: async () => {
        await app.close();
        serverStorage.client.close();
        writerStorage.client.close();
        fs.rmSync(directory, { recursive: true, force: true });
      },
    });

    const state = createInitialSessionState('external-session', 1_700_000_000_000);
    writer.createSession({
      id: 'external-session',
      provider: 'mock',
      adapter: 'mock',
      startedAt: state.startedAt,
      capabilities: {},
      state,
    });
    writer.appendEvent(
      {
        id: 'external-event',
        sessionId: 'external-session',
        timestamp: state.startedAt + 100,
        source,
        type: 'planning',
        payload: { summary: 'external write' },
        confidence: 1,
      },
      { ...state, status: 'running' },
    );
    const externalTurn = createInitialTurnState(
      'external-turn',
      'external-session',
      1,
      state.startedAt + 200,
      { title: 'External turn' },
    );
    writer.createTurn({
      state: { ...externalTurn, status: 'running', startedAt: state.startedAt + 201 },
    });

    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const types = socket.messages.map((message) => JSON.parse(message).type);
      if (types.includes('event.appended') && types.includes('turn.created')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(socket.messages.map((message) => JSON.parse(message).type)).toEqual(
      expect.arrayContaining(['event.appended', 'turn.created']),
    );
    expect(socket.messages.map((message) => JSON.parse(message))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn.created',
          sessionId: 'external-session',
          payload: { turnId: 'external-turn', sequence: 1, status: 'running' },
        }),
      ]),
    );
    writer.updateTurnState(
      'external-turn',
      {
        ...externalTurn,
        status: 'completed',
        startedAt: state.startedAt + 201,
        endedAt: state.startedAt + 300,
      },
      state.startedAt + 300,
    );
    const updateDeadline = Date.now() + 1_000;
    while (Date.now() < updateDeadline) {
      if (
        socket.messages.some((message) => {
          const parsed = JSON.parse(message);
          return parsed.type === 'turn.updated' && parsed.payload?.status === 'completed';
        })
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(socket.messages.map((message) => JSON.parse(message))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn.updated',
          sessionId: 'external-session',
          payload: { turnId: 'external-turn', sequence: 1, status: 'completed' },
        }),
      ]),
    );
    const finishedDeadline = Date.now() + 1_000;
    while (Date.now() < finishedDeadline) {
      if (
        socket.messages.some((message) => {
          const parsed = JSON.parse(message);
          return parsed.type === 'turn.finished' && parsed.payload?.status === 'completed';
        })
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(socket.messages.map((message) => JSON.parse(message))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'turn.finished',
          sessionId: 'external-session',
          payload: { turnId: 'external-turn', sequence: 1, status: 'completed' },
        }),
      ]),
    );
  });

  it('does not publish a ghost event when the repository transaction fails', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const state = createInitialSessionState('session-1', 1_700_000_000_000);
    repository.createSession({
      id: 'session-1',
      provider: 'mock',
      adapter: 'mock',
      startedAt: state.startedAt,
      capabilities: {},
      state,
    });
    const hub = new LiveHub();
    const socket = new TestSocket();
    hub.attach(socket);
    const app = createServer({ repository, liveHub: hub, recoverOnStart: false });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });
    const event = {
      id: 'event-1',
      sessionId: 'session-1',
      timestamp: 1_700_000_000_100,
      source,
      type: 'planning' as const,
      payload: { summary: 'plan' },
      confidence: 1,
    };
    repository.appendEvent(event, { ...state, status: 'running' });
    const messagesAfterCommit = socket.messages.length;

    expect(() => repository.appendEvent(event, { ...state, status: 'running' })).toThrow();
    expect(socket.messages).toHaveLength(messagesAfterCommit);
  });

  it('recovers in-flight sessions during server startup', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const state = {
      ...createInitialSessionState('session-1', 1_700_000_000_000),
      status: 'running' as const,
    };
    repository.createSession({
      id: 'session-1',
      provider: 'mock',
      adapter: 'mock',
      startedAt: state.startedAt,
      capabilities: {},
      state,
    });
    const app = createServer({ repository });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    expect((await app.inject('/api/sessions/session-1')).json()).toMatchObject({
      status: 'interrupted',
      state: { status: 'interrupted' },
    });
  });

  it('reports projection drift before recovering in-flight sessions', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const state = createInitialSessionState('session-1', 1_700_000_000_000);
    repository.createSession({
      id: 'session-1',
      provider: 'mock',
      adapter: 'mock',
      startedAt: state.startedAt,
      capabilities: {},
      state: { ...state, status: 'running' },
    });
    const diagnostics: string[] = [];
    const app = createServer({
      repository,
      onProjectionMismatch: (diagnostic) => diagnostics.push(diagnostic.sessionId),
    });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    expect(diagnostics).toEqual(['session-1']);
    expect((await app.inject('/api/sessions/session-1')).json()).toMatchObject({
      status: 'interrupted',
    });
  });

  it('starts and closes the server together with its SQLite connection', async () => {
    const server = await startServer({
      filename: ':memory:',
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const response = await fetch(`${server.address}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok' });
    } finally {
      await server.close();
      await server.close();
    }
  });

  it('preserves history and recovers an in-flight session after server restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-server-restart-'));
    const filename = path.join(directory, 'session.db');
    const state = createInitialSessionState('session-restart', 1_700_000_000_000);
    try {
      const first = await startServer({ filename, host: '127.0.0.1', port: 0 });
      const writer = openStorage({ filename, migrate: false });
      const repository = new StorageRepository(writer.client);
      repository.createSession({
        id: 'session-restart',
        provider: 'mock',
        adapter: 'mock',
        startedAt: state.startedAt,
        capabilities: {},
        state: { ...state, status: 'running' },
      });
      repository.appendEvent(
        {
          id: 'restart-event',
          sessionId: 'session-restart',
          timestamp: state.startedAt + 100,
          source,
          type: 'planning',
          payload: { summary: 'persisted' },
          confidence: 1,
        },
        { ...state, status: 'running' },
      );
      repository.saveObserverEvidence({
        id: 'restart-evidence',
        sessionId: 'session-restart',
        key: 'process:42:started',
        timestamp: state.startedAt + 50,
        source: 'process',
        kind: 'lifecycle',
        confidence: 1,
        reason: 'Persisted before server restart.',
        payload: { pid: 42, kind: 'started' },
      });
      writer.client.close();
      await first.close();

      const second = await startServer({ filename, host: '127.0.0.1', port: 0 });
      try {
        const session = await fetch(`${second.address}/api/sessions/session-restart`).then(
          (response) => response.json(),
        );
        const events = await fetch(`${second.address}/api/sessions/session-restart/events`).then(
          (response) => response.json(),
        );
        const evidence = await fetch(
          `${second.address}/api/sessions/session-restart/evidence`,
        ).then((response) => response.json());
        expect(session).toMatchObject({ status: 'interrupted' });
        expect(events).toMatchObject({ items: [{ event: { id: 'restart-event' } }] });
        expect(evidence).toEqual([
          expect.objectContaining({ id: 'restart-evidence', key: 'process:42:started' }),
        ]);
      } finally {
        await second.close();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
