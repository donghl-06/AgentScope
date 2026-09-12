import type { EtaResult } from '@agentscope/protocol';
import type {
  EventPage,
  Page,
  SessionListFilter,
  StoredObserverEvidence,
  StoredGoal,
  StoredSession,
  StoredTurn,
  TurnListFilter,
  EvidenceListFilter,
} from '@agentscope/storage';

export interface DashboardApiOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly webSocket?: typeof WebSocket;
}

export interface CreateGoalRequest {
  readonly workspace: string;
  readonly prompt: string;
  readonly provider: string;
}

export interface DashboardLiveNotification {
  readonly type:
    | 'hello'
    | 'subscribed'
    | 'session.created'
    | 'session.updated'
    | 'session.deleted'
    | 'turn.created'
    | 'turn.updated'
    | 'turn.finished'
    | 'event.appended'
    | 'project.updated'
    | 'goal.created'
    | 'goal.updated'
    | 'task.created'
    | 'task.updated'
    | 'attempt.created'
    | 'attempt.updated'
    | 'verification.created'
    | 'ping'
    | 'pong'
    | 'error';
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly goalId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
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
    if (filter.includeHidden === true) query.set('includeHidden', 'true');
    if (filter.limit !== undefined) query.set('limit', String(filter.limit));
    if (filter.cursor !== undefined) query.set('cursor', filter.cursor);
    return this.get<Page<StoredSession>>('/api/sessions', query);
  }

  listGoals(limit = 100): Promise<readonly StoredGoal[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.get<readonly StoredGoal[]>('/api/goals', query);
  }

  createGoal(input: CreateGoalRequest): Promise<{ goalId: string; goal: StoredGoal }> {
    return this.requestJson('/api/goals', 'POST', undefined, input);
  }

  getSession(sessionId: string): Promise<StoredSession> {
    return this.get<StoredSession>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  hideSession(sessionId: string): Promise<{ id: string; hidden: boolean }> {
    return this.mutate<{ id: string; hidden: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/hide`,
    );
  }

  unhideSession(sessionId: string): Promise<{ id: string; hidden: boolean }> {
    return this.mutate<{ id: string; hidden: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/unhide`,
    );
  }

  deleteSession(sessionId: string): Promise<{ id: string; deleted: true }> {
    return this.mutate<{ id: string; deleted: true }>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      'DELETE',
    );
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

  listTurnPage(sessionId: string, filter: TurnListFilter = {}): Promise<Page<StoredTurn>> {
    const query = new URLSearchParams();
    if (filter.status !== undefined) query.set('status', filter.status);
    if (filter.limit !== undefined) query.set('limit', String(filter.limit));
    if (filter.cursor !== undefined) query.set('cursor', filter.cursor);
    return this.get<Page<StoredTurn>>(
      `/api/sessions/${encodeURIComponent(sessionId)}/turns/page`,
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

  listObserverEvidencePage(
    sessionId: string,
    filter: EvidenceListFilter = {},
  ): Promise<Page<StoredObserverEvidence>> {
    const query = new URLSearchParams();
    if (filter.limit !== undefined) query.set('limit', String(filter.limit));
    if (filter.cursor !== undefined) query.set('cursor', filter.cursor);
    return this.get<Page<StoredObserverEvidence>>(
      `/api/sessions/${encodeURIComponent(sessionId)}/evidence/page`,
      query,
    );
  }

  listTurnEvidence(turnId: string, limit = 100): Promise<readonly StoredObserverEvidence[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.get<readonly StoredObserverEvidence[]>(
      `/api/turns/${encodeURIComponent(turnId)}/evidence`,
      query,
    );
  }

  listTurnEvidencePage(
    turnId: string,
    filter: EvidenceListFilter = {},
  ): Promise<Page<StoredObserverEvidence>> {
    const query = new URLSearchParams();
    if (filter.limit !== undefined) query.set('limit', String(filter.limit));
    if (filter.cursor !== undefined) query.set('cursor', filter.cursor);
    return this.get<Page<StoredObserverEvidence>>(
      `/api/turns/${encodeURIComponent(turnId)}/evidence/page`,
      query,
    );
  }

  listTurnEvents(turnId: string, after = 0, limit = 100): Promise<EventPage> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return this.get<EventPage>(`/api/turns/${encodeURIComponent(turnId)}/events`, query);
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
    return this.requestJson(pathname, 'GET', query);
  }

  private async mutate<T>(pathname: string, method: 'POST' | 'DELETE' = 'POST'): Promise<T> {
    return this.requestJson(pathname, method);
  }

  private async requestJson<T>(
    pathname: string,
    method: 'GET' | 'POST' | 'DELETE',
    query?: URLSearchParams,
    requestBody?: unknown,
  ): Promise<T> {
    const url = new URL(pathname, this.baseUrl || globalThis.location.origin);
    if (query !== undefined) url.search = query.toString();
    let response: Response;
    try {
      response =
        method === 'GET'
          ? await this.request(url.toString())
          : await this.request(url.toString(), {
              method,
              ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
              ...(requestBody === undefined
                ? {}
                : { headers: { 'content-type': 'application/json' } }),
            });
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
