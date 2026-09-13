import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createInitialSessionState, createInitialTurnState } from '@agentscope/protocol';
import type { OrchestratorEngine } from '@agentscope/orchestrator';
import { openStorage, OrchestratorRepository, StorageRepository } from '@agentscope/storage';

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
  it('serves orchestrator goals, tasks, and event history', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const orchestratorRepository = new OrchestratorRepository(client);
    const goal = orchestratorRepository.createGoal({
      id: 'goal-api-1',
      workspace: 'D:/workspace',
      prompt: 'Inspect the workspace',
      provider: 'mock',
      now: 1_700_000_000_000,
    });
    const task = orchestratorRepository.createTask({
      id: 'goal-api-1:task:1',
      goalId: goal.id,
      title: 'Inspect files',
      objective: 'Read the project metadata.',
      acceptanceCriteria: ['Metadata is captured.'],
      sequence: 1,
      now: 1_700_000_000_001,
    });
    orchestratorRepository.appendEvent({
      id: 'goal-api-1:event:1',
      goalId: goal.id,
      taskId: task.id,
      type: 'task.created',
      payload: { title: task.title },
      confidence: 1,
      timestamp: 1_700_000_000_002,
    });
    const app = createServer({
      repository,
      orchestratorRepository,
      recoverOnStart: false,
    });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    expect((await app.inject('/api/goals')).json()).toMatchObject([
      { id: goal.id, status: 'CREATED', provider: 'mock' },
    ]);
    expect((await app.inject(`/api/goals/${goal.id}`)).json()).toMatchObject({
      goal: { id: goal.id },
      tasks: [{ id: task.id, title: 'Inspect files' }],
      taskDetails: [{ task: { id: task.id }, attempts: [], verifications: [] }],
      events: [{ id: 'goal-api-1:event:1', taskId: task.id }],
    });
    expect((await app.inject(`/api/goals/${goal.id}/tasks`)).json()).toMatchObject([
      { id: task.id, sequence: 1 },
    ]);
    const metric = orchestratorRepository.createGoalMetricSnapshot({
      id: 'goal-api-1:metric:goal:1',
      goalId: goal.id,
      progress: 0.35,
      eta: { minSeconds: 10, maxSeconds: 20, confidence: 0.2 },
      confidence: 0.4,
      reasons: [{ code: 'running', message: 'The Goal is running.' }],
      capturedAt: 1_700_000_000_003,
    });
    expect((await app.inject(`/api/goals/${goal.id}/metrics?limit=1`)).json()).toEqual([metric]);
    const notification = orchestratorRepository.createOrchestratorNotification({
      id: 'goal-api-1:notification:1',
      goalId: goal.id,
      eventKey: 'goal-status:completed',
      kind: 'completed',
      payload: { status: 'COMPLETED' },
      now: 1_700_000_000_004,
    });
    expect(
      (await app.inject(`/api/goals/${goal.id}/notifications?status=PENDING&limit=1`)).json(),
    ).toEqual([notification]);
    expect((await app.inject(`/api/goals/${goal.id}`)).json()).toMatchObject({
      metrics: [expect.objectContaining({ id: metric.id, progress: 0.35 })],
      notifications: [expect.objectContaining({ id: notification.id, kind: 'completed' })],
    });
    expect((await app.inject(`/api/goals/${goal.id}/events?after=0&limit=1`)).json()).toEqual([
      expect.objectContaining({ id: 'goal-api-1:event:1', seq: 1 }),
    ]);
    expect((await app.inject('/api/orchestrator/metrics')).json()).toMatchObject({
      goalCount: 1,
      taskCount: 1,
      attemptCount: 0,
      taskSuccessRate: { numerator: 0, denominator: 0 },
      usage: { availability: 'unavailable', attemptCount: 0 },
    });
    expect(
      (
        await app.inject({
          url: '/api/orchestrator/metrics?from=1700000000001&to=1700000000000',
        })
      ).statusCode,
    ).toBe(400);
    const roadmapRevision = orchestratorRepository.createRoadmapRevision({
      id: 'goal-api-1:revision:1',
      goalId: goal.id,
      source: 'planner',
      reason: 'Capture the initial roadmap.',
      roadmap: [{ id: task.id, title: task.title, objective: task.objective, status: 'TENTATIVE' }],
      items: [
        {
          taskId: task.id,
          sequence: task.sequence,
          operation: 'added',
          tentative: true,
          snapshot: { title: task.title, objective: task.objective },
        },
      ],
    });
    expect((await app.inject(`/api/goals/${goal.id}/roadmap/revisions?limit=1`)).json()).toEqual([
      expect.objectContaining({ id: roadmapRevision.id, revision: roadmapRevision.revision }),
    ]);
    expect((await app.inject('/api/goals/missing')).statusCode).toBe(404);
    expect((await app.inject('/api/goals?limit=0')).statusCode).toBe(400);
    expect((await app.inject(`/api/goals/${goal.id}/roadmap/revisions?limit=0`)).statusCode).toBe(
      400,
    );
  });

  it('forwards future Task Contract edits through the orchestrator engine', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const orchestratorRepository = new OrchestratorRepository(client);
    const goal = orchestratorRepository.createGoal({
      id: 'task-edit-api-goal',
      workspace: 'D:/workspace',
      prompt: 'Edit a future task through HTTP.',
      provider: 'mock',
    });
    const task = orchestratorRepository.createTask({
      id: 'task-edit-api-task',
      goalId: goal.id,
      title: 'Future task',
      objective: 'Original objective',
      acceptanceCriteria: ['The task remains auditable.'],
      sequence: 1,
      tentative: true,
    });
    orchestratorRepository.createRoadmapRevision({
      id: 'task-edit-api-revision-1',
      goalId: goal.id,
      source: 'planner',
      reason: 'Initial roadmap.',
      roadmap: [{ id: task.id, title: task.title, objective: task.objective, status: 'TENTATIVE' }],
      items: [
        {
          taskId: task.id,
          sequence: 1,
          operation: 'added',
          tentative: true,
          snapshot: { title: task.title, objective: task.objective },
        },
      ],
    });
    let received: unknown;
    const engine = {
      editFutureTaskContract: (goalId: string, taskId: string, options: unknown) => {
        received = { goalId, taskId, options };
        return { goal: orchestratorRepository.getGoal(goalId), task, revision: {}, event: {} };
      },
    } as unknown as OrchestratorEngine;
    const app = createServer({
      repository,
      orchestratorRepository,
      orchestratorEngine: engine,
      recoverOnStart: false,
    });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/goals/${goal.id}/tasks/${task.id}`,
      payload: {
        idempotencyKey: 'task-edit-api-1',
        expectedRevision: 1,
        reason: 'Clarify the objective.',
        patch: { objective: 'Clarified objective', maxAttempts: 2 },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({
      goalId: goal.id,
      taskId: task.id,
      options: {
        patch: { objective: 'Clarified objective', maxAttempts: 2 },
        reason: 'Clarify the objective.',
        idempotencyKey: 'task-edit-api-1',
        expectedRevision: 1,
      },
    });
  });

  it('lists and resolves approval requests through HTTP', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const orchestratorRepository = new OrchestratorRepository(client);
    const goal = orchestratorRepository.createGoal({
      id: 'approval-api-goal',
      workspace: 'D:/workspace',
      prompt: 'Approve a risky task through HTTP.',
      provider: 'mock',
    });
    const approval = orchestratorRepository.createApprovalRequest({
      id: 'approval-api-1',
      goalId: goal.id,
      riskLevel: 'HIGH',
      action: 'execute-task',
      scope: {
        goalId: goal.id,
        taskId: 'approval-api-task',
        activeRevision: 1,
        contractHash: 'contract-hash',
        categories: ['network'],
      },
    });
    let received: unknown;
    const engine = {
      approveApproval: (goalId: string, approvalId: string, reason: string) => {
        received = { goalId, approvalId, reason };
        return orchestratorRepository.transitionApprovalRequest(approvalId, 'APPROVED', reason);
      },
      rejectApproval: (goalId: string, approvalId: string, reason: string) => {
        received = { goalId, approvalId, reason };
        return orchestratorRepository.transitionApprovalRequest(approvalId, 'REJECTED', reason);
      },
    } as unknown as OrchestratorEngine;
    const app = createServer({
      repository,
      orchestratorRepository,
      orchestratorEngine: engine,
      recoverOnStart: false,
    });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    expect(
      (await app.inject(`/api/goals/${goal.id}/approvals?status=PENDING`)).json(),
    ).toMatchObject([{ id: approval.id, status: 'PENDING' }]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/goals/${goal.id}/approvals/${approval.id}/approve`,
      payload: { reason: 'Approve the exact network scope.' },
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({
      goalId: goal.id,
      approvalId: approval.id,
      reason: 'Approve the exact network scope.',
    });
    expect((await app.inject(`/api/goals/${goal.id}/approvals`)).json()).toMatchObject([
      { id: approval.id, status: 'APPROVED', decisionReason: 'Approve the exact network scope.' },
    ]);
  });

  it('broadcasts orchestrator changes written by another process', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const orchestratorRepository = new OrchestratorRepository(client);
    const writer = new OrchestratorRepository(client);
    const liveHub = new LiveHub();
    const socket = new TestSocket();
    liveHub.attach(socket);
    const app = createServer({
      repository,
      orchestratorRepository,
      liveHub,
      recoverOnStart: false,
      externalPollIntervalMs: 10,
    });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    writer.createGoal({
      id: 'external-goal',
      workspace: 'D:/workspace',
      prompt: 'Observe external writes',
      provider: 'mock',
    });
    const task = writer.createTask({
      id: 'external-goal:task:1',
      goalId: 'external-goal',
      title: 'External task',
      objective: 'Verify polling.',
      acceptanceCriteria: ['The event is broadcast.'],
      sequence: 1,
    });
    writer.appendEvent({
      id: 'external-goal:event:1',
      goalId: 'external-goal',
      taskId: task.id,
      type: 'external.event',
      confidence: 1,
    });
    writer.createGoalMetricSnapshot({
      id: 'external-goal:metric:goal:1',
      goalId: 'external-goal',
      progress: 0.35,
      confidence: 0.4,
      reasons: [{ code: 'running', message: 'External metric.' }],
      capturedAt: 1_700_000_000_300,
    });
    writer.createOrchestratorNotification({
      id: 'external-goal:notification:1',
      goalId: 'external-goal',
      eventKey: 'needs-human:external',
      kind: 'needs-human',
      payload: { reason: 'External notification.' },
      now: 1_700_000_000_301,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    const notifications = socket.messages.slice(1).map((message) => JSON.parse(message));
    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'goal.created', goalId: 'external-goal' }),
        expect.objectContaining({ type: 'task.created', taskId: task.id }),
        expect.objectContaining({ type: 'event.appended', goalId: 'external-goal', seq: 1 }),
        expect.objectContaining({
          type: 'goal.metrics.updated',
          goalId: 'external-goal',
          payload: { progress: 0.35, confidence: 0.4, capturedAt: 1_700_000_000_300 },
        }),
        expect.objectContaining({
          type: 'goal.notification.created',
          goalId: 'external-goal',
          payload: expect.objectContaining({
            notificationId: 'external-goal:notification:1',
            kind: 'needs-human',
            status: 'PENDING',
          }),
        }),
      ]),
    );
    const metricNotificationCount = notifications.filter(
      (notification) => notification.type === 'goal.metrics.updated',
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(
      socket.messages
        .map((message) => JSON.parse(message))
        .filter((notification) => notification.type === 'goal.metrics.updated'),
    ).toHaveLength(metricNotificationCount);
  });

  it('accepts a Goal submission only through the configured engine', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const orchestratorRepository = new OrchestratorRepository(client);
    let startOptions: unknown;
    const engine = {
      createGoalAndRun: async (
        input: Parameters<OrchestratorEngine['createGoalAndRun']>[0],
        options: Parameters<OrchestratorEngine['createGoalAndRun']>[1],
      ) => {
        startOptions = options;
        const goal = orchestratorRepository.createGoal(input);
        return { goal, tasks: [], status: goal.status as 'CREATED' };
      },
    } as unknown as OrchestratorEngine;
    const app = createServer({
      repository,
      orchestratorRepository,
      orchestratorEngine: engine,
      recoverOnStart: false,
    });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/goals',
      payload: {
        id: 'submitted-goal',
        idempotencyKey: 'start-1',
        expectedRevision: 0,
        workspace: 'D:/workspace',
        prompt: 'Submit a safe goal',
        provider: 'mock',
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      goalId: 'submitted-goal',
      idempotencyKey: 'start-1',
      goal: { id: 'submitted-goal' },
    });
    expect(startOptions).toEqual({ idempotencyKey: 'start-1', expectedRevision: 0 });
    expect((await app.inject('/api/goals')).json()).toMatchObject([{ id: 'submitted-goal' }]);
  });

  it('exposes safe Goal pause, abort, and continue controls', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const orchestratorRepository = new OrchestratorRepository(client);
    orchestratorRepository.createGoal({
      id: 'control-goal',
      workspace: 'D:/workspace',
      prompt: 'Control this goal',
      provider: 'mock',
    });
    const engine = {
      requestPause: (id: string) => orchestratorRepository.transitionGoal(id, 'PAUSED'),
      requestAbort: (id: string) => orchestratorRepository.transitionGoal(id, 'ABORTED'),
      resumeGoal: async (id: string) => {
        const goal = orchestratorRepository.transitionGoal(id, 'PLANNING');
        return {
          goal,
          tasks: [],
          status: goal.status,
        };
      },
    } as unknown as OrchestratorEngine;
    const app = createServer({
      repository,
      orchestratorRepository,
      orchestratorEngine: engine,
      recoverOnStart: false,
    });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    expect(
      (await app.inject({ method: 'POST', url: '/api/goals/control-goal/pause' })).statusCode,
    ).toBe(200);
    expect(orchestratorRepository.getGoal('control-goal').status).toBe('PAUSED');
    expect(
      (await app.inject({ method: 'POST', url: '/api/goals/control-goal/continue' })).statusCode,
    ).toBe(202);
    expect(
      (await app.inject({ method: 'POST', url: '/api/goals/control-goal/abort' })).statusCode,
    ).toBe(200);
    expect(orchestratorRepository.getGoal('control-goal').status).toBe('ABORTED');
  });

  it('forwards idempotent control envelopes and exposes command history', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const orchestratorRepository = new OrchestratorRepository(client);
    orchestratorRepository.createGoal({
      id: 'control-envelope-goal',
      workspace: 'D:/workspace',
      prompt: 'Control envelope',
      provider: 'mock',
    });
    const task = orchestratorRepository.createTask({
      id: 'control-envelope-goal:task:1',
      goalId: 'control-envelope-goal',
      title: 'Retryable task',
      objective: 'Exercise the retry route.',
      acceptanceCriteria: ['The route forwards its options.'],
      sequence: 1,
    });
    const calls: {
      pause?: unknown;
      resume?: unknown;
      retry?: unknown;
    } = {};
    const engine = {
      active: false,
      requestPause: (id: string, options: unknown) => {
        calls.pause = options;
        return orchestratorRepository.transitionGoal(id, 'PAUSED');
      },
      requestAbort: (id: string) => orchestratorRepository.transitionGoal(id, 'ABORTED'),
      resumeGoal: async (id: string, options: unknown) => {
        calls.resume = options;
        const goal = orchestratorRepository.transitionGoal(id, 'PLANNING');
        return { goal, tasks: [], status: goal.status };
      },
      retryTask: async (id: string, taskId: string, options: unknown) => {
        calls.retry = { id, taskId, options };
        return {
          goal: orchestratorRepository.getGoal(id),
          tasks: [orchestratorRepository.getTask(taskId)],
          status: orchestratorRepository.getGoal(id).status,
          retry: { taskId, attemptNumber: 1 },
        };
      },
    } as unknown as OrchestratorEngine;
    const app = createServer({
      repository,
      orchestratorRepository,
      orchestratorEngine: engine,
      recoverOnStart: false,
    });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/goals/control-envelope-goal/pause',
          payload: { idempotencyKey: 'pause-1', expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(200);
    expect(calls.pause).toEqual({ idempotencyKey: 'pause-1', expectedRevision: 0 });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/goals/control-envelope-goal/continue',
          payload: {
            idempotencyKey: 'resume-1',
            expectedRevision: 0,
            confirmExternalProcessStopped: true,
          },
        })
      ).statusCode,
    ).toBe(202);
    expect(calls.resume).toEqual({
      idempotencyKey: 'resume-1',
      expectedRevision: 0,
      confirmExternalProcessStopped: true,
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/goals/control-envelope-goal/tasks/${task.id}/retry`,
          payload: {
            idempotencyKey: 'retry-1',
            reason: 'Retry after inspection.',
            confirmExternalProcessStopped: true,
          },
        })
      ).statusCode,
    ).toBe(202);
    expect(calls.retry).toEqual({
      id: 'control-envelope-goal',
      taskId: task.id,
      options: {
        idempotencyKey: 'retry-1',
        reason: 'Retry after inspection.',
        confirmExternalProcessStopped: true,
      },
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/goals/control-envelope-goal/pause',
          payload: { unknown: true },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject('/api/goals/control-envelope-goal/commands')).statusCode).toBe(200);
  });

  it('rejects a second Goal while another Goal is active', async () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const repository = new StorageRepository(client);
    const orchestratorRepository = new OrchestratorRepository(client);
    orchestratorRepository.createGoal({
      id: 'active-goal',
      workspace: 'D:/workspace',
      prompt: 'Already running',
      provider: 'mock',
    });
    orchestratorRepository.transitionGoal('active-goal', 'PLANNING');
    const engine = {
      active: false,
      createGoalAndRun: async () => {
        throw new Error('should not be called');
      },
    } as unknown as OrchestratorEngine;
    const app = createServer({
      repository,
      orchestratorRepository,
      orchestratorEngine: engine,
      recoverOnStart: false,
    });
    openApps.push({
      close: async () => {
        await app.close();
        client.close();
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/goals',
      payload: {
        workspace: 'D:/workspace',
        prompt: 'Second goal',
        provider: 'mock',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'goal_busy' } });
  });

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
