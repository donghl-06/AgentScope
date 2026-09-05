import websocket from '@fastify/websocket';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type { SessionStatus } from '@agentscope/protocol';
import { reduceSessionState } from '@agentscope/core';
import {
  type ProjectionVerification,
  StorageError,
  StorageNotFoundError,
  type SessionListFilter,
  type StorageRepository,
} from '@agentscope/storage';

import { LiveHub } from './live-hub.js';

const ErrorResponseSchema = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
});
const SessionListQuerySchema = Type.Object({
  project: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
});
const SessionParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const EventQuerySchema = Type.Object({
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const EvidenceQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
const CursorPageSchema = Type.Object({
  items: Type.Array(Type.Unknown()),
  nextCursor: Type.Optional(Type.String()),
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

export interface ServerOptions {
  readonly repository: StorageRepository;
  readonly protocolVersion?: string;
  readonly liveHub?: LiveHub;
  readonly recoverOnStart?: boolean;
  readonly heartbeatIntervalMs?: number;
  readonly maxWebSocketPayloadBytes?: number;
  readonly onProjectionMismatch?: (diagnostic: ProjectionVerification) => void;
}

export function createServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const protocolVersion = options.protocolVersion ?? '0.1';
  const liveHub = options.liveHub ?? new LiveHub();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const maxWebSocketPayloadBytes = options.maxWebSocketPayloadBytes ?? 64 * 1024;
  if (!Number.isFinite(maxWebSocketPayloadBytes) || maxWebSocketPayloadBytes <= 0) {
    throw new RangeError('maxWebSocketPayloadBytes must be positive.');
  }
  for (const diagnostic of options.repository.verifyNonTerminalProjections(reduceSessionState)) {
    if (!diagnostic.matches) options.onProjectionMismatch?.(diagnostic);
  }
  if (options.recoverOnStart !== false) options.repository.recoverInFlightSessions();
  const unsubscribeRepository = options.repository.subscribe((notification) => {
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
  app.addHook('onClose', () => {
    unsubscribeRepository();
    stopHeartbeat();
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
        return reply.send(options.repository.getSession(id));
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

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof StorageNotFoundError) {
    return reply.code(404).send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof StorageError) {
    const status = error.code === 'conflict' ? 409 : error.code === 'invalid_query' ? 400 : 500;
    return reply.code(status).send({ error: { code: error.code, message: error.message } });
  }
  return reply
    .code(500)
    .send({ error: { code: 'internal_error', message: 'Internal server error.' } });
}

export type ServerRequest = FastifyRequest;
export * from './runtime.js';
