import type { EtaResult } from '@agentscope/protocol';
import type {
  EventPage,
  Page,
  SessionListFilter,
  StoredObserverEvidence,
  StoredSession,
  StoredTurn,
} from '@agentscope/storage';

export interface DashboardApiOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly webSocket?: typeof WebSocket;
}

export interface DashboardLiveNotification {
  readonly type:
    | 'hello'
    | 'subscribed'
    | 'session.created'
    | 'session.updated'
    | 'turn.created'
    | 'turn.updated'
    | 'event.appended'
    | 'project.updated'
    | 'ping'
    | 'pong'
    | 'error';
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly seq?: number;
  readonly cursor?: string;
  readonly payload?: Record<string, unknown>;
  readonly protocolVersion?: string;
}

export class DashboardApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'DashboardApiError';
  }
}

export class DashboardApi {
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;
  private readonly WebSocketConstructor: typeof WebSocket;

  constructor(options: DashboardApiOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? import.meta.env.VITE_API_BASE_URL ?? '');
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.WebSocketConstructor = options.webSocket ?? globalThis.WebSocket;
  }

  listSessions(filter: SessionListFilter = {}): Promise<Page<StoredSession>> {
    const query = new URLSearchParams();
    if (filter.projectId !== undefined) query.set('project', filter.projectId);
    if (filter.status !== undefined) query.set('status', filter.status);
    if (filter.limit !== undefined) query.set('limit', String(filter.limit));
    if (filter.cursor !== undefined) query.set('cursor', filter.cursor);
    return this.get<Page<StoredSession>>('/api/sessions', query);
  }

  getSession(sessionId: string): Promise<StoredSession> {
    return this.get<StoredSession>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  listEvents(sessionId: string, after = 0, limit = 100): Promise<EventPage> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return this.get<EventPage>(`/api/sessions/${encodeURIComponent(sessionId)}/events`, query);
  }

  listTurns(sessionId: string, status?: StoredTurn['status']): Promise<readonly StoredTurn[]> {
    const query = status === undefined ? undefined : new URLSearchParams({ status });
    return this.get<readonly StoredTurn[]>(
      '/api/sessions/' + encodeURIComponent(sessionId) + '/turns',
      query,
    );
  }

  listEtaSnapshots(sessionId: string): Promise<readonly EtaResult[]> {
    return this.get<readonly EtaResult[]>(
      `/api/sessions/${encodeURIComponent(sessionId)}/eta-snapshots`,
    );
  }

  listObserverEvidence(sessionId: string, limit = 100): Promise<readonly StoredObserverEvidence[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.get<readonly StoredObserverEvidence[]>(
      `/api/sessions/${encodeURIComponent(sessionId)}/evidence`,
      query,
    );
  }

  connectLive(onMessage: (message: DashboardLiveNotification) => void): WebSocket {
    const url = new URL('/ws', this.baseUrl || globalThis.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new this.WebSocketConstructor(url.toString());
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as DashboardLiveNotification;
        onMessage(message);
      } catch {
        // Ignore malformed live messages; the next HTTP refresh remains authoritative.
      }
    });
    return socket;
  }

  private async get<T>(pathname: string, query?: URLSearchParams): Promise<T> {
    const url = new URL(pathname, this.baseUrl || globalThis.location.origin);
    if (query !== undefined) url.search = query.toString();
    let response: Response;
    try {
      response = await this.request(url.toString());
    } catch (error) {
      throw new DashboardApiError('AgentScope server is unavailable.', 0, error);
    }
    const body = await readJson(response);
    if (!response.ok) {
      const message = isErrorBody(body)
        ? body.error.message
        : `AgentScope server returned HTTP ${response.status}.`;
      throw new DashboardApiError(message, response.status, body);
    }
    return body as T;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, '');
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isErrorBody(value: unknown): value is { error: { message: string } } {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = value.error;
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  );
}
