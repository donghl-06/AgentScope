import type Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';

import {
  assertAgentEvent,
  assertSessionState,
  createInitialSessionState,
  type AgentEvent,
  type EtaResult,
  type Milestone,
  type SessionState,
  assertTurnState,
  type TurnState,
} from '@agentscope/protocol';

export interface SessionCapabilities {
  readonly [key: string]: boolean;
}

export interface CreateSessionInput {
  readonly id: string;
  readonly projectId?: string;
  readonly provider: string;
  readonly adapter: string;
  readonly startedAt: number;
  readonly capabilities: SessionCapabilities;
  readonly state: SessionState;
  readonly workspace?: Record<string, unknown>;
  readonly now?: number;
}

export interface StoredSession {
  readonly id: string;
  readonly projectId?: string;
  readonly provider: string;
  readonly adapter: string;
  readonly status: SessionState['status'];
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly state: SessionState;
  readonly capabilities: SessionCapabilities;
  readonly workspace?: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateTurnInput {
  readonly state: TurnState;
  readonly now?: number;
}

export interface StoredTurn {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly status: TurnState['status'];
  readonly submittedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly title?: string;
  readonly prompt?: string;
  readonly providerTurnId?: string;
  readonly state: TurnState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TurnListFilter {
  readonly status?: TurnState['status'];
  readonly limit?: number;
}

export interface SessionListFilter {
  readonly projectId?: string;
  readonly status?: SessionState['status'];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface StoredEvent {
  readonly seq: number;
  readonly event: AgentEvent;
}

export interface ObserverEvidenceInput {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly key: string;
  readonly timestamp: number;
  readonly source: string;
  readonly kind: string;
  readonly confidence: number;
  readonly reason: string;
  readonly payload: unknown;
}

export type StoredObserverEvidence = ObserverEvidenceInput;

export interface EventPage {
  readonly items: readonly StoredEvent[];
  readonly nextCursor?: string;
}

export interface ProjectOverview {
  readonly projectId: string;
  readonly active: number;
  readonly blocked: number;
  readonly completed: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly total: number;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StorageError';
  }
}

export class StorageConflictError extends StorageError {
  constructor(message: string) {
    super(message, 'conflict');
    this.name = 'StorageConflictError';
  }
}

export class StorageBusyError extends StorageError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'busy', options);
    this.name = 'StorageBusyError';
  }
}

export class StorageCorruptPayloadError extends StorageError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'corrupt_payload', options);
    this.name = 'StorageCorruptPayloadError';
  }
}

export class StorageNotFoundError extends StorageError {
  constructor(message: string) {
    super(message, 'not_found');
    this.name = 'StorageNotFoundError';
  }
}

export interface AppendEventResult {
  readonly event: StoredEvent;
  readonly session: StoredSession;
}

export interface StorageDiagnostics {
  readonly eventAppendAttempts: number;
  readonly eventAppendSuccesses: number;
  readonly duplicateEventErrors: number;
  readonly busyErrors: number;
  readonly eventWriteLatencyMs: {
    readonly count: number;
    readonly total: number;
    readonly max: number;
  };
}

export type SessionProjectionReducer = (state: SessionState, event: AgentEvent) => SessionState;

export interface ProjectionVerification {
  readonly sessionId: string;
  readonly matches: boolean;
  readonly replayed: SessionState;
  readonly persisted: SessionState;
  readonly differences: readonly string[];
}

export type RepositoryNotification =
  | { readonly type: 'session.created'; readonly session: StoredSession }
  | { readonly type: 'session.updated'; readonly session: StoredSession }
  | { readonly type: 'turn.created'; readonly turn: StoredTurn }
  | { readonly type: 'turn.updated'; readonly turn: StoredTurn }
  | { readonly type: 'turn.finished'; readonly turn: StoredTurn }
  | {
      readonly type: 'event.appended';
      readonly event: StoredEvent;
      readonly session: StoredSession;
    };

