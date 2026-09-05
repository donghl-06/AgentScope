import { describe, expect, it } from 'vitest';

import { formatServerJson, ServerClient, type CliServerError } from './server-client.js';

describe('server client', () => {
  it('builds typed session and event requests with cursor parameters', async () => {
    const requests: string[] = [];
    const client = new ServerClient({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input) => {
        requests.push(input.toString());
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
    });

    await client.listSessions({ projectId: 'project 1', limit: 10 });
    await client.getSession('session/1');
    await client.listEvents('session/1', 4, 20);

    expect(requests).toEqual([
      'http://127.0.0.1:3210/api/sessions?project=project+1&limit=10',
      'http://127.0.0.1:3210/api/sessions/session%2F1',
      'http://127.0.0.1:3210/api/sessions/session%2F1/events?after=4&limit=20',
    ]);
  });

  it('maps HTTP and network failures to a stable CLI error', async () => {
    const httpClient = new ServerClient({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 }),
    });
    await expect(httpClient.getSession('missing')).rejects.toMatchObject({
      name: 'CliServerError',
      status: 404,
    } satisfies Partial<CliServerError>);

    const networkClient = new ServerClient({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async () => {
        throw new Error('offline');
      },
    });
    await expect(networkClient.listSessions()).rejects.toMatchObject({ status: 0 });
  });

  it('formats non-interactive JSON output with a trailing newline', () => {
    expect(formatServerJson({ status: 'ok' })).toBe('{\n  "status": "ok"\n}\n');
  });
});
