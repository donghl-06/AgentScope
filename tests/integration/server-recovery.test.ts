import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createInitialSessionState,
  type AgentEvent,
  type SessionState,
} from '../../packages/protocol/src/index.js';
import { openStorage, StorageRepository } from '../../packages/storage/src/index.js';

import { createServer } from '../../apps/server/src/index.js';

const source = { provider: 'mock', client: 'agentscope', environment: 'test', adapter: 'mock' };
const openResources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (openResources.length > 0) await openResources.pop()?.();
});

function event(id: string, type: AgentEvent['type'] = 'planning'): AgentEvent {
  return {
    id,
    sessionId: 'session-1',
    timestamp: 1_700_000_000_100,
    source,
    type,
    payload: type === 'planning' ? { summary: id } : { reason: 'completed' },
    confidence: 1,
  };
}

function terminalState(): SessionState {
  return {
    ...createInitialSessionState('session-1', 1_700_000_000_000),
    status: 'completed',
    endedAt: 1_700_000_000_200,
  };
}

async function startServer(repository: StorageRepository) {
  const app = createServer({ repository });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };
  openResources.push(close);
  return { app, baseUrl: address, close };
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      socket.off('error', onError);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    };
    const onError = (error: Error) => {
      socket.off('message', onMessage);
      reject(error);
    };
    socket.once('message', onMessage);
    socket.once('error', onError);
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

async function openSocket(url: string): Promise<{
  socket: WebSocket;
  firstMessage: Record<string, unknown>;
}> {
  const socket = new WebSocket(url);
  const firstMessage = nextMessage(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        reject(new Error(`WebSocket upgrade failed with ${response.statusCode}: ${body}`));
      });
    });
  });
  return { socket, firstMessage: await firstMessage };
}

describe('server recovery integration', () => {
  it('persists a timeline across storage close and server restart', async () => {
    const filename = path.join(os.tmpdir(), `agentscope-e2e-${Date.now()}-${Math.random()}.db`);
    const first = openStorage({ filename, migrate: true });
    const repository = new StorageRepository(first.client);
    const state = terminalState();
    repository.createSession({
      id: 'session-1',
      projectId: 'project-1',
      provider: 'mock',
      adapter: 'mock',
      startedAt: state.startedAt,
      capabilities: { structuredEvents: true },
      state: createInitialSessionState('session-1', state.startedAt),
    });
    const runningState: SessionState = { ...state, status: 'running' };
    repository.appendEvent(event('event-1'), runningState);
    repository.appendEvent(event('event-2', 'session_finished'), state);
    const firstServer = await startServer(repository);
    await firstServer.close();
    first.client.close();

    const second = openStorage({ filename, migrate: true });
    const secondServer = await startServer(new StorageRepository(second.client));
    const response = await fetch(`${secondServer.baseUrl}/api/sessions/session-1/events`);
    const body = (await response.json()) as { items: Array<{ seq: number; event: AgentEvent }> };

    expect(response.status).toBe(200);
    expect(body.items.map((item) => item.seq)).toEqual([1, 2]);
    expect(body.items[1]?.event.type).toBe('session_finished');

    await secondServer.close();
    second.client.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(filename + suffix);
      } catch {
        // Best-effort cleanup for SQLite sidecar files.
      }
    }
  });

  it('uses HTTP cursor catch-up after a WebSocket disconnect', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    openResources.push(async () => client.close());
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
    const server = await startServer(repository);
    const firstConnection = await openSocket(`${server.baseUrl.replace('http', 'ws')}/ws`);
    const socket = firstConnection.socket;
    expect(firstConnection.firstMessage).toMatchObject({ type: 'hello', protocolVersion: '0.1' });
    socket.send(JSON.stringify({ type: 'subscribe', sessionIds: ['session-1'] }));
    expect(await nextMessage(socket)).toMatchObject({ type: 'subscribed' });

    const runningState: SessionState = { ...state, status: 'running' };
    repository.appendEvent(event('event-1'), runningState);
    expect(await nextMessage(socket)).toMatchObject({ type: 'event.appended', seq: 1 });
    await closeSocket(socket);

    repository.appendEvent(event('event-2'), { ...state, status: 'running' });
    const secondConnection = await openSocket(`${server.baseUrl.replace('http', 'ws')}/ws`);
    const secondSocket = secondConnection.socket;
    expect(secondConnection.firstMessage).toMatchObject({ type: 'hello', protocolVersion: '0.1' });
    const response = await fetch(`${server.baseUrl}/api/sessions/session-1/events?after=1`);
    const body = (await response.json()) as { items: Array<{ seq: number }> };

    expect(body.items.map((item) => item.seq)).toEqual([2]);
    await closeSocket(secondSocket);
  });

  it('returns stable errors for invalid requests, missing sessions, and a closed database', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    let clientClosed = false;
    const closeClient = async () => {
      if (clientClosed) return;
      clientClosed = true;
      client.close();
    };
    openResources.push(closeClient);
    const repository = new StorageRepository(client);
    const server = await startServer(repository);

    const invalid = await fetch(`${server.baseUrl}/api/sessions?limit=0`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const missing = await fetch(`${server.baseUrl}/api/sessions/missing/events`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } });

    await closeClient();
    const unavailable = await fetch(`${server.baseUrl}/api/sessions`);
    expect(unavailable.status).toBe(500);
    expect(await unavailable.json()).toMatchObject({ error: { code: 'internal_error' } });
  });

  it('assigns unique ordered sequences across two SQLite repository connections', async () => {
    const filename = path.join(
      os.tmpdir(),
      `agentscope-concurrent-${Date.now()}-${Math.random()}.db`,
    );
    const first = openStorage({ filename, migrate: true });
    const second = openStorage({ filename, migrate: true });
    openResources.push(async () => first.client.close());
    openResources.push(async () => second.client.close());
    openResources.push(async () => {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(filename + suffix);
        } catch {
          // Best-effort cleanup for SQLite sidecar files.
        }
      }
    });
    const firstRepository = new StorageRepository(first.client);
    const secondRepository = new StorageRepository(second.client);
    const state = createInitialSessionState('session-1', 1_700_000_000_000);
    firstRepository.createSession({
      id: 'session-1',
      provider: 'mock',
      adapter: 'mock',
      startedAt: state.startedAt,
      capabilities: {},
      state,
    });
    const runningState: SessionState = { ...state, status: 'running' };
    const repositories = [firstRepository, secondRepository];

    await Promise.all(
      Array.from({ length: 16 }, (_, index) => {
        const repository = repositories[index % repositories.length]!;
        return Promise.resolve().then(() =>
          repository.appendEvent(event(`event-${index}`), runningState),
        );
      }),
    );

    const sequences = firstRepository.listEvents('session-1').items;
    expect(sequences.map((item) => item.seq)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(new Set(sequences.map((item) => item.event.id)).size).toBe(16);
  });
});
