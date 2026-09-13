import { randomUUID } from 'node:crypto';

import websocket from '@fastify/websocket';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type { SessionStatus } from '@agentscope/protocol';
import { reduceSessionState } from '@agentscope/core';
import {
  OrchestratorBusyError,
  computeReliabilityMetrics,
  type InstructionDraft,
  type OrchestratorEngine,
} from '@agentscope/orchestrator';
import {
  type ProjectionVerification,
  type RepositoryNotification,
  StorageError,
  StorageNotFoundError,
  type SessionListFilter,
  type StoredSession,
  type StoredTurn,
  type TurnListFilter,
  type StorageRepository,
  type OrchestratorRepository,
  type OrchestratorRepositoryNotification,
  type StoredAttempt,
  type StoredOrchestratorEvent,
  type InstructionStatus,
  type StoredVerificationRun,
  type StoredApprovalRequest,
  type StoredGoal,
  type StoredGoalMetricSnapshot,
  type StoredOrchestratorNotification,
  type OrchestratorNotificationPage,
  type NotificationStatus,
  type StoredTask,
} from '@agentscope/storage';

import { LiveHub } from './live-hub.js';

const ErrorResponseSchema = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
});
const SessionListQuerySchema = Type.Object({
  project: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(Type.String({ minLength: 1 })),
  includeHidden: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
});
const SessionParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const TurnListQuerySchema = Type.Object({
  status: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const TurnPageQuerySchema = Type.Object({
  status: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
});
const EventQuerySchema = Type.Object({
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const EvidenceQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const EvidencePageQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
});
const CursorPageSchema = Type.Object({
  items: Type.Array(Type.Unknown()),
  nextCursor: Type.Optional(Type.String()),
});
const SessionVisibilityResponseSchema = Type.Object({
  id: Type.String(),
  hidden: Type.Boolean(),
});
const SessionDeletedResponseSchema = Type.Object({
  id: Type.String(),
  deleted: Type.Literal(true),
});
const ProjectOverviewSchema = Type.Object({
  projectId: Type.String(),
  active: Type.Integer({ minimum: 0 }),
  blocked: Type.Integer({ minimum: 0 }),
  completed: Type.Integer({ minimum: 0 }),
  failed: Type.Integer({ minimum: 0 }),
  interrupted: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
});
const DiagnosticsSchema = Type.Object({
  protocolVersion: Type.String(),
  startedAt: Type.Integer({ minimum: 0 }),
  uptimeMs: Type.Integer({ minimum: 0 }),
  process: Type.Object({
    pid: Type.Integer({ minimum: 0 }),
    nodeVersion: Type.String(),
    platform: Type.String(),
  }),
  websocket: Type.Object({
    clientCount: Type.Integer({ minimum: 0 }),
    notificationsPublished: Type.Integer({ minimum: 0 }),
    notificationsDelivered: Type.Integer({ minimum: 0 }),
    droppedNotifications: Type.Integer({ minimum: 0 }),
    slowClientDisconnects: Type.Integer({ minimum: 0 }),
    sendFailures: Type.Integer({ minimum: 0 }),
    invalidMessages: Type.Integer({ minimum: 0 }),
    unsupportedMessages: Type.Integer({ minimum: 0 }),
  }),
  storage: Type.Object({
    eventAppendAttempts: Type.Integer({ minimum: 0 }),
    eventAppendSuccesses: Type.Integer({ minimum: 0 }),
    duplicateEventErrors: Type.Integer({ minimum: 0 }),
    busyErrors: Type.Integer({ minimum: 0 }),
    eventWriteLatencyMs: Type.Object({
      count: Type.Integer({ minimum: 0 }),
      total: Type.Number({ minimum: 0 }),
      max: Type.Number({ minimum: 0 }),
    }),
  }),
});
const GoalListQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const GoalPageQuerySchema = Type.Object({
  status: Type.Optional(Type.String({ minLength: 1 })),
  provider: Type.Optional(Type.String({ minLength: 1 })),
  workspace: Type.Optional(Type.String({ minLength: 1 })),
  query: Type.Optional(Type.String({ minLength: 1 })),
  includeArchived: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
});
const ReliabilityMetricsQuerySchema = Type.Object({
  provider: Type.Optional(Type.String({ minLength: 1 })),
  workspace: Type.Optional(Type.String({ minLength: 1 })),
  includeArchived: Type.Optional(Type.Boolean()),
  from: Type.Optional(Type.Integer({ minimum: 0 })),
  to: Type.Optional(Type.Integer({ minimum: 0 })),
});
const GoalParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const GoalTaskParamsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  taskId: Type.String({ minLength: 1 }),
});
const GoalApprovalParamsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  approvalId: Type.String({ minLength: 1 }),
});
const GoalEventQuerySchema = Type.Object({
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
const GoalMetricQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
const GoalNotificationQuerySchema = Type.Object({
  status: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
const OrchestratorNotificationListQuerySchema = Type.Object({
  status: Type.Optional(Type.String({ minLength: 1 })),
  includeArchived: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
});
const NotificationParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const GoalRoadmapRevisionQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
const GoalCreateSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  workspace: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1 }),
  provider: Type.String({ minLength: 1 }),
  constraints: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
const GoalCommandQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
const InstructionCreateSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  baseRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  kind: Type.Union([
    Type.Literal('clarification'),
    Type.Literal('constraint'),
    Type.Literal('priority'),
    Type.Literal('approval-context'),
    Type.Literal('general'),
  ]),
  content: Type.String({ minLength: 1, maxLength: 16_000 }),
});
const InstructionListQuerySchema = Type.Object({
  status: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
const ApprovalListQuerySchema = Type.Object({
  status: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
const ApprovalDecisionSchema = Type.Object({
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
});
const TaskContractPatchSchema = Type.Partial(
  Type.Object({
    title: Type.String({ minLength: 1, maxLength: 200 }),
    objective: Type.String({ minLength: 1, maxLength: 16_000 }),
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), {
      minItems: 1,
      maxItems: 100,
    }),
    verification: Type.Record(Type.String(), Type.Unknown()),
    constraints: Type.Record(Type.String(), Type.Unknown()),
    maxAttempts: Type.Integer({ minimum: 1, maximum: 10 }),
  }),
);
const TaskContractUpdateSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  reason: Type.String({ minLength: 1, maxLength: 4_000 }),
  patch: TaskContractPatchSchema,
});
const TaskInsertSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  objective: Type.String({ minLength: 1, maxLength: 16_000 }),
  acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), {
    minItems: 1,
    maxItems: 100,
  }),
  verification: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  constraints: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  sequence: Type.Optional(Type.Integer({ minimum: 1 })),
  tentative: Type.Optional(Type.Boolean()),
  parentTaskId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  reason: Type.String({ minLength: 1, maxLength: 4_000 }),
});
const TaskSkipSchema = Type.Object({
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  reason: Type.String({ minLength: 1, maxLength: 4_000 }),
});
const RoadmapReorderSchema = Type.Object({
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  taskIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    minItems: 1,
    maxItems: 500,
  }),
  reason: Type.String({ minLength: 1, maxLength: 4_000 }),
});

export interface ServerOptions {
  readonly repository: StorageRepository;
  readonly protocolVersion?: string;
  readonly liveHub?: LiveHub;
  readonly recoverOnStart?: boolean;
  readonly heartbeatIntervalMs?: number;
  readonly externalPollIntervalMs?: number;
  readonly maxWebSocketBufferedBytes?: number;
  readonly maxWebSocketPayloadBytes?: number;
  readonly onProjectionMismatch?: (diagnostic: ProjectionVerification) => void;
  readonly orchestratorRepository?: OrchestratorRepository;
  readonly orchestratorEngine?: OrchestratorEngine;
}

