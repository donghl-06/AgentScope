export interface LiveSocket {
  send(payload: string): void;
  ping?(): void;
  close?(): void;
  readonly bufferedAmount?: number;
}

export interface LiveNotification {
  readonly type:
    | 'session.created'
    | 'session.updated'
    | 'turn.created'
    | 'turn.updated'
    | 'turn.finished'
    | 'event.appended'
    | 'project.updated';
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly seq?: number;
  readonly cursor?: string;
  readonly payload?: Record<string, unknown>;
}

export interface LiveHubDiagnostics {
  readonly clientCount: number;
  readonly notificationsPublished: number;
  readonly notificationsDelivered: number;
  readonly droppedNotifications: number;
  readonly slowClientDisconnects: number;
  readonly sendFailures: number;
  readonly invalidMessages: number;
  readonly unsupportedMessages: number;
}

interface ClientState {
  readonly socket: LiveSocket;
  readonly alive: boolean;
  sessionIds?: ReadonlySet<string>;
  projectIds?: ReadonlySet<string>;
}

export class LiveHub {
  private readonly clients = new Map<LiveSocket, ClientState>();
  private readonly maxBufferedBytes: number;
  private notificationsPublished = 0;
  private notificationsDelivered = 0;
  private droppedNotifications = 0;
  private slowClientDisconnects = 0;
  private sendFailures = 0;
  private invalidMessages = 0;
  private unsupportedMessages = 0;

  constructor(options: { readonly maxBufferedBytes?: number } = {}) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? 256 * 1024;
    if (!Number.isFinite(this.maxBufferedBytes) || this.maxBufferedBytes <= 0) {
      throw new RangeError('maxBufferedBytes must be positive.');
    }
  }

  attach(socket: LiveSocket, protocolVersion = '0.1'): () => void {
    this.clients.set(socket, { socket, alive: true });
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

  markAlive(socket: LiveSocket): void {
    const state = this.clients.get(socket);
    if (state !== undefined && !state.alive) this.clients.set(socket, { ...state, alive: true });
  }

  heartbeat(): void {
    for (const state of this.clients.values()) {
      if (!state.alive) {
        this.detach(state.socket);
        state.socket.close?.();
        continue;
      }
      this.clients.set(state.socket, { ...state, alive: false });
      try {
        if (state.socket.ping === undefined) this.send(state.socket, { type: 'ping' });
        else state.socket.ping();
      } catch {
        this.detach(state.socket);
        state.socket.close?.();
      }
    }
  }

  startHeartbeat(intervalMs = 30_000): () => void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError('Heartbeat interval must be positive.');
    }
    const timer = setInterval(() => this.heartbeat(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  handleMessage(socket: LiveSocket, raw: string): void {
    this.markAlive(socket);
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.invalidMessages += 1;
      this.send(socket, { type: 'error', code: 'invalid_json' });
      return;
    }
    if (!isRecord(message) || typeof message.type !== 'string') {
      this.invalidMessages += 1;
      this.send(socket, { type: 'error', code: 'invalid_message' });
      return;
    }
    if (message.type === 'ping') {
      this.send(socket, { type: 'pong' });
      return;
    }
    if (message.type === 'pong') return;
    if (message.type !== 'subscribe') {
      this.unsupportedMessages += 1;
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
    this.notificationsPublished += 1;
    for (const state of this.clients.values()) {
      if (!matches(state, notification)) continue;
      if ((state.socket.bufferedAmount ?? 0) > this.maxBufferedBytes) {
        this.droppedNotifications += 1;
        this.slowClientDisconnects += 1;
        this.detach(state.socket);
        state.socket.close?.();
        continue;
      }
      if (this.send(state.socket, notification)) this.notificationsDelivered += 1;
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  diagnostics(): LiveHubDiagnostics {
    return {
      clientCount: this.clientCount,
      notificationsPublished: this.notificationsPublished,
      notificationsDelivered: this.notificationsDelivered,
      droppedNotifications: this.droppedNotifications,
      slowClientDisconnects: this.slowClientDisconnects,
      sendFailures: this.sendFailures,
      invalidMessages: this.invalidMessages,
      unsupportedMessages: this.unsupportedMessages,
    };
  }

  private send(socket: LiveSocket, payload: unknown): boolean {
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      this.sendFailures += 1;
      this.detach(socket);
      socket.close?.();
      return false;
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
