import type {
  EventPage,
  GoalListFilter,
  InstructionKind,
  InstructionSource,
  InstructionStatus,
  Page,
  SessionListFilter,
  StoredGoal,
  StoredGoalInstruction,
  StoredSession,
} from '@agentscope/storage';

export interface GoalDetailResponse {
  readonly goal: StoredGoal;
  readonly tasks: readonly unknown[];
  readonly taskDetails: readonly unknown[];
  readonly events: readonly unknown[];
}

export interface InstructionSubmitRequest {
  readonly kind: InstructionKind;
  readonly content: string;
  readonly source?: InstructionSource;
  readonly baseRevision?: number;
  readonly idempotencyKey?: string;
  readonly expectedRevision?: number;
}

export interface GoalContinueRequest {
  readonly idempotencyKey?: string;
  readonly expectedRevision?: number;
  readonly confirmExternalProcessStopped?: boolean;
}

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

  listGoals(filter: Pick<GoalListFilter, 'limit'> = {}): Promise<readonly StoredGoal[]> {
    const query = new URLSearchParams();
    if (filter.limit !== undefined) query.set('limit', String(filter.limit));
    return this.get<readonly StoredGoal[]>('api/goals', query);
  }

  getGoal(goalId: string): Promise<GoalDetailResponse> {
    return this.get<GoalDetailResponse>(`api/goals/${encodeURIComponent(goalId)}`);
  }

  listInstructions(
    goalId: string,
    options: { readonly status?: InstructionStatus; readonly limit?: number } = {},
  ): Promise<readonly StoredGoalInstruction[]> {
    const query = new URLSearchParams();
    if (options.status !== undefined) query.set('status', options.status);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    return this.get<readonly StoredGoalInstruction[]>(
      `api/goals/${encodeURIComponent(goalId)}/instructions`,
      query,
    );
  }

  submitInstruction(
    goalId: string,
    input: InstructionSubmitRequest,
  ): Promise<{ readonly goalId: string; readonly instruction: StoredGoalInstruction }> {
    return this.post<{ readonly goalId: string; readonly instruction: StoredGoalInstruction }>(
      `api/goals/${encodeURIComponent(goalId)}/instructions`,
      input,
    );
  }

  continueGoal(goalId: string, input: GoalContinueRequest = {}): Promise<unknown> {
    return this.post<unknown>(`api/goals/${encodeURIComponent(goalId)}/continue`, input);
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

  private async post<T>(pathname: string, body: unknown): Promise<T> {
    const url = new URL(pathname, this.baseUrl);
    let response: Response;
    try {
      response = await this.request(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new CliServerError('AgentScope server is unavailable.', 0, error);
    }
    const responseBody = (await response.json()) as unknown;
    if (!response.ok) {
      throw new CliServerError(
        `AgentScope server returned HTTP ${response.status}.`,
        response.status,
        responseBody,
      );
    }
    return responseBody as T;
  }
}

export function formatServerJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