export function createServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const protocolVersion = options.protocolVersion ?? '0.1';
  const startedAt = Date.now();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const externalPollIntervalMs = options.externalPollIntervalMs ?? 250;
  const maxWebSocketBufferedBytes = options.maxWebSocketBufferedBytes ?? 256 * 1024;
  const maxWebSocketPayloadBytes = options.maxWebSocketPayloadBytes ?? 64 * 1024;
  if (!Number.isFinite(maxWebSocketPayloadBytes) || maxWebSocketPayloadBytes <= 0) {
    throw new RangeError('maxWebSocketPayloadBytes must be positive.');
  }
  if (!Number.isFinite(externalPollIntervalMs) || externalPollIntervalMs < 0) {
    throw new RangeError('externalPollIntervalMs must be non-negative.');
  }
  if (!Number.isFinite(maxWebSocketBufferedBytes) || maxWebSocketBufferedBytes <= 0) {
    throw new RangeError('maxWebSocketBufferedBytes must be positive.');
  }
  const liveHub = options.liveHub ?? new LiveHub({ maxBufferedBytes: maxWebSocketBufferedBytes });
  for (const diagnostic of options.repository.verifyNonTerminalProjections(reduceSessionState)) {
    if (!diagnostic.matches) options.onProjectionMismatch?.(diagnostic);
  }
  if (options.recoverOnStart !== false) options.repository.recoverInFlightSessions();
  const observedSessions = new Map<string, ObservedSession>();
  const observedTurns = new Map<string, ObservedTurn>();
  const observedGoals = new Map<string, ObservedGoal>();
  const observedTasks = new Map<string, ObservedTask>();
  const observedAttempts = new Map<string, ObservedAttempt>();
  const observedVerifications = new Map<string, ObservedVerification>();
  const observedGoalEvents = new Map<string, number>();
  const observedGoalMetrics = new Map<string, string>();
  const observedGoalNotifications = new Map<string, string>();
  hydrateObservedSessions(options.repository, observedSessions);
  hydrateObservedTurns(options.repository, observedTurns);
  if (options.orchestratorRepository !== undefined) {
    hydrateObservedOrchestrator(
      options.orchestratorRepository,
      observedGoals,
      observedTasks,
      observedAttempts,
      observedVerifications,
      observedGoalEvents,
      observedGoalMetrics,
      observedGoalNotifications,
    );
  }
  const unsubscribeRepository = options.repository.subscribe((notification) => {
    if (notification.type === 'session.deleted') {
      observedSessions.delete(notification.session.id);
      for (const [turnId, observedTurn] of observedTurns) {
        if (observedTurn.sessionId === notification.session.id) observedTurns.delete(turnId);
      }
      liveHub.publish({
        type: 'session.deleted',
        sessionId: notification.session.id,
        ...(notification.session.projectId === undefined
          ? {}
          : { projectId: notification.session.projectId }),
        payload: { status: notification.session.status },
      });
      return;
    }
    if (
      notification.type === 'turn.created' ||
      notification.type === 'turn.updated' ||
      notification.type === 'turn.finished'
    ) {
      observedTurns.set(notification.turn.id, {
        sessionId: notification.turn.sessionId,
        updatedAt: notification.turn.updatedAt,
        status: notification.turn.status,
      });
      liveHub.publish({
        type: notification.type,
        sessionId: notification.turn.sessionId,
        payload: {
          turnId: notification.turn.id,
          sequence: notification.turn.sequence,
          status: notification.turn.status,
        },
      });
      return;
    }
    rememberNotification(observedSessions, observedTurns, notification);
    if (notification.type === 'event.appended') {
      liveHub.publish({
        type: 'event.appended',
        sessionId: notification.session.id,
        ...(notification.session.projectId === undefined
          ? {}
          : { projectId: notification.session.projectId }),
        seq: notification.event.seq,
        cursor: String(notification.event.seq),
        payload: { eventType: notification.event.event.type },
      });
      return;
    }
    liveHub.publish({
      type: notification.type,
      sessionId: notification.session.id,
      ...(notification.session.projectId === undefined
        ? {}
        : { projectId: notification.session.projectId }),
      payload: { status: notification.session.status },
    });
  });
  const unsubscribeOrchestrator = options.orchestratorRepository?.subscribe((notification) => {
    rememberOrchestratorNotification(
      notification,
      observedGoals,
      observedTasks,
      observedAttempts,
      observedVerifications,
      observedGoalEvents,
      observedGoalMetrics,
      observedGoalNotifications,
    );
    publishOrchestratorNotification(liveHub, notification, options.orchestratorRepository);
  });
  let externalPollInFlight = false;
  const pollExternalChanges = () => {
    if (externalPollInFlight) return;
    externalPollInFlight = true;
    try {
      const currentSessions = listAllSessions(options.repository, true);
      const currentSessionIds = new Set(currentSessions.map((session) => session.id));
      for (const [sessionId, observed] of observedSessions) {
        if (currentSessionIds.has(sessionId)) continue;
        observedSessions.delete(sessionId);
        for (const [turnId, observedTurn] of observedTurns) {
          if (observedTurn.sessionId === sessionId) observedTurns.delete(turnId);
        }
        liveHub.publish({
          type: 'session.deleted',
          sessionId,
          payload: { status: observed.status },
        });
      }
      for (const session of currentSessions) {
        const observed = observedSessions.get(session.id);
        const afterSeq = observed?.lastEventSeq ?? 0;
        const events = options.repository.listEvents(session.id, afterSeq, 100).items;
        if (observed === undefined) {
          liveHub.publish({
            type: 'session.created',
            sessionId: session.id,
            ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
            payload: { status: session.status },
          });
        } else if (observed.updatedAt !== session.updatedAt || observed.status !== session.status) {
          liveHub.publish({
            type: 'session.updated',
            sessionId: session.id,
            ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
            payload: { status: session.status },
          });
        }
        for (const event of events) {
          liveHub.publish({
            type: 'event.appended',
            sessionId: session.id,
            ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
            seq: event.seq,
            cursor: String(event.seq),
            payload: { eventType: event.event.type },
          });
        }
        for (const turn of options.repository.listTurns(session.id)) {
          const observedTurn = observedTurns.get(turn.id);
          if (observedTurn === undefined) {
            publishTurnNotification(liveHub, 'turn.created', turn);
          } else if (
            observedTurn.updatedAt !== turn.updatedAt ||
            observedTurn.status !== turn.status
          ) {
            publishTurnNotification(liveHub, 'turn.updated', turn);
            if (isTerminalTurnStatus(turn.status)) {
              publishTurnNotification(liveHub, 'turn.finished', turn);
            }
          }
          observedTurns.set(turn.id, {
            sessionId: turn.sessionId,
            updatedAt: turn.updatedAt,
            status: turn.status,
          });
        }
        observedSessions.set(session.id, {
          updatedAt: session.updatedAt,
          status: session.status,
          lastEventSeq: Math.max(observed?.lastEventSeq ?? 0, ...events.map((event) => event.seq)),
        });
      }
      if (options.orchestratorRepository !== undefined) {
        pollExternalOrchestratorChanges(options.orchestratorRepository, liveHub, {
          observedGoals,
          observedTasks,
          observedAttempts,
          observedVerifications,
          observedGoalEvents,
          observedGoalMetrics,
          observedGoalNotifications,
        });
      }
    } finally {
      externalPollInFlight = false;
    }
  };
  const externalPollTimer =
    externalPollIntervalMs === 0
      ? undefined
      : setInterval(pollExternalChanges, externalPollIntervalMs);
  externalPollTimer?.unref?.();
  app.addHook('onClose', () => {
    unsubscribeRepository();
    unsubscribeOrchestrator?.();
    stopHeartbeat();
    if (externalPollTimer !== undefined) clearInterval(externalPollTimer);
    liveHub.close();
  });
  app.setErrorHandler((error, _request, reply) => {
    if ((error as { validation?: unknown }).validation !== undefined) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'Request validation failed.' },
      });
    }
    return sendError(reply, error);
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  app.register(async (instance) => {
    await instance.register(websocket, { options: { maxPayload: maxWebSocketPayloadBytes } });
    instance.get('/ws', { websocket: true }, (socket) => {
      const detach = liveHub.attach(socket, protocolVersion);
      socket.on('pong', () => liveHub.markAlive(socket));
      socket.on('message', (raw: { toString(): string }) => {
        liveHub.handleMessage(socket, raw.toString());
      });
      socket.on('close', detach);
    });
  });

  const stopHeartbeat = liveHub.startHeartbeat(heartbeatIntervalMs);

  app.get('/healthz', async () => ({ status: 'ok', protocolVersion }));

  app.get('/api/diagnostics', { schema: { response: { 200: DiagnosticsSchema } } }, async () => ({
    protocolVersion,
    startedAt,
    uptimeMs: Math.max(0, Date.now() - startedAt),
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    websocket: liveHub.diagnostics(),
    storage: options.repository.diagnostics(),
  }));

  app.get(
    '/api/goals',
    {
      schema: {
        querystring: GoalListQuerySchema,
        response: {
          200: Type.Array(Type.Unknown()),
          400: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      const query = request.query as Record<string, unknown>;
      try {
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(options.orchestratorRepository.listGoals(limit));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/goals/page',
    {
      schema: {
        querystring: GoalPageQuerySchema,
        response: {
          200: Type.Object({
            items: Type.Array(Type.Unknown()),
            nextCursor: Type.Optional(Type.String()),
          }),
          400: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const query = request.query as Record<string, unknown>;
        const status = query.status === undefined ? undefined : String(query.status);
        const provider = query.provider === undefined ? undefined : String(query.provider);
        const workspace = query.workspace === undefined ? undefined : String(query.workspace);
        const search = query.query === undefined ? undefined : String(query.query);
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(
          options.orchestratorRepository.listGoalPage({
            ...(status === undefined ? {} : { status: status as StoredGoal['status'] }),
            ...(provider === undefined ? {} : { provider }),
            ...(workspace === undefined ? {} : { workspace }),
            ...(search === undefined ? {} : { query: search }),
            ...(query.includeArchived === true ? { includeArchived: true } : {}),
            limit,
            ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/orchestrator/metrics',
    {
      schema: {
        querystring: ReliabilityMetricsQuerySchema,
        response: {
          200: Type.Unknown(),
          400: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const query = request.query as Record<string, unknown>;
        const from = query.from === undefined ? undefined : parseNonNegativeInteger(query.from);
        const to = query.to === undefined ? undefined : parseNonNegativeInteger(query.to);
        if (from !== undefined && to !== undefined && from > to) {
          throw new StorageError('Metrics from must not be after to.', 'invalid_query');
        }
        const records = collectOrchestratorRecords(options.orchestratorRepository, {
          includeArchived: query.includeArchived !== false,
          ...(typeof query.provider === 'string' ? { provider: query.provider } : {}),
          ...(typeof query.workspace === 'string' ? { workspace: query.workspace } : {}),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        });
        return reply.send(computeReliabilityMetrics(records));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/goals/:id',
    {
      schema: {
        params: GoalParamsSchema,
        response: { 200: Type.Unknown(), 404: ErrorResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const { id } = request.params as { id: string };
        return reply.send({
          goal: options.orchestratorRepository.getGoal(id),
          tasks: options.orchestratorRepository.listTasks(id),
          taskDetails: options.orchestratorRepository.listTasks(id).map((task) => ({
            task,
            attempts: options.orchestratorRepository!.listAttempts(task.id),
            verifications: options.orchestratorRepository!.listVerificationRuns(task.id),
          })),
          events: options.orchestratorRepository.listEvents(id),
          metrics: options.orchestratorRepository.listGoalMetricSnapshots(id),
          notifications: options.orchestratorRepository.listOrchestratorNotifications(id),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/goals/:id/metrics',
    {
      schema: {
        params: GoalParamsSchema,
        querystring: GoalMetricQuerySchema,
        response: {
          200: Type.Array(Type.Unknown()),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(options.orchestratorRepository.listGoalMetricSnapshots(id, limit));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/goals/:id/notifications',
    {
      schema: {
        params: GoalParamsSchema,
        querystring: GoalNotificationQuerySchema,
        response: {
          200: Type.Array(Type.Unknown()),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const status = query.status === undefined ? undefined : String(query.status);
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(
          options.orchestratorRepository.listOrchestratorNotifications(id, {
            ...(status === undefined
              ? {}
              : { status: status as StoredOrchestratorNotification['status'] }),
            limit,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/goals/:id/tasks',
    {
      schema: {
        params: GoalParamsSchema,
        response: {
          200: Type.Array(Type.Unknown()),
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const { id } = request.params as { id: string };
        return reply.send(options.orchestratorRepository.listTasks(id));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/orchestrator/notifications',
    {
      schema: {
        querystring: OrchestratorNotificationListQuerySchema,
        response: {
          200: Type.Object({
            items: Type.Array(Type.Unknown()),
            nextCursor: Type.Optional(Type.String()),
          }),
          400: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const query = request.query as Record<string, unknown>;
        const status =
          query.status === undefined ? undefined : (String(query.status) as NotificationStatus);
        const limit = query.limit === undefined ? 50 : parsePositiveInteger(query.limit);
        const page: OrchestratorNotificationPage =
          options.orchestratorRepository.listOrchestratorNotificationPage({
            ...(status === undefined ? {} : { status }),
            ...(query.includeArchived === true ? { includeArchived: true } : {}),
            limit,
            ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
          });
        return reply.send(page);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  for (const [action, status] of [
    ['read', 'READ'],
    ['dismiss', 'DISMISSED'],
  ] as const) {
    app.post(
      `/api/orchestrator/notifications/:id/${action}`,
      {
        schema: {
          params: NotificationParamsSchema,
          response: {
            200: Type.Unknown(),
            404: ErrorResponseSchema,
            409: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (options.orchestratorRepository === undefined) {
          return reply.code(503).send({
            error: {
              code: 'orchestrator_unavailable',
              message: 'Orchestrator is not configured.',
            },
          });
        }
        try {
          const { id } = request.params as { id: string };
          return reply.send(
            options.orchestratorRepository.transitionOrchestratorNotification(id, status),
          );
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  }

  app.post(
    '/api/goals/:id/tasks',
    {
      schema: {
        params: GoalParamsSchema,
        body: TaskInsertSchema,
        response: {
          201: Type.Unknown(),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        options.orchestratorRepository === undefined ||
        options.orchestratorEngine === undefined
      ) {
        return reply.code(503).send({
          error: {
            code: 'orchestrator_unavailable',
            message: 'Orchestrator execution is not configured.',
          },
        });
      }
      try {
        const { id } = request.params as { id: string };
        const body = request.body as {
          readonly taskId?: string;
          readonly idempotencyKey?: string;
          readonly expectedRevision?: number;
          readonly title: string;
          readonly objective: string;
          readonly acceptanceCriteria: readonly string[];
          readonly verification?: Record<string, unknown>;
          readonly constraints?: Record<string, unknown>;
          readonly maxAttempts?: number;
          readonly sequence?: number;
          readonly tentative?: boolean;
          readonly parentTaskId?: string;
          readonly reason: string;
        };
        const result = options.orchestratorEngine.insertFutureTask(id, {
          ...(body.taskId === undefined ? {} : { taskId: body.taskId }),
          title: body.title,
          objective: body.objective,
          acceptanceCriteria: body.acceptanceCriteria,
          ...(body.verification === undefined ? {} : { verification: body.verification }),
          ...(body.constraints === undefined ? {} : { constraints: body.constraints }),
          ...(body.maxAttempts === undefined ? {} : { maxAttempts: body.maxAttempts }),
          ...(body.sequence === undefined ? {} : { sequence: body.sequence }),
          ...(body.tentative === undefined ? {} : { tentative: body.tentative }),
          ...(body.parentTaskId === undefined ? {} : { parentTaskId: body.parentTaskId }),
          reason: body.reason,
          ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
          ...(body.expectedRevision === undefined
            ? {}
            : { expectedRevision: body.expectedRevision }),
        });
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof OrchestratorBusyError) {
          return reply
            .code(409)
            .send({ error: { code: 'goal_control_conflict', message: error.message } });
        }
        return sendError(reply, error);
      }
    },
  );

  app.patch(
    '/api/goals/:id/tasks/:taskId',
    {
      schema: {
        params: GoalTaskParamsSchema,
        body: TaskContractUpdateSchema,
        response: {
          200: Type.Unknown(),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        options.orchestratorRepository === undefined ||
        options.orchestratorEngine === undefined
      ) {
        return reply.code(503).send({
          error: {
            code: 'orchestrator_unavailable',
            message: 'Orchestrator execution is not configured.',
          },
        });
      }
      try {
        const { id, taskId } = request.params as { id: string; taskId: string };
        const body = request.body as {
          readonly id?: string;
          readonly idempotencyKey?: string;
          readonly expectedRevision?: number;
          readonly reason: string;
          readonly patch: {
            readonly title?: string;
            readonly objective?: string;
            readonly acceptanceCriteria?: readonly string[];
            readonly verification?: Record<string, unknown>;
            readonly constraints?: Record<string, unknown>;
            readonly maxAttempts?: number;
          };
        };
        const result = options.orchestratorEngine.editFutureTaskContract(id, taskId, {
          patch: body.patch,
          reason: body.reason,
          ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
          ...(body.expectedRevision === undefined
            ? {}
            : { expectedRevision: body.expectedRevision }),
        });
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof OrchestratorBusyError) {
          return reply
            .code(409)
            .send({ error: { code: 'goal_control_conflict', message: error.message } });
        }
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/goals/:id/events',
    {
      schema: {
        params: GoalParamsSchema,
        querystring: GoalEventQuerySchema,
        response: {
          200: Type.Array(Type.Unknown()),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const after = query.after === undefined ? 0 : parseNonNegativeInteger(query.after);
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(options.orchestratorRepository.listEvents(id, after, limit));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/goals/:id/roadmap/revisions',
    {
      schema: {
        params: GoalParamsSchema,
        querystring: GoalRoadmapRevisionQuerySchema,
        response: {
          200: Type.Array(Type.Unknown()),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(options.orchestratorRepository.listRoadmapRevisions(id, limit));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/goals/:id/commands',
    {
      schema: {
        params: GoalParamsSchema,
        querystring: GoalCommandQuerySchema,
        response: {
          200: Type.Array(Type.Unknown()),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(options.orchestratorRepository.listOrchestratorCommands(id, limit));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/goals/:id/instructions',
    {
      schema: {
        params: GoalParamsSchema,
        querystring: InstructionListQuerySchema,
        response: {
          200: Type.Array(Type.Unknown()),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const status =
          query.status === undefined ? undefined : (String(query.status) as InstructionStatus);
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(
          options.orchestratorRepository.listInstructions(id, {
            ...(status === undefined ? {} : { status }),
            limit,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/goals/:id/instructions',
    {
      schema: {
        params: GoalParamsSchema,
        body: InstructionCreateSchema,
        response: {
          201: Type.Unknown(),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        options.orchestratorRepository === undefined ||
        options.orchestratorEngine === undefined
      ) {
        return reply.code(503).send({
          error: {
            code: 'orchestrator_unavailable',
            message: 'Orchestrator execution is not configured.',
          },
        });
      }
      try {
        const { id } = request.params as { id: string };
        const body = request.body as {
          readonly id?: string;
          readonly idempotencyKey?: string;
          readonly expectedRevision?: number;
          readonly baseRevision?: number;
          readonly kind: InstructionDraft['kind'];
          readonly content: string;
        };
        const instruction = options.orchestratorEngine.submitInstruction(
          id,
          {
            ...(body.id === undefined ? {} : { id: body.id }),
            kind: body.kind,
            content: body.content,
            ...(body.baseRevision === undefined ? {} : { baseRevision: body.baseRevision }),
          },
          {
            ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
            ...(body.expectedRevision === undefined
              ? {}
              : { expectedRevision: body.expectedRevision }),
          },
        );
        return reply.code(201).send({
          goalId: id,
          instruction,
          ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/goals/:id/approvals',
    {
      schema: {
        params: GoalParamsSchema,
        querystring: ApprovalListQuerySchema,
        response: {
          200: Type.Array(Type.Unknown()),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorRepository === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const status = query.status === undefined ? undefined : String(query.status);
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(
          options.orchestratorRepository.listApprovalRequests(id, {
            ...(status === undefined ? {} : { status: status as StoredApprovalRequest['status'] }),
            limit,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/goals/:id/approvals/:approvalId/approve',
    {
      schema: {
        params: GoalApprovalParamsSchema,
        body: ApprovalDecisionSchema,
        response: {
          200: Type.Unknown(),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorEngine === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const { id, approvalId } = request.params as { id: string; approvalId: string };
        const body = request.body as { readonly reason?: string };
        return reply.send(
          options.orchestratorEngine.approveApproval(
            id,
            approvalId,
            body.reason ?? 'Approved for the exact Task Contract scope.',
          ),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/goals/:id/approvals/:approvalId/reject',
    {
      schema: {
        params: GoalApprovalParamsSchema,
        body: ApprovalDecisionSchema,
        response: {
          200: Type.Unknown(),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (options.orchestratorEngine === undefined) {
        return reply.code(503).send({
          error: { code: 'orchestrator_unavailable', message: 'Orchestrator is not configured.' },
        });
      }
      try {
        const { id, approvalId } = request.params as { id: string; approvalId: string };
        const body = request.body as { readonly reason?: string };
        return reply.send(
          options.orchestratorEngine.rejectApproval(
            id,
            approvalId,
            body.reason ?? 'Rejected by the user.',
          ),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/goals',
    {
      schema: {
        body: GoalCreateSchema,
        response: {
          202: Type.Unknown(),
          400: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        options.orchestratorRepository === undefined ||
        options.orchestratorEngine === undefined
      ) {
        return reply.code(503).send({
          error: {
            code: 'orchestrator_unavailable',
            message: 'Orchestrator execution is not configured.',
          },
        });
      }
      try {
        const body = request.body as {
          readonly id?: string;
          readonly idempotencyKey?: string;
          readonly expectedRevision?: number;
          readonly workspace: string;
          readonly prompt: string;
          readonly provider: string;
          readonly constraints?: Record<string, unknown>;
        };
        const activeGoal = options.orchestratorRepository
          .listGoals()
          .find((goal) => ['PLANNING', 'RUNNING', 'VERIFYING'].includes(goal.status));
        const isIdempotentRetry =
          activeGoal?.id === (body.id ?? '') && body.idempotencyKey !== undefined;
        if (
          (activeGoal !== undefined || options.orchestratorEngine.active === true) &&
          !isIdempotentRetry
        ) {
          return reply.code(409).send({
            error: {
              code: 'goal_busy',
              message:
                activeGoal === undefined
                  ? 'The Orchestrator is already running a Goal in this process.'
                  : `Goal ${activeGoal.id} is already active.`,
            },
          });
        }
        const id = body.id ?? randomUUID();
        void options.orchestratorEngine
          .createGoalAndRun(
            {
              id,
              workspace: body.workspace,
              prompt: body.prompt,
              provider: body.provider,
              ...(body.constraints === undefined ? {} : { constraints: body.constraints }),
            },
            {
              ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
              ...(body.expectedRevision === undefined
                ? {}
                : { expectedRevision: body.expectedRevision }),
            },
          )
          .catch(() => undefined);
        return reply.code(202).send({
          goalId: id,
          ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
          goal: options.orchestratorRepository.getGoal(id),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/goals/:id/pause',
    {
      schema: {
        params: GoalParamsSchema,
        response: {
          200: Type.Unknown(),
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        options.orchestratorRepository === undefined ||
        options.orchestratorEngine === undefined
      ) {
        return reply.code(503).send({
          error: {
            code: 'orchestrator_unavailable',
            message: 'Orchestrator execution is not configured.',
          },
        });
      }
      try {
        const { id } = request.params as { id: string };
        return reply.send({
          goal: options.orchestratorEngine.requestPause(
            id,
            controlOptionsFromBody(parseControlCommandBody(request.body)),
          ),
          requested: true,
        });
      } catch (error) {
        if (error instanceof OrchestratorBusyError) {
          return reply
            .code(409)
            .send({ error: { code: 'goal_control_conflict', message: error.message } });
        }
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/goals/:id/abort',
    {
      schema: {
        params: GoalParamsSchema,
        response: {
          200: Type.Unknown(),
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        options.orchestratorRepository === undefined ||
        options.orchestratorEngine === undefined
      ) {
        return reply.code(503).send({
          error: {
            code: 'orchestrator_unavailable',
            message: 'Orchestrator execution is not configured.',
          },
        });
      }
      try {
        const { id } = request.params as { id: string };
        return reply.send({
          goal: options.orchestratorEngine.requestAbort(
            id,
            controlOptionsFromBody(parseControlCommandBody(request.body)),
          ),
          requested: true,
        });
      } catch (error) {
        if (error instanceof OrchestratorBusyError) {
          return reply
            .code(409)
            .send({ error: { code: 'goal_control_conflict', message: error.message } });
        }
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/goals/:id/continue',
    {
      schema: {
        params: GoalParamsSchema,
        response: {
          202: Type.Unknown(),
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        options.orchestratorRepository === undefined ||
        options.orchestratorEngine === undefined
      ) {
        return reply.code(503).send({
          error: {
            code: 'orchestrator_unavailable',
            message: 'Orchestrator execution is not configured.',
          },
        });
      }
      try {
        const { id } = request.params as { id: string };
        const body = parseControlCommandBody(request.body);
        void options.orchestratorEngine
          .resumeGoal(id, {
            ...controlOptionsFromBody(body),
            ...(body?.confirmExternalProcessStopped === undefined
              ? {}
              : { confirmExternalProcessStopped: body.confirmExternalProcessStopped }),
          })
          .catch(() => undefined);
        return reply
          .code(202)
          .send({ goalId: id, goal: options.orchestratorRepository.getGoal(id) });
      } catch (error) {
        if (error instanceof OrchestratorBusyError) {
          return reply
            .code(409)
            .send({ error: { code: 'goal_control_conflict', message: error.message } });
        }
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/goals/:id/tasks/:taskId/retry',
    {
      schema: {
        params: GoalTaskParamsSchema,
        response: {
          202: Type.Unknown(),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        options.orchestratorRepository === undefined ||
        options.orchestratorEngine === undefined
      ) {
        return reply.code(503).send({
          error: {
            code: 'orchestrator_unavailable',
            message: 'Orchestrator execution is not configured.',
          },
        });
      }
      try {
        const { id, taskId } = request.params as { id: string; taskId: string };
        const body = parseControlCommandBody(request.body);
        void options.orchestratorEngine
          .retryTask(id, taskId, {
            ...controlOptionsFromBody(body),
            ...(body?.reason === undefined ? {} : { reason: body.reason }),
            ...(body?.confirmExternalProcessStopped === undefined
              ? {}
              : { confirmExternalProcessStopped: body.confirmExternalProcessStopped }),
          })
          .catch(() => undefined);
        return reply.code(202).send({
          goalId: id,
          taskId,
          ...(body?.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/goals/:id/tasks/:taskId/skip',
    {
      schema: {
        params: GoalTaskParamsSchema,
        body: TaskSkipSchema,
        response: {
          200: Type.Unknown(),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        options.orchestratorRepository === undefined ||
        options.orchestratorEngine === undefined
      ) {
        return reply.code(503).send({
          error: {
            code: 'orchestrator_unavailable',
            message: 'Orchestrator execution is not configured.',
          },
        });
      }
      try {
        const { id, taskId } = request.params as { id: string; taskId: string };
        const body = request.body as {
          readonly idempotencyKey?: string;
          readonly expectedRevision?: number;
          readonly reason: string;
        };
        const result = options.orchestratorEngine.skipFutureTask(id, taskId, {
          reason: body.reason,
          ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
          ...(body.expectedRevision === undefined
            ? {}
            : { expectedRevision: body.expectedRevision }),
        });
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof OrchestratorBusyError) {
          return reply
            .code(409)
            .send({ error: { code: 'goal_control_conflict', message: error.message } });
        }
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/goals/:id/roadmap/reorder',
    {
      schema: {
        params: GoalParamsSchema,
        body: RoadmapReorderSchema,
        response: {
          200: Type.Unknown(),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (
        options.orchestratorRepository === undefined ||
        options.orchestratorEngine === undefined
      ) {
        return reply.code(503).send({
          error: {
            code: 'orchestrator_unavailable',
            message: 'Orchestrator execution is not configured.',
          },
        });
      }
      try {
        const { id } = request.params as { id: string };
        const body = request.body as {
          readonly idempotencyKey?: string;
          readonly expectedRevision?: number;
          readonly taskIds: readonly string[];
          readonly reason: string;
        };
        const result = options.orchestratorEngine.reorderFutureTasks(id, {
          taskIds: body.taskIds,
          reason: body.reason,
          ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
          ...(body.expectedRevision === undefined
            ? {}
            : { expectedRevision: body.expectedRevision }),
        });
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof OrchestratorBusyError) {
          return reply
            .code(409)
            .send({ error: { code: 'goal_control_conflict', message: error.message } });
        }
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/sessions',
    {
      schema: {
        querystring: SessionListQuerySchema,
        response: { 200: CursorPageSchema, 400: ErrorResponseSchema, 500: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const query = request.query as Record<string, unknown>;
        const filter: SessionListFilter = {
          ...(typeof query.project === 'string' ? { projectId: query.project } : {}),
          ...(typeof query.status === 'string' ? { status: query.status as SessionStatus } : {}),
          ...(query.includeHidden === true ? { includeHidden: true } : {}),
          ...(query.limit === undefined ? {} : { limit: parsePositiveInteger(query.limit) }),
          ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
        };
        return reply.send(options.repository.listSessions(filter));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/sessions/:id',
    {
      schema: {
        params: SessionParamsSchema,
        response: { 200: Type.Unknown(), 404: ErrorResponseSchema, 500: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const session = options.repository.getSession(id);
        const references = options.orchestratorRepository?.listSessionGoalReferences(id);
        return reply.send({
          ...session,
          ...(references === undefined ? {} : { orchestrator: { references } }),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/sessions/:id/hide',
    {
      schema: {
        params: SessionParamsSchema,
        response: {
          200: SessionVisibilityResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const session = options.repository.setSessionHidden(id, true);
        return reply.send({ id: session.id, hidden: true });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/api/sessions/:id/unhide',
    {
      schema: {
        params: SessionParamsSchema,
        response: {
          200: SessionVisibilityResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const session = options.repository.setSessionHidden(id, false);
        return reply.send({ id: session.id, hidden: false });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.delete(
    '/api/sessions/:id',
    {
      schema: {
        params: SessionParamsSchema,
        response: {
          200: SessionDeletedResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const deleted = options.repository.deleteSession(id);
        return reply.send({ id: deleted.id, deleted: true as const });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/sessions/:id/events',
    {
      schema: {
        params: SessionParamsSchema,
        querystring: EventQuerySchema,
        response: {
          200: CursorPageSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const after = query.after === undefined ? 0 : parseNonNegativeInteger(query.after);
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(options.repository.listEvents(id, after, limit));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/sessions/:id/turns/page',
    {
      schema: {
        params: SessionParamsSchema,
        querystring: TurnPageQuerySchema,
        response: {
          200: CursorPageSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const filter: TurnListFilter = {
          ...(typeof query.status === 'string'
            ? { status: query.status as NonNullable<TurnListFilter['status']> }
            : {}),
          ...(query.limit === undefined ? {} : { limit: parsePositiveInteger(query.limit) }),
          ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
        };
        return reply.send(options.repository.listTurnPage(id, filter));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/sessions/:id/turns',
    {
      schema: {
        params: SessionParamsSchema,
        querystring: TurnListQuerySchema,
        response: {
          200: Type.Array(Type.Unknown()),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const filter: TurnListFilter = {
          ...(typeof query.status === 'string'
            ? { status: query.status as NonNullable<TurnListFilter['status']> }
            : {}),
          ...(query.limit === undefined ? {} : { limit: parsePositiveInteger(query.limit) }),
        };
        return reply.send(options.repository.listTurns(id, filter));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/turns/:id',
    {
      schema: {
        params: SessionParamsSchema,
        response: { 200: Type.Unknown(), 404: ErrorResponseSchema, 500: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        return reply.send(options.repository.getTurn(id));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/turns/:id/events',
    {
      schema: {
        params: SessionParamsSchema,
        querystring: EventQuerySchema,
        response: {
          200: CursorPageSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const after = query.after === undefined ? 0 : parseNonNegativeInteger(query.after);
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(options.repository.listEventsForTurn(id, after, limit));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/sessions/:id/eta-snapshots',
    {
      schema: {
        params: SessionParamsSchema,
        response: {
          200: Type.Array(Type.Unknown()),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        return reply.send(options.repository.listEtaSnapshots(id));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/turns/:id/evidence/page',
    {
      schema: {
        params: SessionParamsSchema,
        querystring: EvidencePageQuerySchema,
        response: {
          200: CursorPageSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        return reply.send(
          options.repository.listObserverEvidenceForTurnPage(id, {
            ...(query.limit === undefined ? {} : { limit: parsePositiveInteger(query.limit) }),
            ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/turns/:id/evidence',
    {
      schema: {
        params: SessionParamsSchema,
        querystring: EvidenceQuerySchema,
        response: {
          200: Type.Array(Type.Unknown()),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(options.repository.listObserverEvidenceForTurn(id, limit));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/sessions/:id/evidence/page',
    {
      schema: {
        params: SessionParamsSchema,
        querystring: EvidencePageQuerySchema,
        response: {
          200: CursorPageSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        return reply.send(
          options.repository.listObserverEvidencePage(id, {
            ...(query.limit === undefined ? {} : { limit: parsePositiveInteger(query.limit) }),
            ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/sessions/:id/evidence',
    {
      schema: {
        params: SessionParamsSchema,
        querystring: EvidenceQuerySchema,
        response: {
          200: Type.Array(Type.Unknown()),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const query = request.query as Record<string, unknown>;
        const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
        return reply.send(options.repository.listObserverEvidence(id, limit));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get(
    '/api/projects/:id/overview',
    {
      schema: {
        params: SessionParamsSchema,
        response: {
          200: ProjectOverviewSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        return reply.send(options.repository.getProjectOverview(id));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  return app;
}

function parsePositiveInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new StorageError('Invalid positive integer.', 'invalid_query');
  return parsed;
}

function parseNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new StorageError('Invalid non-negative integer.', 'invalid_query');
  return parsed;
}

interface ControlCommandBody {
  readonly idempotencyKey?: string;
  readonly expectedRevision?: number;
  readonly confirmExternalProcessStopped?: boolean;
  readonly reason?: string;
}

function parseControlCommandBody(value: unknown): ControlCommandBody | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StorageError('Control command body must be an object.', 'invalid_request');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'idempotencyKey',
    'expectedRevision',
    'confirmExternalProcessStopped',
    'reason',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new StorageError('Control command body contains an unknown field.', 'invalid_request');
  }
  const idempotencyKey = record.idempotencyKey;
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' ||
      idempotencyKey.trim().length === 0 ||
      idempotencyKey.length > 200)
  ) {
    throw new StorageError(
      'idempotencyKey must be a non-empty string of at most 200 characters.',
      'invalid_request',
    );
  }
  const expectedRevision = record.expectedRevision;
  if (
    expectedRevision !== undefined &&
    (typeof expectedRevision !== 'number' ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 0)
  ) {
    throw new StorageError('expectedRevision must be a non-negative integer.', 'invalid_request');
  }
  const confirmExternalProcessStopped = record.confirmExternalProcessStopped;
  if (
    confirmExternalProcessStopped !== undefined &&
    typeof confirmExternalProcessStopped !== 'boolean'
  ) {
    throw new StorageError('confirmExternalProcessStopped must be a boolean.', 'invalid_request');
  }
  const reason = record.reason;
  if (
    reason !== undefined &&
    (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 4_000)
  ) {
    throw new StorageError(
      'reason must be a non-empty string of at most 4000 characters.',
      'invalid_request',
    );
  }
  return {
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(confirmExternalProcessStopped === undefined ? {} : { confirmExternalProcessStopped }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function controlOptionsFromBody(body: ControlCommandBody | undefined): {
  readonly idempotencyKey?: string;
  readonly expectedRevision?: number;
} {
  if (body === undefined) return {};
  return {
    ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
    ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }),
  };
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof StorageNotFoundError) {
    return reply.code(404).send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof OrchestratorBusyError) {
    return reply
      .code(409)
      .send({ error: { code: 'goal_control_conflict', message: error.message } });
  }
  if (error instanceof StorageError) {
    const status =
      error.code === 'conflict' ||
      error.code === 'command_in_progress' ||
      error.code === 'idempotency_conflict' ||
      error.code === 'revision_conflict' ||
      error.code === 'command_rejected' ||
      error.code === 'invalid_orchestrator_state'
        ? 409
        : error.code === 'invalid_query' || error.code === 'invalid_request'
          ? 400
          : 500;
    return reply.code(status).send({ error: { code: error.code, message: error.message } });
  }
  return reply
    .code(500)
    .send({ error: { code: 'internal_error', message: 'Internal server error.' } });
}

export type ServerRequest = FastifyRequest;
export * from './runtime.js';

interface ObservedSession {
  readonly updatedAt: number;
  readonly status: SessionStatus;
  readonly lastEventSeq: number;
}

interface ObservedTurn {
  readonly sessionId: string;
  readonly updatedAt: number;
  readonly status: StoredTurn['status'];
}

interface ObservedGoal {
  readonly updatedAt: number;
  readonly status: string;
}

interface ObservedTask {
  readonly goalId: string;
  readonly updatedAt: number;
  readonly status: string;
}

interface ObservedAttempt {
  readonly taskId: string;
  readonly updatedAt: number;
  readonly status: string;
}

interface ObservedVerification {
  readonly taskId: string;
  readonly updatedAt: number;
  readonly status: string;
}

interface OrchestratorObservations {
  readonly observedGoals: Map<string, ObservedGoal>;
  readonly observedTasks: Map<string, ObservedTask>;
  readonly observedAttempts: Map<string, ObservedAttempt>;
  readonly observedVerifications: Map<string, ObservedVerification>;
  readonly observedGoalEvents: Map<string, number>;
  readonly observedGoalMetrics: Map<string, string>;
  readonly observedGoalNotifications: Map<string, string>;
}

function publishOrchestratorNotification(
  liveHub: LiveHub,
  notification: OrchestratorRepositoryNotification,
  repository?: OrchestratorRepository,
): void {
  if (notification.type === 'goal.created' || notification.type === 'goal.updated') {
    liveHub.publish({
      type: notification.type,
      goalId: notification.goal.id,
      payload: { status: notification.goal.status },
    });
    return;
  }
  if (notification.type === 'task.created' || notification.type === 'task.updated') {
    liveHub.publish({
      type: notification.type,
      goalId: notification.task.goalId,
      taskId: notification.task.id,
      payload: { status: notification.task.status, sequence: notification.task.sequence },
    });
    return;
  }
  if (notification.type === 'attempt.created' || notification.type === 'attempt.updated') {
    publishOrchestratorAttempt(liveHub, repository, notification.attempt, notification.type);
    return;
  }
  if (notification.type === 'verification.created') {
    publishOrchestratorVerification(liveHub, repository, notification.verification);
    return;
  }
  if (notification.type === 'metric.created') {
    publishOrchestratorMetric(liveHub, notification.metric);
    return;
  }
  if (
    notification.type === 'notification.created' ||
    notification.type === 'notification.updated'
  ) {
    publishOrchestratorNotificationUpdate(liveHub, notification.notification, notification.type);
    return;
  }
  if (notification.type !== 'event.appended') return;
  publishOrchestratorEvent(liveHub, notification.event);
}

function publishOrchestratorMetric(liveHub: LiveHub, metric: StoredGoalMetricSnapshot): void {
  liveHub.publish({
    type: 'goal.metrics.updated',
    goalId: metric.goalId,
    ...(metric.taskId === undefined ? {} : { taskId: metric.taskId }),
    payload: {
      progress: metric.progress,
      confidence: metric.confidence,
      capturedAt: metric.capturedAt,
    },
  });
}

function publishOrchestratorNotificationUpdate(
  liveHub: LiveHub,
  notification: StoredOrchestratorNotification,
  type: 'notification.created' | 'notification.updated',
): void {
  liveHub.publish({
    type:
      type === 'notification.created' ? 'goal.notification.created' : 'goal.notification.updated',
    goalId: notification.goalId,
    payload: {
      notificationId: notification.id,
      eventKey: notification.eventKey,
      kind: notification.kind,
      status: notification.status,
    },
  });
}

function publishOrchestratorEvent(liveHub: LiveHub, event: StoredOrchestratorEvent): void {
  liveHub.publish({
    type: 'event.appended',
    goalId: event.goalId,
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
    seq: event.seq,
    cursor: String(event.seq),
    payload: { eventType: event.type },
  });
}

function publishOrchestratorAttempt(
  liveHub: LiveHub,
  repository: OrchestratorRepository | undefined,
  attempt: StoredAttempt,
  type: 'attempt.created' | 'attempt.updated' = 'attempt.updated',
): void {
  const goalId = repository === undefined ? undefined : repository.getTask(attempt.taskId).goalId;
  liveHub.publish({
    type,
    ...(goalId === undefined ? {} : { goalId }),
    attemptId: attempt.id,
    taskId: attempt.taskId,
    payload: { status: attempt.status, taskId: attempt.taskId },
  });
}

function publishOrchestratorVerification(
  liveHub: LiveHub,
  repository: OrchestratorRepository | undefined,
  verification: StoredVerificationRun,
): void {
  const goalId =
    repository === undefined ? undefined : repository.getTask(verification.taskId).goalId;
  liveHub.publish({
    type: 'verification.created',
    ...(goalId === undefined ? {} : { goalId }),
    taskId: verification.taskId,
    payload: { status: verification.status, verificationId: verification.id },
  });
}

function publishTurnNotification(
  liveHub: LiveHub,
  type: 'turn.created' | 'turn.updated' | 'turn.finished',
  turn: StoredTurn,
): void {
  liveHub.publish({
    type,
    sessionId: turn.sessionId,
    payload: {
      turnId: turn.id,
      sequence: turn.sequence,
      status: turn.status,
    },
  });
}

function hydrateObservedSessions(
  repository: StorageRepository,
  observedSessions: Map<string, ObservedSession>,
): void {
  for (const session of listAllSessions(repository, true)) {
    let cursor = 0;
    let lastEventSeq = 0;
    while (true) {
      const events = repository.listEvents(session.id, cursor, 100);
      lastEventSeq = events.items.at(-1)?.seq ?? lastEventSeq;
      if (events.nextCursor === undefined) break;
      cursor = Number(events.nextCursor);
    }
    observedSessions.set(session.id, {
      updatedAt: session.updatedAt,
      status: session.status,
      lastEventSeq,
    });
  }
}

function hydrateObservedTurns(
  repository: StorageRepository,
  observedTurns: Map<string, ObservedTurn>,
): void {
  for (const session of listAllSessions(repository, true)) {
    for (const turn of repository.listTurns(session.id)) {
      observedTurns.set(turn.id, {
        sessionId: turn.sessionId,
        updatedAt: turn.updatedAt,
        status: turn.status,
      });
    }
  }
}

function hydrateObservedOrchestrator(
  repository: OrchestratorRepository,
  observedGoals: Map<string, ObservedGoal>,
  observedTasks: Map<string, ObservedTask>,
  observedAttempts: Map<string, ObservedAttempt>,
  observedVerifications: Map<string, ObservedVerification>,
  observedGoalEvents: Map<string, number>,
  observedGoalMetrics: Map<string, string>,
  observedGoalNotifications: Map<string, string>,
): void {
  for (const goal of repository.listGoals()) {
    observedGoals.set(goal.id, { updatedAt: goal.updatedAt, status: goal.status });
    observedGoalEvents.set(goal.id, findLastOrchestratorEventSeq(repository, goal.id));
    const latestMetric = repository.listGoalMetricSnapshots(goal.id, 1)[0];
    if (latestMetric !== undefined) observedGoalMetrics.set(goal.id, latestMetric.id);
    const latestNotification = repository.listOrchestratorNotifications(goal.id, { limit: 1 })[0];
    if (latestNotification !== undefined) {
      observedGoalNotifications.set(goal.id, notificationMarker(latestNotification));
    }
    for (const task of repository.listTasks(goal.id)) {
      observedTasks.set(task.id, {
        goalId: task.goalId,
        updatedAt: task.updatedAt,
        status: task.status,
      });
      for (const attempt of repository.listAttempts(task.id)) {
        observedAttempts.set(attempt.id, {
          taskId: attempt.taskId,
          updatedAt: attempt.updatedAt,
          status: attempt.status,
        });
      }
      for (const verification of repository.listVerificationRuns(task.id)) {
        observedVerifications.set(verification.id, {
          taskId: verification.taskId,
          updatedAt: verification.updatedAt,
          status: verification.status,
        });
      }
    }
  }
}

function findLastOrchestratorEventSeq(repository: OrchestratorRepository, goalId: string): number {
  let after = 0;
  while (true) {
    const page = repository.listEvents(goalId, after, 500);
    const last = page.at(-1);
    if (last === undefined) return after;
    after = last.seq;
    if (page.length < 500) return after;
  }
}

interface ReliabilityMetricsFilter {
  readonly provider?: string;
  readonly workspace?: string;
  readonly includeArchived: boolean;
  readonly from?: number;
  readonly to?: number;
}

function collectOrchestratorRecords(
  repository: OrchestratorRepository,
  filter: ReliabilityMetricsFilter,
): {
  readonly goals: readonly StoredGoal[];
  readonly tasks: readonly StoredTask[];
  readonly attempts: readonly StoredAttempt[];
  readonly verifications: readonly StoredVerificationRun[];
  readonly events: readonly StoredOrchestratorEvent[];
} {
  const goals: StoredGoal[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = repository.listGoalPage({
      limit: 100,
      includeArchived: filter.includeArchived,
      ...(filter.provider === undefined ? {} : { provider: filter.provider }),
      ...(filter.workspace === undefined ? {} : { workspace: filter.workspace }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    goals.push(
      ...page.items.filter(
        (goal) =>
          (filter.from === undefined || goal.createdAt >= filter.from) &&
          (filter.to === undefined || goal.createdAt <= filter.to),
      ),
    );
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  const tasks: StoredTask[] = [];
  const attempts: StoredAttempt[] = [];
  const verifications: StoredVerificationRun[] = [];
  const events: StoredOrchestratorEvent[] = [];
  for (const goal of goals) {
    const goalTasks = repository.listTasks(goal.id);
    tasks.push(...goalTasks);
    for (const task of goalTasks) {
      attempts.push(...repository.listAttempts(task.id));
      verifications.push(...repository.listVerificationRuns(task.id));
    }
    events.push(...repository.listEvents(goal.id));
  }
  return { goals, tasks, attempts, verifications, events };
}

function rememberOrchestratorNotification(
  notification: OrchestratorRepositoryNotification,
  observedGoals: Map<string, ObservedGoal>,
  observedTasks: Map<string, ObservedTask>,
  observedAttempts: Map<string, ObservedAttempt>,
  observedVerifications: Map<string, ObservedVerification>,
  observedGoalEvents: Map<string, number>,
  observedGoalMetrics: Map<string, string>,
  observedGoalNotifications: Map<string, string>,
): void {
  if (notification.type === 'goal.created' || notification.type === 'goal.updated') {
    observedGoals.set(notification.goal.id, {
      updatedAt: notification.goal.updatedAt,
      status: notification.goal.status,
    });
    return;
  }
  if (notification.type === 'task.created' || notification.type === 'task.updated') {
    observedTasks.set(notification.task.id, {
      goalId: notification.task.goalId,
      updatedAt: notification.task.updatedAt,
      status: notification.task.status,
    });
    return;
  }
  if (notification.type === 'attempt.created' || notification.type === 'attempt.updated') {
    observedAttempts.set(notification.attempt.id, {
      taskId: notification.attempt.taskId,
      updatedAt: notification.attempt.updatedAt,
      status: notification.attempt.status,
    });
    return;
  }
  if (notification.type === 'verification.created') {
    observedVerifications.set(notification.verification.id, {
      taskId: notification.verification.taskId,
      updatedAt: notification.verification.updatedAt,
      status: notification.verification.status,
    });
    return;
  }
  if (notification.type === 'metric.created') {
    observedGoalMetrics.set(notification.metric.goalId, notification.metric.id);
    return;
  }
  if (
    notification.type === 'notification.created' ||
    notification.type === 'notification.updated'
  ) {
    observedGoalNotifications.set(
      notification.notification.goalId,
      notificationMarker(notification.notification),
    );
    return;
  }
  if (notification.type !== 'event.appended') return;
  observedGoalEvents.set(
    notification.event.goalId,
    Math.max(observedGoalEvents.get(notification.event.goalId) ?? 0, notification.event.seq),
  );
}

function pollExternalOrchestratorChanges(
  repository: OrchestratorRepository,
  liveHub: LiveHub,
  observations: OrchestratorObservations,
): void {
  for (const goal of repository.listGoals()) {
    const observedGoal = observations.observedGoals.get(goal.id);
    if (observedGoal === undefined) {
      liveHub.publish({
        type: 'goal.created',
        goalId: goal.id,
        payload: { status: goal.status },
      });
    } else if (observedGoal.updatedAt !== goal.updatedAt || observedGoal.status !== goal.status) {
      liveHub.publish({
        type: 'goal.updated',
        goalId: goal.id,
        payload: { status: goal.status },
      });
    }
    observations.observedGoals.set(goal.id, { updatedAt: goal.updatedAt, status: goal.status });

    const afterSeq = observations.observedGoalEvents.get(goal.id) ?? 0;
    const events = repository.listEvents(goal.id, afterSeq, 500);
    for (const event of events) publishOrchestratorEvent(liveHub, event);
    const lastEvent = events.at(-1);
    if (lastEvent !== undefined) observations.observedGoalEvents.set(goal.id, lastEvent.seq);

    const latestMetric = repository.listGoalMetricSnapshots(goal.id, 1)[0];
    if (
      latestMetric !== undefined &&
      observations.observedGoalMetrics.get(goal.id) !== latestMetric.id
    ) {
      publishOrchestratorMetric(liveHub, latestMetric);
      observations.observedGoalMetrics.set(goal.id, latestMetric.id);
    }

    const latestNotification = repository.listOrchestratorNotifications(goal.id, { limit: 1 })[0];
    if (
      latestNotification !== undefined &&
      observations.observedGoalNotifications.get(goal.id) !== notificationMarker(latestNotification)
    ) {
      const previousMarker = observations.observedGoalNotifications.get(goal.id);
      publishOrchestratorNotificationUpdate(
        liveHub,
        latestNotification,
        previousMarker === undefined ? 'notification.created' : 'notification.updated',
      );
      observations.observedGoalNotifications.set(goal.id, notificationMarker(latestNotification));
    }

    for (const task of repository.listTasks(goal.id)) {
      const observedTask = observations.observedTasks.get(task.id);
      if (observedTask === undefined) {
        liveHub.publish({
          type: 'task.created',
          goalId: task.goalId,
          taskId: task.id,
          payload: { status: task.status, sequence: task.sequence },
        });
      } else if (observedTask.updatedAt !== task.updatedAt || observedTask.status !== task.status) {
        liveHub.publish({
          type: 'task.updated',
          goalId: task.goalId,
          taskId: task.id,
          payload: { status: task.status, sequence: task.sequence },
        });
      }
      observations.observedTasks.set(task.id, {
        goalId: task.goalId,
        updatedAt: task.updatedAt,
        status: task.status,
      });
      for (const attempt of repository.listAttempts(task.id)) {
        const observedAttempt = observations.observedAttempts.get(attempt.id);
        if (
          observedAttempt === undefined ||
          observedAttempt.updatedAt !== attempt.updatedAt ||
          observedAttempt.status !== attempt.status
        ) {
          publishOrchestratorAttempt(
            liveHub,
            repository,
            attempt,
            observedAttempt === undefined ? 'attempt.created' : 'attempt.updated',
          );
        }
        observations.observedAttempts.set(attempt.id, {
          taskId: attempt.taskId,
          updatedAt: attempt.updatedAt,
          status: attempt.status,
        });
      }
      for (const verification of repository.listVerificationRuns(task.id)) {
        const observedVerification = observations.observedVerifications.get(verification.id);
        if (
          observedVerification === undefined ||
          observedVerification.updatedAt !== verification.updatedAt ||
          observedVerification.status !== verification.status
        ) {
          publishOrchestratorVerification(liveHub, repository, verification);
        }
        observations.observedVerifications.set(verification.id, {
          taskId: verification.taskId,
          updatedAt: verification.updatedAt,
          status: verification.status,
        });
      }
    }
  }
}

function listAllSessions(
  repository: StorageRepository,
  includeHidden = false,
): readonly StoredSession[] {
  const sessions: StoredSession[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = repository.listSessions({
      limit: 100,
      ...(includeHidden ? { includeHidden: true } : {}),
      ...(cursor === undefined ? {} : { cursor }),
    });
    sessions.push(...page.items);
    if (page.nextCursor === undefined) return sessions;
    cursor = page.nextCursor;
  }
}

function rememberNotification(
  observedSessions: Map<string, ObservedSession>,
  observedTurns: Map<string, ObservedTurn>,
  notification: RepositoryNotification,
): void {
  if (notification.type === 'session.deleted') {
    observedSessions.delete(notification.session.id);
    for (const [turnId, observedTurn] of observedTurns) {
      if (observedTurn.sessionId === notification.session.id) observedTurns.delete(turnId);
    }
    return;
  }
  if (
    notification.type === 'turn.created' ||
    notification.type === 'turn.updated' ||
    notification.type === 'turn.finished'
  ) {
    observedTurns.set(notification.turn.id, {
      sessionId: notification.turn.sessionId,
      updatedAt: notification.turn.updatedAt,
      status: notification.turn.status,
    });
    return;
  }
  const current = observedSessions.get(notification.session.id);
  observedSessions.set(notification.session.id, {
    updatedAt: notification.session.updatedAt,
    status: notification.session.status,
    lastEventSeq:
      notification.type === 'event.appended'
        ? Math.max(current?.lastEventSeq ?? 0, notification.event.seq)
        : (current?.lastEventSeq ?? 0),
  });
}

function isTerminalTurnStatus(status: StoredTurn['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

function notificationMarker(notification: StoredOrchestratorNotification): string {
  return [
    notification.id,
    notification.status,
    notification.deliveredAt ?? '',
    notification.readAt ?? '',
  ].join(':');
}
