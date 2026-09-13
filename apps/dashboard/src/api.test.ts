import { describe, expect, it, vi } from 'vitest';

import { DashboardApi, DashboardApiError } from './api.js';

describe('DashboardApi', () => {
  it('loads orchestrator goals', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([{ id: 'goal-1', status: 'RUNNING' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await expect(api.listGoals(20)).resolves.toMatchObject([{ id: 'goal-1', status: 'RUNNING' }]);
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:8787/api/goals?limit=20');
  });

  it('loads paginated Goal history with server-side filters', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ items: [{ id: 'goal-1' }], nextCursor: 'next' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await expect(
      api.listGoalPage({
        status: 'FAILED',
        provider: 'claude',
        workspace: 'D:/workspace',
        query: 'release',
        includeArchived: true,
        limit: 20,
        cursor: 'page-1',
      }),
    ).resolves.toMatchObject({ items: [{ id: 'goal-1' }], nextCursor: 'next' });
    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/goals/page?status=FAILED&provider=claude&workspace=D%3A%2Fworkspace&query=release&includeArchived=true&limit=20&cursor=page-1',
    );
  });

  it('submits an orchestrator goal without starting a provider in the browser', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ goalId: 'goal-1', goal: { id: 'goal-1' } }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await expect(
      api.createGoal({ workspace: 'D:/workspace', prompt: 'Inspect safely', provider: 'claude' }),
    ).resolves.toMatchObject({ goalId: 'goal-1' });
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:8787/api/goals', {
      method: 'POST',
      body: JSON.stringify({
        workspace: 'D:/workspace',
        prompt: 'Inspect safely',
        provider: 'claude',
      }),
      headers: { 'content-type': 'application/json' },
    });
  });

  it('loads Goal details and uses server-side control endpoints', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ goal: { id: 'goal-1' }, tasks: [], events: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ goal: { id: 'goal-1' }, requested: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await api.getGoal('goal/1');
    await api.pauseGoal('goal/1');
    await api.abortGoal('goal/1');
    await api.continueGoal('goal/1');

    expect(request).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:8787/api/goals/goal%2F1');
    expect(request).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8787/api/goals/goal%2F1/pause', {
      method: 'POST',
    });
    expect(request).toHaveBeenNthCalledWith(3, 'http://127.0.0.1:8787/api/goals/goal%2F1/abort', {
      method: 'POST',
    });
    expect(request).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:8787/api/goals/goal%2F1/continue',
      { method: 'POST' },
    );
  });

  it('loads durable Goal metric snapshots through the server DTO', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([{ id: 'metric-1', goalId: 'goal-1', progress: 0.5 }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await expect(api.listGoalMetrics('goal/1', 20)).resolves.toMatchObject([
      { id: 'metric-1', progress: 0.5 },
    ]);
    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/goals/goal%2F1/metrics?limit=20',
    );
  });

  it('loads actionable Goal notifications with an optional status filter', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([{ id: 'notification-1', goalId: 'goal-1', status: 'PENDING' }]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await expect(api.listGoalNotifications('goal/1', 20)).resolves.toMatchObject([
      { id: 'notification-1', status: 'PENDING' },
    ]);
    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/goals/goal%2F1/notifications?limit=20',
    );
  });

  it('loads and submits Goal instructions with revision guards', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'instruction-1', status: 'PENDING' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            goalId: 'goal-1',
            instruction: { id: 'instruction-1', status: 'PENDING' },
            idempotencyKey: 'instruction-request-1',
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await expect(
      api.listGoalInstructions('goal/1', { status: 'PENDING', limit: 20 }),
    ).resolves.toMatchObject([{ id: 'instruction-1', status: 'PENDING' }]);
    await expect(
      api.submitGoalInstruction('goal/1', {
        kind: 'constraint',
        content: 'Keep the migration backwards compatible.\nDo not change the public API.',
        baseRevision: 3,
        expectedRevision: 3,
        idempotencyKey: 'instruction-request-1',
      }),
    ).resolves.toMatchObject({ goalId: 'goal-1', instruction: { id: 'instruction-1' } });

    expect(request).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8787/api/goals/goal%2F1/instructions?status=PENDING&limit=20',
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8787/api/goals/goal%2F1/instructions',
      {
        method: 'POST',
        body: JSON.stringify({
          kind: 'constraint',
          content: 'Keep the migration backwards compatible.\nDo not change the public API.',
          baseRevision: 3,
          expectedRevision: 3,
          idempotencyKey: 'instruction-request-1',
        }),
        headers: { 'content-type': 'application/json' },
      },
    );
  });

  it('exposes revision-safe roadmap mutation endpoints', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ goal: { id: 'goal-1' }, task: { id: 'task-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await api.listGoalRoadmapRevisions('goal/1', 20);
    await api.updateGoalTask('goal/1', 'task/1', {
      patch: { objective: 'Updated objective' },
      reason: 'Clarify the future Task.',
      expectedRevision: 3,
      idempotencyKey: 'edit-1',
    });
    await api.insertGoalTask('goal/1', {
      title: 'New future Task',
      objective: 'Add the missing check.',
      acceptanceCriteria: ['The check is recorded.'],
      reason: 'Add a verification step.',
      expectedRevision: 4,
      idempotencyKey: 'insert-1',
    });
    await api.skipGoalTask('goal/1', 'task/1', {
      reason: 'The future Task is no longer needed.',
      expectedRevision: 5,
      idempotencyKey: 'skip-1',
    });
    await api.reorderGoalTasks('goal/1', {
      taskIds: ['task-2', 'task-1'],
      reason: 'Run the independent check first.',
      expectedRevision: 6,
      idempotencyKey: 'reorder-1',
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8787/api/goals/goal%2F1/roadmap/revisions?limit=20',
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8787/api/goals/goal%2F1/tasks/task%2F1',
      {
        method: 'PATCH',
        body: JSON.stringify({
          patch: { objective: 'Updated objective' },
          reason: 'Clarify the future Task.',
          expectedRevision: 3,
          idempotencyKey: 'edit-1',
        }),
        headers: { 'content-type': 'application/json' },
      },
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:8787/api/goals/goal%2F1/tasks',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:8787/api/goals/goal%2F1/tasks/task%2F1/skip',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(request).toHaveBeenNthCalledWith(
      5,
      'http://127.0.0.1:8787/api/goals/goal%2F1/roadmap/reorder',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('exposes recovery and approval controls with explicit request bodies', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'approval-1', status: 'APPROVED' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await api.listGoalApprovals('goal/1', { status: 'PENDING', limit: 20 });
    await api.approveGoalApproval('goal/1', 'approval/1', 'Approve the exact bounded scope.');
    await api.rejectGoalApproval('goal/1', 'approval/1', 'The requested scope is not needed.');
    await api.retryGoalTask('goal/1', 'task/1', {
      reason: 'Retry after the failed verification.',
      confirmExternalProcessStopped: true,
      idempotencyKey: 'retry-1',
    });
    await api.continueGoal('goal/1', {
      confirmExternalProcessStopped: true,
      idempotencyKey: 'continue-1',
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8787/api/goals/goal%2F1/approvals?status=PENDING&limit=20',
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8787/api/goals/goal%2F1/approvals/approval%2F1/approve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'Approve the exact bounded scope.' }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:8787/api/goals/goal%2F1/approvals/approval%2F1/reject',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'The requested scope is not needed.' }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:8787/api/goals/goal%2F1/tasks/task%2F1/retry',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          reason: 'Retry after the failed verification.',
          confirmExternalProcessStopped: true,
          idempotencyKey: 'retry-1',
        }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      5,
      'http://127.0.0.1:8787/api/goals/goal%2F1/continue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          confirmExternalProcessStopped: true,
          idempotencyKey: 'continue-1',
        }),
      }),
    );
  });

  it('loads the notification center page and updates read or dismissed state', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'notification-1' }], nextCursor: 'next' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'notification-1', status: 'READ' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const api = new DashboardApi({ baseUrl: 'http://127.0.0.1:8787', fetch: request });

    await expect(
      api.listOrchestratorNotifications({ status: 'PENDING', limit: 20, cursor: 'page-1' }),
    ).resolves.toMatchObject({ items: [{ id: 'notification-1' }], nextCursor: 'next' });
    await api.markOrchestratorNotificationRead('notification-1');
    await api.dismissOrchestratorNotification('notification-1');

    expect(request).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8787/api/orchestrator/notifications?status=PENDING&limit=20&cursor=page-1',
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8787/api/orchestrator/notifications/notification-1/read',
      { method: 'POST' },
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:8787/api/orchestrator/notifications/notification-1/dismiss',
      { method: 'POST' },
    );
  });

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
