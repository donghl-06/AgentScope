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

  it('builds Goal instruction and Continue requests without touching the database', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new ServerClient({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init });
        return new Response(
          JSON.stringify({ goalId: 'goal-1', instruction: { id: 'instruction-1' } }),
          {
            status: 201,
          },
        );
      },
    });

    await client.listGoals({ limit: 10 });
    await client.getGoal('goal/1');
    await client.listInstructions('goal/1', { status: 'PENDING', limit: 5 });
    await client.submitInstruction('goal/1', {
      kind: 'constraint',
      content: 'Keep the change local.',
      idempotencyKey: 'instruction-1',
    });
    await client.continueGoal('goal/1', {
      confirmExternalProcessStopped: true,
      idempotencyKey: 'continue-1',
    });

    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:3210/api/goals?limit=10',
      'http://127.0.0.1:3210/api/goals/goal%2F1',
      'http://127.0.0.1:3210/api/goals/goal%2F1/instructions?status=PENDING&limit=5',
      'http://127.0.0.1:3210/api/goals/goal%2F1/instructions',
      'http://127.0.0.1:3210/api/goals/goal%2F1/continue',
    ]);
    expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({
      kind: 'constraint',
      content: 'Keep the change local.',
      idempotencyKey: 'instruction-1',
    });
    expect(JSON.parse(String(requests[4]?.init?.body))).toEqual({
      confirmExternalProcessStopped: true,
      idempotencyKey: 'continue-1',
    });
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
