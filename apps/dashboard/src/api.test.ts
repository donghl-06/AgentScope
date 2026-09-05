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
});
