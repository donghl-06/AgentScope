import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createInitialSessionState,
  createInitialTurnState,
  ProtocolValidationError,
  type AgentEvent,
  type SessionState,
} from '@agentscope/protocol';

import { openStorage } from './database.js';
import {
  StorageConflictError,
  StorageCorruptPayloadError,
  StorageBusyError,
  StorageRepository,
} from './repository.js';

const source = { provider: 'mock', client: 'agentscope', environment: 'test', adapter: 'mock' };

function event(
  id: string,
  sessionId = 'session-1',
  type: AgentEvent['type'] = 'planning',
): AgentEvent {
  return {
    id,
    sessionId,
    timestamp: 1_700_000_000_100,
    source,
    type,
    payload: type === 'planning' ? { summary: id } : {},
    confidence: 1,
  };
}

function state(sessionId: string, status: SessionState['status'] = 'starting'): SessionState {
  return { ...createInitialSessionState(sessionId, 1_700_000_000_000), status };
}

function withRepository(
  test: (repository: StorageRepository, client: ReturnType<typeof openStorage>['client']) => void,
): void {
  const filename = path.join(
    os.tmpdir(),
    `agentscope-repository-${Date.now()}-${Math.random()}.db`,
  );
  const { client } = openStorage({ filename, migrate: true });
  try {
    test(new StorageRepository(client), client);
  } finally {
    client.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(filename + suffix);
      } catch {
        // Best-effort cleanup for SQLite sidecar files.
      }
    }
  }
}

