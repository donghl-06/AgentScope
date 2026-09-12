import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openStorage } from './database.js';
import { StorageConflictError } from './repository.js';
import {
  OrchestratorRepository,
  OrchestratorStateError,
  type WorkerResult,
} from './orchestrator.js';

function withRepository(test: (repository: OrchestratorRepository) => void): void {
  const filename = path.join(
    os.tmpdir(),
    `agentscope-orchestrator-${Date.now()}-${Math.random()}.db`,
  );
  const { client } = openStorage({ filename, migrate: true });
  try {
    test(new OrchestratorRepository(client));
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

describe('OrchestratorRepository', () => {
  it('persists the goal/task/attempt/verification lifecycle and event sequence', () => {
    withRepository((repository) => {
      const notifications: string[] = [];
      repository.subscribe((notification) => notifications.push(notification.type));

      const goal = repository.createGoal({
        id: 'goal-1',
        workspace: 'D:/workspace/example',
        prompt: 'Implement a safe feature.',
        provider: 'claude',
        now: 100,
      });
      expect(goal.status).toBe('CREATED');
      repository.transitionGoal('goal-1', 'PLANNING', 110);
      repository.transitionGoal('goal-1', 'RUNNING', 120);

      const task = repository.createTask({
        id: 'task-1',
        goalId: 'goal-1',
        title: 'Implement feature',
        objective: 'Make the requested change.',
        acceptanceCriteria: ['The feature is present.'],
        verification: { checks: [{ id: 'typecheck', executable: 'pnpm', args: ['typecheck'] }] },
        sequence: 1,
        now: 130,
      });
      expect(task.maxAttempts).toBe(3);
      repository.transitionTask('task-1', 'RUNNING', 140);

      const attempt = repository.createAttempt({
        id: 'attempt-1',
        taskId: 'task-1',
        attemptNumber: 1,
        provider: 'claude',
        now: 150,
      });
      repository.updateAttempt('attempt-1', { status: 'RUNNING' }, 160);
      const workerResult: WorkerResult = {
        claimedStatus: 'completed',
        summary: 'Implemented the feature.',
        changedFiles: ['src/feature.ts'],
        reportedVerification: { tests: 'passed' },
      };
      const completedAttempt = repository.updateAttempt(
        'attempt-1',
        { status: 'COMPLETED', workerResult },
        170,
      );
      expect(completedAttempt.workerResult).toEqual(workerResult);

      repository.transitionTask('task-1', 'VERIFYING', 180);
      const verification = repository.createVerificationRun({
        id: 'verification-1',
        taskId: 'task-1',
        attemptId: attempt.id,
        status: 'PASS',
        criteria: ['The feature is present.'],
        deterministicChecks: [{ id: 'typecheck', exitCode: 0 }],
        evidence: [{ kind: 'git-diff', files: ['src/feature.ts'] }],
        reason: 'All deterministic checks passed.',
        now: 190,
      });
      expect(verification.status).toBe('PASS');
      repository.transitionTask('task-1', 'COMPLETED', 200);
      repository.transitionGoal('goal-1', 'VERIFYING', 210);
      repository.transitionGoal('goal-1', 'COMPLETED', 220);

      const firstEvent = repository.appendEvent({
        id: 'event-1',
        goalId: 'goal-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        type: 'task.completed',
        payload: { status: 'PASS' },
        confidence: 1,
        timestamp: 230,
      });
      const secondEvent = repository.appendEvent({
        id: 'event-2',
        goalId: 'goal-1',
        type: 'goal.completed',
        payload: { verified: true },
        confidence: 1,
        timestamp: 240,
      });
      expect([firstEvent.seq, secondEvent.seq]).toEqual([1, 2]);
      expect(repository.listEvents('goal-1')).toHaveLength(2);
      expect(repository.listTasks('goal-1')[0]).toMatchObject({ status: 'COMPLETED' });
      expect(repository.getGoal('goal-1')).toMatchObject({ status: 'COMPLETED', completedAt: 220 });
      expect(notifications).toEqual([
        'goal.created',
        'goal.updated',
        'goal.updated',
        'task.created',
        'task.updated',
        'attempt.created',
        'attempt.updated',
        'attempt.updated',
        'task.updated',
        'verification.created',
        'task.updated',
        'goal.updated',
        'goal.updated',
        'event.appended',
        'event.appended',
      ]);
    });
  });

  it('rejects unsafe status transitions instead of silently rewriting state', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'goal-invalid',
        workspace: 'D:/workspace/example',
        prompt: 'Do not complete without verification.',
        provider: 'codex',
      });
      expect(() => repository.transitionGoal('goal-invalid', 'COMPLETED')).toThrow(
        OrchestratorStateError,
      );
      repository.createTask({
        id: 'task-invalid',
        goalId: 'goal-invalid',
        title: 'Pending task',
        objective: 'Wait for a worker.',
        acceptanceCriteria: [],
        sequence: 1,
      });
      expect(() => repository.transitionTask('task-invalid', 'COMPLETED')).toThrow(
        OrchestratorStateError,
      );
    });
  });

  it('enforces one active Goal across repository instances', () => {
    const { client } = openStorage({ filename: ':memory:', migrate: true });
    const first = new OrchestratorRepository(client);
    const second = new OrchestratorRepository(client);
    first.createGoal({
      id: 'active-one',
      workspace: 'D:/workspace',
      prompt: 'First active goal',
      provider: 'mock',
    });
    first.transitionGoal('active-one', 'PLANNING');
    second.createGoal({
      id: 'active-two',
      workspace: 'D:/workspace',
      prompt: 'Second active goal',
      provider: 'mock',
    });

    expect(() => second.transitionGoal('active-two', 'PLANNING')).toThrow(StorageConflictError);
    expect(first.getGoal('active-one').status).toBe('PLANNING');
    client.close();
  });

  it('persists idempotent command reservations and replays only the same payload', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'command-goal',
        workspace: 'D:/workspace/commands',
        prompt: 'Exercise command idempotency.',
        provider: 'mock',
        now: 1,
      });
      const first = repository.reserveOrchestratorCommand({
        id: 'command-1',
        goalId: 'command-goal',
        commandKind: 'pause',
        idempotencyKey: 'pause-1',
        payload: { reason: 'operator request', enabled: true },
        expectedRevision: 0,
        now: 2,
      });
      expect(first).toMatchObject({ replayed: false, command: { status: 'PENDING' } });
      expect(() =>
        repository.reserveOrchestratorCommand({
          id: 'command-2',
          goalId: 'command-goal',
          commandKind: 'pause',
          idempotencyKey: 'pause-2',
          payload: { reason: 'stale revision' },
          expectedRevision: 1,
          now: 3,
        }),
      ).toThrow(StorageConflictError);
      expect(() =>
        repository.reserveOrchestratorCommand({
          id: 'command-3',
          goalId: 'command-goal',
          commandKind: 'pause',
          idempotencyKey: 'pause-1',
          payload: { enabled: false, reason: 'operator request' },
          expectedRevision: 0,
          now: 3,
        }),
      ).toThrow('different command input');
      expect(() =>
        repository.reserveOrchestratorCommand({
          id: 'command-4',
          goalId: 'command-goal',
          commandKind: 'pause',
          idempotencyKey: 'pause-1',
          payload: { reason: 'operator request', enabled: true },
          expectedRevision: 0,
          now: 3,
        }),
      ).toThrow('still in progress');

      repository.completeOrchestratorCommand(
        'command-1',
        { goalId: 'command-goal', status: 'PAUSED' },
        4,
      );
      const replay = repository.reserveOrchestratorCommand({
        id: 'command-5',
        goalId: 'command-goal',
        commandKind: 'pause',
        idempotencyKey: 'pause-1',
        payload: { reason: 'operator request', enabled: true },
        expectedRevision: 0,
        now: 5,
      });
      expect(replay).toMatchObject({
        replayed: true,
        command: { status: 'APPLIED', result: { status: 'PAUSED' } },
      });
      expect(repository.listOrchestratorCommands('command-goal')).toHaveLength(1);
    });
  });

  it('persists V1 control entities with validation and transactional revision updates', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'v1-control-goal',
        workspace: 'D:/workspace/v1-control',
        prompt: 'Exercise the V1 control repository.',
        provider: 'mock',
        now: 100,
      });
      const task = repository.createTask({
        id: 'v1-control-task',
        goalId: 'v1-control-goal',
        title: 'Controlled task',
        objective: 'Keep the repository state auditable.',
        acceptanceCriteria: ['The control state is persisted.'],
        sequence: 1,
        now: 101,
      });

      const instruction = repository.createInstruction({
        id: 'v1-instruction-1',
        goalId: 'v1-control-goal',
        kind: 'constraint',
        content: 'Do not push to a remote repository.',
        now: 102,
      });
      expect(instruction).toMatchObject({ status: 'PENDING', baseRevision: 0, source: 'user' });
      expect(() =>
        repository.createInstruction({
          id: 'v1-instruction-empty',
          goalId: 'v1-control-goal',
          kind: 'general',
          content: ' '.repeat(1),
        }),
      ).toThrow('must not be empty');
      expect(() =>
        repository.createInstruction({
          id: 'v1-instruction-too-long',
          goalId: 'v1-control-goal',
          kind: 'general',
          content: 'x'.repeat(16_001),
        }),
      ).toThrow('at most 16000');
      expect(() =>
        repository.createInstruction({
          id: 'v1-instruction-invalid-source',
          goalId: 'v1-control-goal',
          kind: 'general',
          content: 'Valid content',
          source: 'operator' as never,
        }),
      ).toThrow('Unknown instruction source');

      const revision = repository.createRoadmapRevision({
        id: 'v1-roadmap-revision-1',
        goalId: 'v1-control-goal',
        source: 'user',
        reason: 'Lock the first controlled task.',
        items: [
          {
            taskId: task.id,
            sequence: 1,
            operation: 'retain',
            tentative: false,
            snapshot: { title: task.title, objective: task.objective },
          },
        ],
        now: 103,
      });
      expect(revision.revision).toBe(1);
      expect(revision.parentRevision).toBeUndefined();
      expect(repository.getGoal('v1-control-goal').activeRevision).toBe(1);
      expect(repository.listRoadmapRevisions('v1-control-goal')).toHaveLength(1);

      const appliedInstruction = repository.transitionInstruction(
        instruction.id,
        'APPLIED',
        {
          appliedRevision: 1,
          appliedTaskId: task.id,
          decisionReason: 'Applied at the planning boundary.',
        },
        104,
      );
      expect(appliedInstruction).toMatchObject({ status: 'APPLIED', appliedRevision: 1 });

      const memory = repository.createMemorySnapshot({
        id: 'v1-memory-1',
        goalId: 'v1-control-goal',
        revision: 1,
        memory: { decisions: [{ id: 'no-push', status: 'LOCKED' }] },
        sources: [{ kind: 'instruction', id: instruction.id }],
        now: 105,
      });
      expect(repository.getMemorySnapshot(memory.id).sources).toEqual([
        { kind: 'instruction', id: instruction.id },
      ]);

      const approval = repository.createApprovalRequest({
        id: 'v1-approval-1',
        goalId: 'v1-control-goal',
        taskId: task.id,
        riskLevel: 'network',
        action: 'fetch dependency metadata',
        scope: { host: 'registry.example.test' },
        now: 106,
      });
      expect(
        repository.transitionApprovalRequest(
          approval.id,
          'APPROVED',
          'Approved for this scope',
          107,
        ),
      ).toMatchObject({
        status: 'APPROVED',
        decisionReason: 'Approved for this scope',
      });

      const firstLease = repository.acquireGoalRunLease({
        goalId: 'v1-control-goal',
        ownerId: 'owner-a',
        ttlMs: 100,
        now: 108,
      });
      expect(firstLease.generation).toBe(1);
      expect(() =>
        repository.acquireGoalRunLease({
          goalId: 'v1-control-goal',
          ownerId: 'owner-b',
          ttlMs: 100,
          now: 150,
        }),
      ).toThrow(StorageConflictError);
      expect(
        repository.renewGoalRunLease('v1-control-goal', 'owner-a', 1, 100, 150).expiresAt,
      ).toBe(250);
      expect(repository.releaseGoalRunLease('v1-control-goal', 'owner-a', 1, 151)).toBe(true);
      expect(repository.getGoalRunLease('v1-control-goal')).toMatchObject({
        ownerId: 'owner-a',
        generation: 1,
        expiresAt: 151,
      });

      const metric = repository.createGoalMetricSnapshot({
        id: 'v1-metric-1',
        goalId: 'v1-control-goal',
        taskId: task.id,
        progress: 0.5,
        eta: { minSeconds: 10, maxSeconds: 30 },
        confidence: 0.25,
        reasons: [{ code: 'fixture', message: 'Fixture metric.' }],
        capturedAt: 152,
      });
      expect(repository.listGoalMetricSnapshots('v1-control-goal')).toMatchObject([
        { id: metric.id, progress: 0.5, confidence: 0.25 },
      ]);

      const notification = repository.createOrchestratorNotification({
        id: 'v1-notification-1',
        goalId: 'v1-control-goal',
        eventKey: 'goal.needs-human:v1-control-goal',
        kind: 'needs-human',
        payload: { reason: 'Fixture notification.' },
        now: 153,
      });
      repository.transitionOrchestratorNotification(notification.id, 'DELIVERED', 154);
      expect(
        repository.transitionOrchestratorNotification(notification.id, 'READ', 155),
      ).toMatchObject({
        status: 'READ',
        deliveredAt: 154,
        readAt: 155,
      });
    });
  });

  it('rejects stale roadmap revisions without partially updating the active revision', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'v1-revision-conflict-goal',
        workspace: 'D:/workspace/v1-revision-conflict',
        prompt: 'Exercise roadmap conflict handling.',
        provider: 'mock',
        now: 200,
      });
      repository.createTask({
        id: 'v1-revision-conflict-task',
        goalId: 'v1-revision-conflict-goal',
        title: 'Conflict task',
        objective: 'Keep the active revision consistent.',
        acceptanceCriteria: ['The revision remains atomic.'],
        sequence: 1,
        now: 201,
      });
      repository.createRoadmapRevision({
        id: 'v1-revision-conflict-first',
        goalId: 'v1-revision-conflict-goal',
        source: 'planner',
        reason: 'Create the first revision.',
        items: [
          {
            taskId: 'v1-revision-conflict-task',
            sequence: 1,
            operation: 'retain',
            tentative: false,
            snapshot: { title: 'Conflict task' },
          },
        ],
        now: 202,
      });

      expect(() =>
        repository.createRoadmapRevision({
          id: 'v1-revision-conflict-stale',
          goalId: 'v1-revision-conflict-goal',
          expectedActiveRevision: 0,
          source: 'user',
          reason: 'Use a stale revision on purpose.',
          items: [],
          now: 203,
        }),
      ).toThrow(StorageConflictError);
      expect(repository.getGoal('v1-revision-conflict-goal').activeRevision).toBe(1);
      expect(repository.listRoadmapRevisions('v1-revision-conflict-goal')).toHaveLength(1);
    });
  });

  it('lists Goal history with stable cursor pagination and filters', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'history-alpha',
        workspace: 'D:/workspace/one',
        prompt: 'Alpha history goal',
        provider: 'claude',
        now: 300,
      });
      repository.createGoal({
        id: 'history-beta',
        workspace: 'D:/workspace/two',
        prompt: 'Beta history goal',
        provider: 'codex',
        now: 200,
      });
      repository.createGoal({
        id: 'history-gamma',
        workspace: 'D:/workspace/one',
        prompt: 'Gamma history goal',
        provider: 'claude',
        now: 100,
      });
      repository.transitionGoal('history-beta', 'PAUSED', 250);

      const firstPage = repository.listGoalPage({ limit: 2 });
      expect(firstPage.items.map((goal) => goal.id)).toEqual(['history-alpha', 'history-beta']);
      expect(firstPage.nextCursor).toBeDefined();
      const secondPage = repository.listGoalPage({
        ...(firstPage.nextCursor === undefined ? {} : { cursor: firstPage.nextCursor }),
        limit: 2,
      });
      expect(secondPage.items.map((goal) => goal.id)).toEqual(['history-gamma']);
      expect(secondPage.nextCursor).toBeUndefined();
      expect(repository.listGoalPage({ status: 'PAUSED' }).items.map((goal) => goal.id)).toEqual([
        'history-beta',
      ]);
      expect(
        repository
          .listGoalPage({ provider: 'claude', workspace: 'D:/workspace/one' })
          .items.map((goal) => goal.id),
      ).toEqual(['history-alpha', 'history-gamma']);
      expect(repository.listGoalPage({ query: 'ALPHA' }).items.map((goal) => goal.id)).toEqual([
        'history-alpha',
      ]);
      expect(() => repository.listGoalPage({ cursor: 'not-a-cursor' })).toThrow(
        'Invalid Goal cursor',
      );
    });
  });

  it('archives only non-active Goals and keeps archived history recoverable', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'archive-running',
        workspace: 'D:/workspace/archive',
        prompt: 'The active Goal must remain visible.',
        provider: 'mock',
        now: 400,
      });
      repository.transitionGoal('archive-running', 'PLANNING', 401);
      expect(() => repository.archiveGoal('archive-running', 402)).toThrow(OrchestratorStateError);

      repository.createGoal({
        id: 'archive-paused',
        workspace: 'D:/workspace/archive',
        prompt: 'Archive this paused Goal safely.',
        provider: 'mock',
        now: 403,
      });
      repository.transitionGoal('archive-paused', 'PAUSED', 404);
      const archived = repository.archiveGoal('archive-paused', 405);
      expect(archived.archivedAt).toBe(405);
      expect(repository.listGoalPage().items.map((goal) => goal.id)).toEqual(['archive-running']);
      expect(
        repository.listGoalPage({ includeArchived: true }).items.map((goal) => goal.id),
      ).toEqual(['archive-paused', 'archive-running']);
      expect(repository.unarchiveGoal('archive-paused', 406).archivedAt).toBeUndefined();
      expect(repository.listGoalPage().items.map((goal) => goal.id)).toEqual([
        'archive-paused',
        'archive-running',
      ]);
    });
  });
});
