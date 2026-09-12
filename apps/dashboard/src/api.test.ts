import { describe, expect, it, vi } from 'vitest';

import { DashboardApi, DashboardApiError } from './api.js';

describe('DashboardApi', () => {
  it('builds typed session requests with filters', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: 'next' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787/', fetch: request });

    await expect(
      api.listSessions({ projectId: 'demo', status: 'running', limit: 10 }),
    ).resolves.toEqual({
      items: [],
      nextCursor: 'next',
    });
    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/sessions?project=demo&status=running&limit=10',
    );
  });

  it('supports session visibility and permanent deletion mutations', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'session/1', hidden: true, deleted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await api.listSessions({ includeHidden: true });
    await api.hideSession('session/1');
    await api.unhideSession('session/1');
    await api.deleteSession('session/1');

    expect(request).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8787/api/sessions?includeHidden=true',
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8787/api/sessions/session%2F1/hide',
      { method: 'POST' },
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:8787/api/sessions/session%2F1/unhide',
      { method: 'POST' },
    );
    expect(request).toHaveBeenNthCalledWith(4, 'http://127.0.0.1:8787/api/sessions/session%2F1', {
      method: 'DELETE',
    });
  });

  it('surfaces server error payloads without hiding their status', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'Missing session' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    const error = await api.getSession('missing').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DashboardApiError);
    expect(error).toMatchObject({ message: 'Missing session', status: 404 });
  });

  it('supports cursor-based event catch-up after a reconnect', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ items: [{ seq: 3, event: {} }], nextCursor: '3' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await api.listEvents('session/1', 2, 20);

    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/sessions/session%2F1/events?after=2&limit=20',
    );
  });

  it('loads turns for the selected session', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([{ id: 'turn-1', sequence: 1, status: 'running' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await expect(api.listTurns('session/1')).resolves.toMatchObject([
      { id: 'turn-1', sequence: 1, status: 'running' },
    ]);
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:8787/api/sessions/session%2F1/turns');
  });

  it('builds typed cursor-page requests for turns and evidence', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: 'next' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await api.listTurnPage('session/1', { limit: 2, cursor: 'turn-cursor' });
    await api.listObserverEvidencePage('session/1', { limit: 2, cursor: 'evidence-cursor' });
    await api.listTurnEvidencePage('turn/1', { limit: 2, cursor: 'turn-evidence-cursor' });
    await api.listTurnEvents('turn/1', 4, 2);

    expect(request).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8787/api/sessions/session%2F1/turns/page?limit=2&cursor=turn-cursor',
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8787/api/sessions/session%2F1/evidence/page?limit=2&cursor=evidence-cursor',
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:8787/api/turns/turn%2F1/evidence/page?limit=2&cursor=turn-evidence-cursor',
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:8787/api/turns/turn%2F1/events?after=4&limit=2',
    );
  });

  it('loads ETA snapshot history through the typed client', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([{ minSeconds: 30, maxSeconds: 120, confidence: 0.4, reasons: [] }]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await expect(api.listEtaSnapshots('session/1')).resolves.toHaveLength(1);
    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/sessions/session%2F1/eta-snapshots',
    );
  });

  it('loads observer evidence separately from the event timeline', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 'evidence-1',
            sessionId: 'session/1',
            key: 'file:app.ts',
            timestamp: 100,
            source: 'filesystem',
            kind: 'file',
            confidence: 0.65,
            reason: 'workspace change',
            payload: { path: 'app.ts' },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await expect(api.listObserverEvidence('session/1')).resolves.toHaveLength(1);
    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/sessions/session%2F1/evidence?limit=100',
    );
  });

  it('loads evidence scoped to a turn', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([{ id: 'evidence-1', turnId: 'turn/1' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await expect(api.listTurnEvidence('turn/1', 20)).resolves.toMatchObject([
      { id: 'evidence-1', turnId: 'turn/1' },
    ]);
    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/turns/turn%2F1/evidence?limit=20',
    );
  });
});
