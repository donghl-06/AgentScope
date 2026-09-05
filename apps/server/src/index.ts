import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type { SessionStatus } from '@agentscope/protocol';
import {
  StorageError,
  StorageNotFoundError,
  type SessionListFilter,
  type StorageRepository,
} from '@agentscope/storage';

import { LiveHub } from './live-hub.js';

export interface ServerOptions {
  readonly repository: StorageRepository;
  readonly protocolVersion?: string;
  readonly liveHub?: LiveHub;
}

export function createServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const protocolVersion = options.protocolVersion ?? '0.1';
  const liveHub = options.liveHub ?? new LiveHub();
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
  });

  void app.register(websocket);

  app.get('/healthz', async () => ({ status: 'ok', protocolVersion }));

  app.get('/api/sessions', async (request, reply) => {
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
  });

  app.get('/api/sessions/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return reply.send(options.repository.getSession(id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/sessions/:id/events', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const query = request.query as Record<string, unknown>;
      const after = query.after === undefined ? 0 : parseNonNegativeInteger(query.after);
      const limit = query.limit === undefined ? 100 : parsePositiveInteger(query.limit);
      return reply.send(options.repository.listEvents(id, after, limit));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/projects/:id/overview', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return reply.send(options.repository.getProjectOverview(id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/ws', { websocket: true }, (socket) => {
    const detach = liveHub.attach(socket, protocolVersion);
    socket.on('message', (raw: { toString(): string }) => {
      liveHub.handleMessage(socket, raw.toString());
    });
    socket.on('close', detach);
  });

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