export class StorageRepository {
  private readonly listeners = new Set<(notification: RepositoryNotification) => void>();
  private eventAppendAttempts = 0;
  private eventAppendSuccesses = 0;
  private duplicateEventErrors = 0;
  private busyErrors = 0;
  private eventWriteLatencyCount = 0;
  private eventWriteLatencyTotal = 0;
  private eventWriteLatencyMax = 0;

  constructor(private readonly client: Database.Database) {}

  subscribe(listener: (notification: RepositoryNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  diagnostics(): StorageDiagnostics {
    return {
      eventAppendAttempts: this.eventAppendAttempts,
      eventAppendSuccesses: this.eventAppendSuccesses,
      duplicateEventErrors: this.duplicateEventErrors,
      busyErrors: this.busyErrors,
      eventWriteLatencyMs: {
        count: this.eventWriteLatencyCount,
        total: Math.round(this.eventWriteLatencyTotal * 100) / 100,
        max: Math.round(this.eventWriteLatencyMax * 100) / 100,
      },
    };
  }

  createSession(input: CreateSessionInput): StoredSession {
    assertSessionState(input.state);
    if (input.state.sessionId !== input.id) {
      throw new StorageError('Session state id does not match session id.', 'invalid_session');
    }
    const now = input.now ?? Date.now();
    const workspaceJson = input.workspace === undefined ? null : stringifyJson(input.workspace);
    const stateJson = stringifyJson(input.state);
    const capabilitiesJson = stringifyJson(input.capabilities);
    try {
      this.client
        .prepare(
          `INSERT INTO sessions
            (id, project_id, provider, adapter, status, started_at, ended_at, state_json,
             capabilities_json, workspace_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId ?? null,
          input.provider,
          input.adapter,
          input.state.status,
          input.startedAt,
          input.state.endedAt ?? null,
          stateJson,
          capabilitiesJson,
          workspaceJson,
          now,
          now,
        );
    } catch (error) {
      throw mapSqliteError(error, `Session already exists: ${input.id}`);
    }
    const session = this.getSession(input.id);
    this.notify({ type: 'session.created', session });
    return session;
  }

  getSession(id: string): StoredSession {
    const row = this.client.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      SessionRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Session not found: ${id}`);
    return decodeSession(row);
  }

  createTurn(input: CreateTurnInput): StoredTurn {
    assertTurnState(input.state);
    this.ensureSession(input.state.sessionId);
    const now = input.now ?? Date.now();
    try {
      this.client
        .prepare(
          `INSERT INTO turns
            (id, session_id, sequence, status, submitted_at, started_at, ended_at, title, prompt,
             provider_turn_id, state_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.state.turnId,
          input.state.sessionId,
          input.state.sequence,
          input.state.status,
          input.state.submittedAt,
          input.state.startedAt ?? null,
          input.state.endedAt ?? null,
          input.state.title ?? null,
          input.state.prompt ?? null,
          input.state.providerTurnId ?? null,
          stringifyJson(input.state),
          now,
          now,
        );
    } catch (error) {
      throw mapSqliteError(error, `Turn already exists: ${input.state.turnId}`);
    }
    const turn = this.getTurn(input.state.turnId);
    this.notify({ type: 'turn.created', turn });
    return turn;
  }

  getTurn(id: string): StoredTurn {
    const row = this.client.prepare('SELECT * FROM turns WHERE id = ?').get(id) as
      TurnRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Turn not found: ${id}`);
    return decodeTurn(row);
  }

  listTurns(sessionId: string, filter: TurnListFilter = {}): readonly StoredTurn[] {
    this.ensureSession(sessionId);
    const clauses = ['session_id = ?'];
    const parameters: Array<string | number> = [sessionId];
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      parameters.push(filter.status);
    }
    const limit = clampLimit(filter.limit);
    const rows = this.client
      .prepare(
        `SELECT * FROM turns WHERE ${clauses.join(' AND ')}
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(...parameters, limit) as TurnRow[];
    return rows.map(decodeTurn);
  }

  updateTurnState(id: string, state: TurnState, now = Date.now()): StoredTurn {
    assertTurnState(state);
    if (state.turnId !== id) {
      throw new StorageError('Turn state id does not match turn id.', 'invalid_turn');
    }
    const existing = this.getTurn(id);
    if (state.sessionId !== existing.sessionId) {
      throw new StorageError('Turn session id cannot change.', 'invalid_turn');
    }
    const result = this.client
      .prepare(
        `UPDATE turns SET sequence = ?, status = ?, submitted_at = ?, started_at = ?, ended_at = ?,
         title = ?, prompt = ?, provider_turn_id = ?, state_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        state.sequence,
        state.status,
        state.submittedAt,
        state.startedAt ?? null,
        state.endedAt ?? null,
        state.title ?? null,
        state.prompt ?? null,
        state.providerTurnId ?? null,
        stringifyJson(state),
        now,
        id,
      );
    if (result.changes !== 1) throw new StorageNotFoundError(`Turn not found: ${id}`);
    const turn = this.getTurn(id);
    this.notify({ type: 'turn.updated', turn });
    if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') {
      this.notify({ type: 'turn.finished', turn });
    }
    return turn;
  }

  verifySessionProjection(id: string, reduce: SessionProjectionReducer): ProjectionVerification {
    const session = this.getSession(id);
    const replayed = this.listEvents(id).items.reduce(
      (current, stored) => reduce(current, stored.event),
      createInitialSessionState(id, session.startedAt),
    );
    const fields: readonly (keyof SessionState)[] = [
      'status',
      'endedAt',
      'currentActivity',
      'milestones',
      'verification',
    ];
    const differences = fields.filter(
      (field) => JSON.stringify(replayed[field]) !== JSON.stringify(session.state[field]),
    );
    return {
      sessionId: id,
      matches: differences.length === 0,
      replayed,
      persisted: session.state,
      differences,
    };
  }

  verifyNonTerminalProjections(
    reduce: SessionProjectionReducer,
  ): readonly ProjectionVerification[] {
    const rows = this.client
      .prepare(
        "SELECT id FROM sessions WHERE status NOT IN ('completed', 'failed', 'interrupted') ORDER BY started_at, id",
      )
      .all() as Array<{ id: string }>;
    return rows.map((row) => this.verifySessionProjection(row.id, reduce));
  }

  listSessions(filter: SessionListFilter = {}): Page<StoredSession> {
    const limit = clampLimit(filter.limit);
    const cursor = filter.cursor === undefined ? undefined : decodeSessionCursor(filter.cursor);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (filter.projectId !== undefined) {
      clauses.push('project_id = ?');
      parameters.push(filter.projectId);
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      parameters.push(filter.status);
    }
    if (cursor !== undefined) {
      clauses.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const rows = this.client
      .prepare(
        `SELECT * FROM sessions ${where}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters, limit + 1) as SessionRow[];
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(decodeSession),
      ...(rows.length > limit && pageRows.length > 0
        ? { nextCursor: encodeSessionCursor(pageRows.at(-1)!) }
        : {}),
    };
  }

  getProjectOverview(projectId: string): ProjectOverview {
    const rows = this.client
      .prepare(
        'SELECT status, count(*) AS count FROM sessions WHERE project_id = ? GROUP BY status',
      )
      .all(projectId) as Array<{ status: string; count: number }>;
    const counts = new Map(rows.map((row) => [row.status, row.count]));
    const active = (counts.get('starting') ?? 0) + (counts.get('running') ?? 0);
    return {
      projectId,
      active,
      blocked: counts.get('blocked') ?? 0,
      completed: counts.get('completed') ?? 0,
      failed: counts.get('failed') ?? 0,
      interrupted: counts.get('interrupted') ?? 0,
      total: rows.reduce((sum, row) => sum + row.count, 0),
    };
  }

  updateSessionState(
    id: string,
    state: SessionState,
    options: { readonly now?: number; readonly workspace?: Record<string, unknown> } = {},
  ): StoredSession {
    assertSessionState(state);
    if (state.sessionId !== id) {
      throw new StorageError('Session state id does not match session id.', 'invalid_session');
    }
    const existing = this.getSession(id);
    const workspace = options.workspace === undefined ? existing.workspace : options.workspace;
    const result = this.client
      .prepare(
        `UPDATE sessions SET status = ?, ended_at = ?, state_json = ?, workspace_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state.status,
        state.endedAt ?? null,
        stringifyJson(state),
        workspace === undefined ? null : stringifyJson(workspace),
        options.now ?? Date.now(),
        id,
      );
    if (result.changes !== 1) throw new StorageNotFoundError(`Session not found: ${id}`);
    const session = this.getSession(id);
    this.notify({ type: 'session.updated', session });
    return session;
  }

  recoverInFlightSessions(now = Date.now()): readonly StoredSession[] {
    const rows = this.client
      .prepare(
        "SELECT * FROM sessions WHERE status IN ('starting', 'running') ORDER BY started_at, id",
      )
      .all() as SessionRow[];
    return rows.map((row) => {
      const session = decodeSession(row);
      return this.updateSessionState(
        session.id,
        { ...session.state, status: 'interrupted', endedAt: now },
        { now, ...(session.workspace === undefined ? {} : { workspace: session.workspace }) },
      );
    });
  }

  appendEvent(event: AgentEvent, projection: SessionState, now = Date.now()): AppendEventResult {
    this.eventAppendAttempts += 1;
    const writeStartedAt = performance.now();
    assertAgentEvent(event);
    assertSessionState(projection);
    if (event.sessionId !== projection.sessionId) {
      throw new StorageError('Event and projection session ids do not match.', 'invalid_session');
    }
    // Acquire the write lock before reading the projection. A deferred transaction
    // lets concurrent writers both read and then fail while upgrading to a write
    // lock (SQLITE_BUSY); IMMEDIATE makes busy_timeout able to serialize them.
    const transaction = this.client.transaction(() => {
      const session = this.getSession(event.sessionId);
      const duplicate = this.client.prepare('SELECT seq FROM events WHERE id = ?').get(event.id) as
        { seq: number } | undefined;
      if (duplicate !== undefined) {
        throw new StorageConflictError(`Event already exists: ${event.id}`);
      }
      const nextSeq =
        (
          this.client
            .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?')
            .get(event.sessionId) as { seq: number }
        ).seq + 1;
      try {
        this.client
          .prepare(
            `INSERT INTO events
              (id, session_id, seq, timestamp, type, source_json, payload_json, confidence, raw_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.id,
            event.sessionId,
            nextSeq,
            event.timestamp,
            event.type,
            stringifyJson(event.source),
            stringifyJson(event.payload),
            event.confidence,
            event.rawRef ?? null,
          );
      } catch (error) {
        throw mapSqliteError(error, `Event already exists: ${event.id}`);
      }
      this.updateSessionProjection(session, projection, now);
      return { event: { seq: nextSeq, event }, session: this.getSession(event.sessionId) };
    }).immediate;
    let result: AppendEventResult;
    try {
      result = transaction();
    } catch (error) {
      // SQLite can acquire the write lock before the transaction callback runs;
      // normalize that boundary error just like INSERT/UPDATE failures.
      const mapped = mapSqliteError(error, `Event already exists: ${event.id}`);
      if (mapped.code === 'conflict') this.duplicateEventErrors += 1;
      if (mapped.code === 'busy') this.busyErrors += 1;
      this.recordEventWriteLatency(writeStartedAt);
      throw mapped;
    }
    this.eventAppendSuccesses += 1;
    this.recordEventWriteLatency(writeStartedAt);
    this.notify({ type: 'event.appended', ...result });
    return result;
  }

  private recordEventWriteLatency(startedAt: number): void {
    const elapsed = Math.max(0, performance.now() - startedAt);
    this.eventWriteLatencyCount += 1;
    this.eventWriteLatencyTotal += elapsed;
    this.eventWriteLatencyMax = Math.max(this.eventWriteLatencyMax, elapsed);
  }

  listEvents(sessionId: string, afterSeq = 0, limit = 100): EventPage {
    this.ensureSession(sessionId);
    const pageLimit = clampLimit(limit);
    const rows = this.client
      .prepare(
        `SELECT seq, id, session_id, timestamp, type, source_json, payload_json, confidence, raw_ref
         FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, afterSeq, pageLimit + 1) as EventRow[];
    const pageRows = rows.slice(0, pageLimit);
    return {
      items: pageRows.map(decodeEvent),
      ...(rows.length > pageLimit && pageRows.length > 0
        ? { nextCursor: String(pageRows.at(-1)!.seq) }
        : {}),
    };
  }

  saveObserverEvidence(input: ObserverEvidenceInput): StoredObserverEvidence {
    this.ensureSession(input.sessionId);
    if (input.id.length === 0 || input.key.length === 0) {
      throw new StorageError('Observer evidence identifiers must not be empty.', 'invalid_input');
    }
    if (!Number.isFinite(input.timestamp) || input.timestamp < 0) {
      throw new StorageError('Observer evidence timestamp must be non-negative.', 'invalid_input');
    }
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new StorageError(
        'Observer evidence confidence must be between 0 and 1.',
        'invalid_input',
      );
    }
    const payloadJson = stringifyJson(input.payload);
    try {
      this.client
        .prepare(
          `INSERT INTO observer_evidence
            (id, session_id, turn_id, evidence_key, timestamp, source, kind, confidence, reason, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, evidence_key) DO UPDATE SET
             id = excluded.id,
             turn_id = excluded.turn_id,
             timestamp = excluded.timestamp,
             source = excluded.source,
             kind = excluded.kind,
             confidence = excluded.confidence,
             reason = excluded.reason,
             payload_json = excluded.payload_json
           WHERE excluded.timestamp >= observer_evidence.timestamp`,
        )
        .run(
          input.id,
          input.sessionId,
          input.turnId ?? null,
          input.key,
          input.timestamp,
          input.source,
          input.kind,
          input.confidence,
          input.reason,
          payloadJson,
        );
    } catch (error) {
      throw mapSqliteError(error, `Could not save observer evidence: ${input.key}`);
    }
    return this.getObserverEvidence(input.sessionId, input.key);
  }

  listObserverEvidence(sessionId: string, limit = 100): readonly StoredObserverEvidence[] {
    this.ensureSession(sessionId);
    const rows = this.client
      .prepare(
        `SELECT id, session_id, turn_id, evidence_key, timestamp, source, kind, confidence, reason, payload_json
         FROM observer_evidence
         WHERE session_id = ?
         ORDER BY timestamp, evidence_key
         LIMIT ?`,
      )
      .all(sessionId, clampObserverEvidenceLimit(limit)) as ObserverEvidenceRow[];
    return rows.map(decodeObserverEvidence);
  }

  listObserverEvidenceForTurn(turnId: string, limit = 100): readonly StoredObserverEvidence[] {
    const turn = this.getTurn(turnId);
    const rows = this.client
      .prepare(
        `SELECT id, session_id, turn_id, evidence_key, timestamp, source, kind, confidence, reason, payload_json
         FROM observer_evidence
         WHERE turn_id = ?
         ORDER BY timestamp, evidence_key
         LIMIT ?`,
      )
      .all(turn.id, clampObserverEvidenceLimit(limit)) as ObserverEvidenceRow[];
    return rows.map(decodeObserverEvidence);
  }

  private getObserverEvidence(sessionId: string, key: string): StoredObserverEvidence {
    const row = this.client
      .prepare(
        `SELECT id, session_id, turn_id, evidence_key, timestamp, source, kind, confidence, reason, payload_json
         FROM observer_evidence
         WHERE session_id = ? AND evidence_key = ?`,
      )
      .get(sessionId, key) as ObserverEvidenceRow | undefined;
    if (row === undefined) throw new StorageNotFoundError(`Observer evidence not found: ${key}`);
    return decodeObserverEvidence(row);
  }

  upsertMilestone(sessionId: string, milestone: Milestone, now = Date.now()): void {
    this.ensureSession(sessionId);
    this.client
      .prepare(
        `INSERT INTO milestones
          (session_id, milestone_id, title, status, started_at, completed_at, metadata_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, milestone_id) DO UPDATE SET
           title = excluded.title, status = excluded.status, started_at = excluded.started_at,
           completed_at = excluded.completed_at, metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        sessionId,
        milestone.id,
        milestone.title,
        milestone.status,
        milestone.startedAt ?? null,
        milestone.completedAt ?? null,
        null,
        now,
      );
  }

  listMilestones(sessionId: string): readonly Milestone[] {
    this.ensureSession(sessionId);
    const rows = this.client
      .prepare(
        `SELECT milestone_id, title, status, started_at, completed_at
         FROM milestones WHERE session_id = ? ORDER BY COALESCE(started_at, updated_at), milestone_id`,
      )
      .all(sessionId) as MilestoneRow[];
    return rows.map((row) => ({
      id: row.milestone_id,
      title: row.title,
      status: row.status as Milestone['status'],
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    }));
  }

  saveEtaSnapshot(sessionId: string, eta: EtaResult, capturedAt = Date.now()): void {
    this.ensureSession(sessionId);
    this.client
      .prepare(
        `INSERT INTO eta_snapshots
          (session_id, captured_at, min_seconds, max_seconds, confidence, reasons_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        capturedAt,
        eta.minSeconds,
        eta.maxSeconds,
        eta.confidence,
        stringifyJson(eta.reasons),
      );
  }

  listEtaSnapshots(sessionId: string): readonly EtaResult[] {
    this.ensureSession(sessionId);
    const rows = this.client
      .prepare(
        `SELECT min_seconds, max_seconds, confidence, reasons_json
         FROM eta_snapshots WHERE session_id = ? ORDER BY captured_at ASC, id ASC`,
      )
      .all(sessionId) as EtaRow[];
    return rows.map((row) => ({
      minSeconds: row.min_seconds,
      maxSeconds: row.max_seconds,
      confidence: row.confidence,
      reasons: parseJson(row.reasons_json, 'ETA reasons'),
    }));
  }

  private updateSessionProjection(session: StoredSession, state: SessionState, now: number): void {
    this.client
      .prepare(
        `UPDATE sessions SET status = ?, ended_at = ?, state_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(state.status, state.endedAt ?? null, stringifyJson(state), now, session.id);
  }

  private notify(notification: RepositoryNotification): void {
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch {
        // Observability listeners must not change durable write semantics.
      }
    }
  }

  private ensureSession(id: string): void {
    const row = this.client.prepare('SELECT 1 AS present FROM sessions WHERE id = ?').get(id);
    if (row === undefined) throw new StorageNotFoundError(`Session not found: ${id}`);
  }
}

interface SessionRow {
  id: string;
  project_id: string | null;
  provider: string;
  adapter: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  state_json: string;
  capabilities_json: string;
  workspace_json: string | null;
  created_at: number;
  updated_at: number;
}

interface TurnRow {
  id: string;
  session_id: string;
  sequence: number;
  status: string;
  submitted_at: number;
  started_at: number | null;
  ended_at: number | null;
  title: string | null;
  prompt: string | null;
  provider_turn_id: string | null;
  state_json: string;
  created_at: number;
  updated_at: number;
}

interface EventRow {
  seq: number;
  id: string;
  session_id: string;
  timestamp: number;
  type: string;
  source_json: string;
  payload_json: string;
  confidence: number;
  raw_ref: string | null;
}

interface MilestoneRow {
  milestone_id: string;
  title: string;
  status: string;
  started_at: number | null;
  completed_at: number | null;
}

interface EtaRow {
  min_seconds: number;
  max_seconds: number;
  confidence: number;
  reasons_json: string;
}

interface ObserverEvidenceRow {
  id: string;
  session_id: string;
  turn_id: string | null;
  evidence_key: string;
  timestamp: number;
  source: string;
  kind: string;
  confidence: number;
  reason: string;
  payload_json: string;
}

function decodeSession(row: SessionRow): StoredSession {
  const state = parseJson<SessionState>(row.state_json, 'session state');
  assertSessionState(state);
  const capabilities = parseJson<SessionCapabilities>(row.capabilities_json, 'capabilities');
  const workspace =
    row.workspace_json === null
      ? undefined
      : parseJson<Record<string, unknown>>(row.workspace_json, 'workspace');
  return {
    id: row.id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    provider: row.provider,
    adapter: row.adapter,
    status: row.status as SessionState['status'],
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    state,
    capabilities,
    ...(workspace === undefined ? {} : { workspace }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeTurn(row: TurnRow): StoredTurn {
  const state = parseJson<TurnState>(row.state_json, 'turn state');
  assertTurnState(state);
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    status: row.status as TurnState['status'],
    submittedAt: row.submitted_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.prompt === null ? {} : { prompt: row.prompt }),
    ...(row.provider_turn_id === null ? {} : { providerTurnId: row.provider_turn_id }),
    state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeEvent(row: EventRow): StoredEvent {
  const event = {
    id: row.id,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    source: parseJson(row.source_json, 'event source'),
    type: row.type,
    payload: parseJson(row.payload_json, 'event payload'),
    confidence: row.confidence,
    ...(row.raw_ref === null ? {} : { rawRef: row.raw_ref }),
  };
  assertAgentEvent(event);
  return { seq: row.seq, event };
}

function decodeObserverEvidence(row: ObserverEvidenceRow): StoredObserverEvidence {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    key: row.evidence_key,
    timestamp: row.timestamp,
    source: row.source,
    kind: row.kind,
    confidence: row.confidence,
    reason: row.reason,
    payload: parseJson(row.payload_json, 'observer evidence payload'),
  };
}

function stringifyJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Value is not JSON serializable.');
    return serialized;
  } catch (error) {
    throw new StorageCorruptPayloadError('Value cannot be serialized as JSON.', { cause: error });
  }
}

function parseJson<T = unknown>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new StorageCorruptPayloadError(`Stored ${label} is not valid JSON.`, { cause: error });
  }
}

function clampObserverEvidenceLimit(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(500, Math.trunc(value)));
}

function mapSqliteError(error: unknown, duplicateMessage: string): StorageError {
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (code.includes('BUSY') || code.includes('LOCKED')) {
    return new StorageBusyError('SQLite database is busy.', { cause: error });
  }
  if (code.includes('CONSTRAINT') || code.includes('DUPLICATE')) {
    return new StorageConflictError(duplicateMessage);
  }
  if (error instanceof StorageError) return error;
  return new StorageError('SQLite operation failed.', 'sqlite_error', { cause: error });
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isInteger(limit) || limit < 1)
    throw new StorageError('Limit must be a positive integer.', 'invalid_query');
  return Math.min(limit, 100);
}

function encodeSessionCursor(row: SessionRow): string {
  return Buffer.from(JSON.stringify({ updatedAt: row.updated_at, id: row.id })).toString(
    'base64url',
  );
}

function decodeSessionCursor(cursor: string): { updatedAt: number; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      updatedAt?: unknown;
      id?: unknown;
    };
    if (typeof value.updatedAt !== 'number' || typeof value.id !== 'string')
      throw new Error('invalid');
    return { updatedAt: value.updatedAt, id: value.id };
  } catch (error) {
    throw new StorageError('Invalid session cursor.', 'invalid_query', { cause: error });
  }
}