describe('StorageRepository', () => {
  it('redacts secrets from turn projections, events, and observer evidence at persistence boundaries', () => {
    withRepository((repository, client) => {
      repository.createSession({
        id: 'session-redaction',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 1_700_000_000_000,
        capabilities: {},
        state: state('session-redaction'),
      });

      const turnState = createInitialTurnState(
        'turn-redaction',
        'session-redaction',
        1,
        1_700_000_000_010,
        {
          title: 'apiKey=turn-secret',
          prompt: 'Authorization: Bearer turn-token',
        },
      );
      repository.createTurn({ state: turnState });
      repository.appendEvent(
        {
          id: 'event-redaction',
          sessionId: 'session-redaction',
          timestamp: 1_700_000_000_020,
          source: {
            provider: 'mock',
            client: 'apiKey=source-secret',
            environment: 'test',
            adapter: 'mock',
          },
          type: 'planning',
          payload: { summary: 'Bearer event-token; sk-test-1234567890123456' },
          confidence: 1,
        },
        state('session-redaction', 'running'),
      );
      repository.saveObserverEvidence({
        id: 'evidence-redaction',
        sessionId: 'session-redaction',
        turnId: 'turn-redaction',
        key: 'redaction',
        timestamp: 1_700_000_000_030,
        source: 'test',
        kind: 'command',
        confidence: 1,
        reason: 'token=evidence-secret',
        payload: { authorization: 'Bearer evidence-token', safe: 'ok' },
      });

      const turn = repository.getTurn('turn-redaction');
      expect(turn.title).toBe('apiKey=[REDACTED]');
      expect(turn.prompt).toBe('Authorization: Bearer [REDACTED]');
      const event = repository.listEvents('session-redaction').items[0]!.event;
      expect(JSON.stringify(event)).not.toContain('source-secret');
      expect(JSON.stringify(event)).not.toContain('event-token');
      expect(JSON.stringify(event)).not.toContain('sk-test-1234567890123456');
      const evidence = repository.listObserverEvidence('session-redaction')[0]!;
      expect(evidence.reason).toBe('token=[REDACTED]');
      expect(evidence.payload).toEqual({
        authorization: '[REDACTED]',
        safe: 'ok',
      });

      const raw = client
        .prepare(
          `SELECT title, prompt, source_json, payload_json FROM turns
           LEFT JOIN events ON events.session_id = turns.session_id
           WHERE turns.id = ?`,
        )
        .get('turn-redaction') as Record<string, string | null>;
      expect(JSON.stringify(raw)).not.toContain('turn-secret');
      expect(JSON.stringify(raw)).not.toContain('source-secret');
    });
  });

  it('creates, updates, lists, and preserves turn projections', () => {
    withRepository((repository) => {
      repository.createSession({
        id: 'session-turns',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 1_700_000_000_000,
        capabilities: {},
        state: state('session-turns'),
      });

      const queued = createInitialTurnState('turn-1', 'session-turns', 1, 1_700_000_000_010, {
        title: 'First task',
        prompt: 'Inspect the project',
      });
      repository.createTurn({ state: queued, now: 1_700_000_000_011 });
      const running = { ...queued, status: 'running' as const, startedAt: 1_700_000_000_020 };
      repository.updateTurnState('turn-1', running, 1_700_000_000_021);

      const second = createInitialTurnState('turn-2', 'session-turns', 2, 1_700_000_000_030);
      repository.createTurn({ state: second, now: 1_700_000_000_031 });

      expect(repository.getTurn('turn-1')).toMatchObject({
        sessionId: 'session-turns',
        sequence: 1,
        status: 'running',
        title: 'First task',
      });
      expect(repository.listTurns('session-turns')).toHaveLength(2);
      expect(repository.listTurns('session-turns', { status: 'running' })).toHaveLength(1);
      expect(() => repository.updateTurnState('turn-1', { ...running, turnId: 'wrong' })).toThrow(
        'Turn state id does not match turn id.',
      );
    });
  });

  it('persists sessions, events, milestones, ETA snapshots, and cursor pages', () => {
    withRepository((repository) => {
      repository.createSession({
        id: 'session-1',
        projectId: 'project-1',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 1_700_000_000_000,
        capabilities: { structuredEvents: true },
        state: state('session-1'),
        now: 1_700_000_000_001,
      });
      repository.createSession({
        id: 'session-2',
        projectId: 'project-1',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 1_700_000_000_010,
        capabilities: { structuredEvents: false },
        state: state('session-2'),
        now: 1_700_000_000_010,
      });

      const running = state('session-1', 'running');
      repository.appendEvent(event('event-1'), running, 1_700_000_000_100);
      repository.appendEvent(event('event-2'), running, 1_700_000_000_200);
      repository.upsertMilestone('session-1', {
        id: 'm1',
        title: 'Implementation',
        status: 'active',
        startedAt: 1_700_000_000_150,
      });
      repository.saveEtaSnapshot('session-1', {
        minSeconds: 5,
        maxSeconds: 10,
        confidence: 0.7,
        reasons: [{ code: 'signal', message: 'Observed work' }],
      });

      const events = repository.listEvents('session-1', 0, 1);
      expect(events.items).toHaveLength(1);
      expect(events.items[0]).toMatchObject({ seq: 1, event: { id: 'event-1' } });
      expect(events.nextCursor).toBe('1');
      expect(repository.listEvents('session-1', Number(events.nextCursor), 10).items).toHaveLength(
        1,
      );
      expect(repository.listMilestones('session-1')).toMatchObject([
        { id: 'm1', status: 'active' },
      ]);
      expect(repository.listEtaSnapshots('session-1')[0]).toMatchObject({
        minSeconds: 5,
        maxSeconds: 10,
      });

      const sessions = repository.listSessions({ projectId: 'project-1', limit: 1 });
      expect(sessions.items).toHaveLength(1);
      expect(sessions.nextCursor).toBeDefined();
      expect(
        repository.listSessions({ projectId: 'project-1', cursor: sessions.nextCursor! }).items,
      ).toHaveLength(1);
      expect(repository.getSession('session-1').status).toBe('running');
    });
  });

  it('hides terminal sessions, protects active sessions, and cascades permanent deletion', () => {
    withRepository((repository, client) => {
      const startedAt = 1_700_000_000_000;
      const completedState = {
        ...state('session-cleanup', 'completed'),
        endedAt: startedAt + 10_000,
      };
      repository.createSession({
        id: 'session-cleanup',
        provider: 'mock',
        adapter: 'mock',
        startedAt,
        capabilities: {},
        state: completedState,
      });
      repository.createTurn({
        state: {
          ...createInitialTurnState('cleanup-turn', 'session-cleanup', 1, startedAt),
          status: 'completed',
          startedAt: startedAt + 1,
          endedAt: startedAt + 9_000,
        },
      });
      const { endedAt, ...runningProjectionBase } = completedState;
      void endedAt;
      repository.appendEvent(event('cleanup-event', 'session-cleanup'), {
        ...runningProjectionBase,
        status: 'running',
      });
      repository.updateSessionState('session-cleanup', completedState);
      repository.saveObserverEvidence({
        id: 'cleanup-evidence',
        sessionId: 'session-cleanup',
        turnId: 'cleanup-turn',
        key: 'cleanup:evidence',
        timestamp: startedAt + 2,
        source: 'process',
        kind: 'lifecycle',
        confidence: 1,
        reason: 'cleanup evidence',
        payload: {},
      });
      repository.upsertMilestone('session-cleanup', {
        id: 'cleanup-milestone',
        title: 'Cleanup',
        status: 'completed',
      });
      repository.saveEtaSnapshot('session-cleanup', {
        minSeconds: 1,
        maxSeconds: 2,
        confidence: 0.5,
        reasons: [],
      });

      repository.createSession({
        id: 'session-active',
        provider: 'mock',
        adapter: 'mock',
        startedAt,
        capabilities: {},
        state: state('session-active', 'running'),
      });

      const hidden = repository.setSessionHidden('session-cleanup', true, startedAt + 20_000);
      expect(hidden.hiddenAt).toBe(startedAt + 20_000);
      expect(repository.listSessions().items.map((session) => session.id)).toEqual([
        'session-active',
      ]);
      expect(
        repository.listSessions({ includeHidden: true }).items.map((session) => session.id),
      ).toEqual(expect.arrayContaining(['session-cleanup', 'session-active']));
      expect(repository.listEtaHistory({ provider: 'mock', adapter: 'mock' })).toEqual([
        expect.objectContaining({ durationSeconds: 10 }),
      ]);

      expect(() => repository.setSessionHidden('session-active', true)).toThrow(
        'Running sessions cannot be hidden or deleted.',
      );
      expect(() => repository.deleteSession('session-active')).toThrow(
        'Running sessions cannot be hidden or deleted.',
      );

      const deletedNotifications: string[] = [];
      repository.subscribe((notification) => {
        if (notification.type === 'session.deleted')
          deletedNotifications.push(notification.session.id);
      });
      repository.deleteSession('session-cleanup');
      expect(deletedNotifications).toEqual(['session-cleanup']);
      expect(() => repository.getSession('session-cleanup')).toThrow('Session not found');
      expect(
        client
          .prepare('SELECT count(*) AS count FROM turns WHERE session_id = ?')
          .get('session-cleanup'),
      ).toMatchObject({ count: 0 });
      expect(
        client
          .prepare('SELECT count(*) AS count FROM events WHERE session_id = ?')
          .get('session-cleanup'),
      ).toMatchObject({ count: 0 });
      expect(
        client
          .prepare('SELECT count(*) AS count FROM observer_evidence WHERE session_id = ?')
          .get('session-cleanup'),
      ).toMatchObject({ count: 0 });
      expect(
        client
          .prepare('SELECT count(*) AS count FROM milestones WHERE session_id = ?')
          .get('session-cleanup'),
      ).toMatchObject({ count: 0 });
      expect(
        client
          .prepare('SELECT count(*) AS count FROM eta_snapshots WHERE session_id = ?')
          .get('session-cleanup'),
      ).toMatchObject({ count: 0 });
    });
  });

  it('paginates a large timeline without gaps or duplicate sequence numbers', () => {
    withRepository((repository) => {
      repository.createSession({
        id: 'session-pagination',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 1_700_000_000_000,
        capabilities: {},
        state: state('session-pagination'),
      });
      for (let index = 1; index <= 250; index += 1) {
        repository.appendEvent(
          event(`pagination-${index}`, 'session-pagination'),
          state('session-pagination', 'running'),
          1_700_000_000_000 + index,
        );
      }

      const sequences: number[] = [];
      let cursor = 0;
      while (sequences.length < 250) {
        const page = repository.listEvents('session-pagination', cursor, 17);
        sequences.push(...page.items.map((item) => item.seq));
        if (page.nextCursor === undefined) break;
        cursor = Number(page.nextCursor);
      }

      expect(sequences).toEqual(Array.from({ length: 250 }, (_, index) => index + 1));
    });
  });

  it('paginates turns and observer evidence without gaps or duplicates', () => {
    withRepository((repository) => {
      repository.createSession({
        id: 'session-page-items',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 1_700_000_000_000,
        capabilities: {},
        state: state('session-page-items'),
      });
      for (let index = 1; index <= 5; index += 1) {
        repository.createTurn({
          state: createInitialTurnState(
            `turn-${index}`,
            'session-page-items',
            index,
            1_700_000_000_000 + index,
            { title: `Task ${index}` },
          ),
        });
        repository.saveObserverEvidence({
          id: `evidence-${index}`,
          sessionId: 'session-page-items',
          turnId: `turn-${index}`,
          key: `process:${index}`,
          timestamp: 1_700_000_000_000 + index,
          source: 'process',
          kind: 'lifecycle',
          confidence: 1,
          reason: `Evidence ${index}`,
          payload: { index },
        });
      }

      const turnIds: string[] = [];
      let turnCursor: string | undefined;
      do {
        const page = repository.listTurnPage('session-page-items', {
          limit: 2,
          ...(turnCursor === undefined ? {} : { cursor: turnCursor }),
        });
        turnIds.push(...page.items.map((turn) => turn.id));
        turnCursor = page.nextCursor;
      } while (turnCursor !== undefined);
      expect(turnIds).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']);

      const evidenceKeys: string[] = [];
      let evidenceCursor: string | undefined;
      do {
        const page = repository.listObserverEvidencePage('session-page-items', {
          limit: 2,
          ...(evidenceCursor === undefined ? {} : { cursor: evidenceCursor }),
        });
        evidenceKeys.push(...page.items.map((item) => item.key));
        evidenceCursor = page.nextCursor;
      } while (evidenceCursor !== undefined);
      expect(evidenceKeys).toEqual([
        'process:1',
        'process:2',
        'process:3',
        'process:4',
        'process:5',
      ]);

      expect(repository.listObserverEvidenceForTurnPage('turn-3', { limit: 1 }).items).toEqual([
        expect.objectContaining({ key: 'process:3', turnId: 'turn-3' }),
      ]);

      repository.appendEvent(
        {
          id: 'turn-event-1',
          sessionId: 'session-page-items',
          timestamp: 1_700_000_000_100,
          source,
          type: 'turn_started',
          payload: { turnId: 'turn-3', sequence: 3 },
          confidence: 1,
        },
        state('session-page-items', 'running'),
      );
      repository.appendEvent(
        {
          id: 'turn-event-unrelated',
          sessionId: 'session-page-items',
          timestamp: 1_700_000_000_101,
          source,
          type: 'planning',
          payload: { summary: 'unrelated event' },
          confidence: 1,
        },
        state('session-page-items', 'running'),
      );
      repository.appendEvent(
        {
          id: 'turn-event-2',
          sessionId: 'session-page-items',
          timestamp: 1_700_000_000_102,
          source,
          type: 'turn_updated',
          payload: { turnId: 'turn-3', status: 'waiting' },
          confidence: 1,
        },
        state('session-page-items', 'running'),
      );
      const firstTurnEvents = repository.listEventsForTurn('turn-3', 0, 1);
      expect(firstTurnEvents.items).toMatchObject([
        { event: { id: 'turn-event-1', type: 'turn_started' } },
      ]);
      expect(firstTurnEvents.nextCursor).toBeDefined();
      expect(
        repository.listEventsForTurn('turn-3', Number(firstTurnEvents.nextCursor), 1).items,
      ).toMatchObject([{ event: { id: 'turn-event-2', type: 'turn_updated' } }]);
    });
  });

  it('rejects duplicate events and detects corrupt persisted JSON', () => {
    withRepository((repository, client) => {
      repository.createSession({
        id: 'session-1',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 1_700_000_000_000,
        capabilities: {},
        state: state('session-1'),
      });
      repository.appendEvent(event('event-1'), state('session-1', 'running'));
      expect(() => repository.appendEvent(event('event-1'), state('session-1', 'running'))).toThrow(
        StorageConflictError,
      );
      expect(repository.diagnostics()).toMatchObject({
        eventAppendAttempts: 2,
        eventAppendSuccesses: 1,
        duplicateEventErrors: 1,
      });

      client.prepare('UPDATE events SET payload_json = ? WHERE id = ?').run('{', 'event-1');
      expect(() => repository.listEvents('session-1')).toThrow(StorageCorruptPayloadError);
    });
  });

  it('persists and deterministically replaces observer evidence by logical key', () => {
    withRepository((repository) => {
      repository.createSession({
        id: 'session-1',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 1_700_000_000_000,
        capabilities: {},
        state: state('session-1'),
      });
      repository.saveObserverEvidence({
        id: 'evidence-1',
        sessionId: 'session-1',
        key: 'file:app.ts',
        timestamp: 100,
        source: 'filesystem',
        kind: 'file',
        confidence: 0.65,
        reason: 'workspace change',
        payload: { path: 'app.ts', kind: 'modify' },
      });
      repository.saveObserverEvidence({
        id: 'evidence-old',
        sessionId: 'session-1',
        key: 'file:app.ts',
        timestamp: 90,
        source: 'filesystem',
        kind: 'file',
        confidence: 0.2,
        reason: 'older observation',
        payload: { path: 'app.ts' },
      });
      repository.saveObserverEvidence({
        id: 'evidence-2',
        sessionId: 'session-1',
        key: 'git:workspace:baseline',
        timestamp: 101,
        source: 'git',
        kind: 'workspace',
        confidence: 0.8,
        reason: 'baseline',
        payload: { isRepository: true },
      });

      expect(repository.listObserverEvidence('session-1')).toEqual([
        expect.objectContaining({ id: 'evidence-1', key: 'file:app.ts', timestamp: 100 }),
        expect.objectContaining({
          id: 'evidence-2',
          key: 'git:workspace:baseline',
          timestamp: 101,
        }),
      ]);
    });
  });

  it('rejects malformed event payloads before writing them', () => {
    withRepository((repository) => {
      repository.createSession({
        id: 'session-1',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 1_700_000_000_000,
        capabilities: {},
        state: state('session-1'),
      });

      expect(() =>
        repository.appendEvent(
          { ...event('event-1', 'session-1', 'file_write'), payload: { path: 123 } } as AgentEvent,
          state('session-1', 'running'),
        ),
      ).toThrow(ProtocolValidationError);
      expect(repository.listEvents('session-1').items).toHaveLength(0);
    });
  });

  it('rolls back the event when the session projection update fails', () => {
    withRepository((repository, client) => {
      repository.createSession({
        id: 'session-1',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 1_700_000_000_000,
        capabilities: {},
        state: state('session-1'),
      });
      client.exec(`
        CREATE TRIGGER fail_projection BEFORE UPDATE ON sessions
        BEGIN SELECT RAISE(ABORT, 'projection failure'); END;
      `);

      expect(() =>
        repository.appendEvent(event('event-1'), state('session-1', 'running')),
      ).toThrow();
      expect(repository.listEvents('session-1').items).toHaveLength(0);
    });
  });

  it('maps a concurrent SQLite write lock to StorageBusyError', () => {
    const filename = path.join(
      os.tmpdir(),
      `agentscope-repository-busy-${Date.now()}-${Math.random()}.db`,
    );
    const first = openStorage({ filename, migrate: true, busyTimeoutMs: 1 });
    const second = openStorage({ filename, migrate: false, busyTimeoutMs: 1 });
    try {
      const firstRepository = new StorageRepository(first.client);
      const secondRepository = new StorageRepository(second.client);
      firstRepository.createSession({
        id: 'session-1',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 1_700_000_000_000,
        capabilities: {},
        state: state('session-1'),
      });

      first.client.exec('BEGIN IMMEDIATE');
      expect(() =>
        secondRepository.appendEvent(event('event-1'), state('session-1', 'running')),
      ).toThrow(StorageBusyError);
      expect(secondRepository.diagnostics()).toMatchObject({ busyErrors: 1 });
      first.client.exec('ROLLBACK');
    } finally {
      first.client.close();
      second.client.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(filename + suffix);
        } catch {
          // Best-effort cleanup for SQLite sidecar files.
        }
      }
    }
  });

  it('marks in-flight sessions interrupted while preserving blocked sessions', () => {
    withRepository((repository) => {
      for (const [id, status] of [
        ['starting-session', 'starting'],
        ['running-session', 'running'],
        ['blocked-session', 'blocked'],
      ] as const) {
        repository.createSession({
          id,
          provider: 'mock',
          adapter: 'mock',
          startedAt: 1_700_000_000_000,
          capabilities: {},
          state: state(id, status),
        });
      }
      repository.createTurn({
        state: {
          ...createInitialTurnState('running-turn', 'running-session', 1, 110),
          status: 'running',
          startedAt: 120,
        },
        now: 120,
      });
      repository.createTurn({
        state: createInitialTurnState('starting-turn', 'starting-session', 1, 115),
        now: 115,
      });
      repository.createTurn({
        state: {
          ...createInitialTurnState('blocked-turn', 'blocked-session', 1, 115),
          status: 'blocked',
        },
        now: 115,
      });

      const recovered = repository.recoverInFlightSessions(1_700_000_010_000);
      expect(recovered.map((session) => session.id)).toEqual([
        'running-session',
        'starting-session',
      ]);
      expect(repository.getSession('running-session')).toMatchObject({
        status: 'interrupted',
        endedAt: 1_700_000_010_000,
      });
      expect(repository.getSession('starting-session')).toMatchObject({ status: 'interrupted' });
      expect(repository.getSession('blocked-session').status).toBe('blocked');
      expect(repository.getTurn('running-turn')).toMatchObject({
        status: 'interrupted',
        endedAt: 1_700_000_010_000,
      });
      expect(repository.getTurn('starting-turn')).toMatchObject({
        status: 'interrupted',
        endedAt: 1_700_000_010_000,
      });
      expect(repository.getTurn('blocked-turn').status).toBe('blocked');
      expect(repository.listObserverEvidenceForTurn('running-turn')).toEqual([
        expect.objectContaining({
          source: 'agent-scope',
          kind: 'recovery',
          reason: 'Turn was interrupted because its owning session was stale.',
          payload: expect.objectContaining({ recovery: 'stale_session' }),
        }),
      ]);
    });
  });

  it('replays non-terminal projections and reports persisted drift', () => {
    withRepository((repository, client) => {
      repository.createSession({
        id: 'session-1',
        provider: 'mock',
        adapter: 'mock',
        startedAt: 1_700_000_000_000,
        capabilities: {},
        state: state('session-1'),
      });
      const reduce = (current: SessionState, next: AgentEvent): SessionState =>
        next.type === 'session_started' ? { ...current, status: 'running' } : current;
      repository.appendEvent(
        event('event-1', 'session-1', 'session_started'),
        state('session-1', 'running'),
      );

      expect(repository.verifySessionProjection('session-1', reduce)).toMatchObject({
        matches: true,
        differences: [],
      });

      client
        .prepare('UPDATE sessions SET state_json = ? WHERE id = ?')
        .run(JSON.stringify(state('session-1', 'blocked')), 'session-1');
      const drift = repository.verifySessionProjection('session-1', reduce);
      expect(drift.matches).toBe(false);
      expect(drift.differences).toContain('status');
      expect(repository.verifyNonTerminalProjections(reduce)).toHaveLength(1);
    });
  });
});
