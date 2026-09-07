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
