import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { startServer } from '@agentscope/server/runtime';

import { runMockFixture } from './mock-runner.js';

describe('mock backend e2e', () => {
  it('runs two sessions concurrently and exposes durable overview and timeline data', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-e2e-'));
    const filename = path.join(directory, 'agentscope.db');
    const server = await startServer({ filename, host: '127.0.0.1', port: 0 });
    try {
      const [success, failure] = await Promise.all([
        runMockFixture({
          filename,
          fixture: 'basic-success',
          sessionId: 'e2e-success',
          projectId: 'e2e-project',
          workspacePath: directory,
          speed: 0,
          now: () => 1_700_000_000_000,
        }),
        runMockFixture({
          filename,
          fixture: 'test-failure',
          sessionId: 'e2e-failure',
          projectId: 'e2e-project',
          workspacePath: directory,
          speed: 0,
          now: () => 1_700_000_000_000,
        }),
      ]);

      expect(success).toMatchObject({ status: 'completed', exitCode: 0 });
      expect(failure).toMatchObject({ status: 'failed', exitCode: 1 });

      const overview = await fetch(`${server.address}/api/projects/e2e-project/overview`);
      expect(overview.status).toBe(200);
      expect(await overview.json()).toMatchObject({
        projectId: 'e2e-project',
        completed: 1,
        failed: 1,
        total: 2,
      });

      const sessions = await fetch(`${server.address}/api/sessions?project=e2e-project`);
      expect(sessions.status).toBe(200);
      expect(asPage(await sessions.json()).items).toHaveLength(2);

      const timeline = await fetch(`${server.address}/api/sessions/e2e-success/events?after=0`);
      const timelineBody = asPage(await timeline.json());
      expect(timeline.status).toBe(200);
      expect(timelineBody.items.length).toBe(success.eventCount);
      expect(timelineBody.items.at(-1)?.event?.type).toBe('session_finished');

      const session = await fetch(`${server.address}/api/sessions/e2e-success`).then(
        (response) => response.json(),
      );
      expect(session).toMatchObject({
        id: 'e2e-success',
        state: {
          status: 'completed',
          progress: { value: expect.any(Number), confidence: expect.any(Number) },
          eta: { minSeconds: expect.any(Number), maxSeconds: expect.any(Number) },
        },
      });

      const evidence = await fetch(`${server.address}/api/sessions/e2e-success/evidence`).then(
        (response) => response.json(),
      );
      expect(evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'git', kind: 'workspace' }),
        ]),
      );
    } finally {
      await server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

function asPage(value: unknown): {
  readonly items: readonly { readonly event?: { readonly type?: unknown } }[];
} {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { items?: unknown }).items)
  ) {
    throw new Error('Expected a page response.');
  }
  return value as { readonly items: readonly { readonly event?: { readonly type?: unknown } }[] };
}
