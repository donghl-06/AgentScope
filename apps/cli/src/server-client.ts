import type { EventPage, Page, SessionListFilter, StoredSession } from '@agentscope/storage';

export interface ServerClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

export class CliServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'CliServerError';
  }
}

export class ServerClient {
  private readonly baseUrl: string;
  private readonly request: typeof fetch;

  constructor(options: ServerClientOptions) {
    this.baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
    this.request = options.fetch ?? fetch;
  }

  async listSessions(filter: SessionListFilter = {}): Promise<Page<StoredSession>> {
    const query = new URLSearchParams();
    if (filter.projectId !== undefined) query.set('project', filter.projectId);
    if (filter.status !== undefined) query.set('status', filter.status);
    if (filter.limit !== undefined) query.set('limit', String(filter.limit));
    if (filter.cursor !== undefined) query.set('cursor', filter.cursor);
    return this.get<Page<StoredSession>>('api/sessions', query);
  }

  getSession(sessionId: string): Promise<StoredSession> {
    return this.get<StoredSession>(`api/sessions/${encodeURIComponent(sessionId)}`);
  }

  listEvents(sessionId: string, after = 0, limit = 100): Promise<EventPage> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return this.get<EventPage>(`api/sessions/${encodeURIComponent(sessionId)}/events`, query);
  }

  private async get<T>(pathname: string, query?: URLSearchParams): Promise<T> {
    const url = new URL(pathname, this.baseUrl);
    if (query !== undefined) url.search = query.toString();
    let response: Response;
    try {
      response = await this.request(url.toString());
    } catch (error) {
      throw new CliServerError('AgentScope server is unavailable.', 0, error);
    }
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      throw new CliServerError(
        `AgentScope server returned HTTP ${response.status}.`,
        response.status,
        body,
      );
    }
    return body as T;
  }
}

export function formatServerJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
