export interface LiveSocket {
  send(payload: string): void;
  close?(): void;
}

export interface LiveNotification {
  readonly type: 'session.created' | 'session.updated' | 'event.appended' | 'project.updated';
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly seq?: number;
  readonly cursor?: string;
  readonly payload?: Record<string, unknown>;
}

interface ClientState {
  readonly socket: LiveSocket;
  sessionIds?: ReadonlySet<string>;
  projectIds?: ReadonlySet<string>;
}

export class LiveHub {
  private readonly clients = new Map<LiveSocket, ClientState>();

  attach(socket: LiveSocket, protocolVersion = '0.1'): () => void {
    this.clients.set(socket, { socket });
    this.send(socket, { type: 'hello', protocolVersion });
    return () => this.detach(socket);
  }

  detach(socket: LiveSocket): void {
    this.clients.delete(socket);
  }

  close(): void {
    for (const socket of this.clients.keys()) {
      this.detach(socket);
      try {
        socket.close?.();
      } catch {
        // A closing client must not prevent other clients from being released.
      }
    }
  }

  handleMessage(socket: LiveSocket, raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.send(socket, { type: 'error', code: 'invalid_json' });
      return;
    }
    if (!isRecord(message) || typeof message.type !== 'string') {
      this.send(socket, { type: 'error', code: 'invalid_message' });
      return;
    }
    if (message.type === 'ping') {
      this.send(socket, { type: 'pong' });
      return;
    }
    if (message.type !== 'subscribe') {
      this.send(socket, { type: 'error', code: 'unsupported_message' });
      return;
    }
    const state = this.clients.get(socket);
    if (state === undefined) return;
    const sessionIds = stringSet(message.sessionIds);
    const projectIds = stringSet(message.projectIds);
    this.clients.set(socket, {
      ...state,
      ...(sessionIds === undefined ? {} : { sessionIds }),
      ...(projectIds === undefined ? {} : { projectIds }),
    });
    this.send(socket, {
      type: 'subscribed',
      sessionIds: sessionIds === undefined ? [] : [...sessionIds],
      projectIds: projectIds === undefined ? [] : [...projectIds],
    });
  }

  publish(notification: LiveNotification): void {
    for (const state of this.clients.values()) {
      if (!matches(state, notification)) continue;
      this.send(state.socket, notification);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private send(socket: LiveSocket, payload: unknown): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      this.detach(socket);
      socket.close?.();
    }
  }
}

function matches(state: ClientState, notification: LiveNotification): boolean {
  if (state.sessionIds !== undefined && notification.sessionId !== undefined) {
    if (!state.sessionIds.has(notification.sessionId)) return false;
  } else if (state.sessionIds !== undefined && notification.sessionId === undefined) {
    return false;
  }
  if (state.projectIds !== undefined && notification.projectId !== undefined) {
    if (!state.projectIds.has(notification.projectId)) return false;
  } else if (state.projectIds !== undefined && notification.projectId === undefined) {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringSet(value: unknown): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return new Set();
  return new Set(value);
}
