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
        roadmap: [
          {
            id: task.id,
            title: task.title,
            objective: task.objective,
            status: 'LOCKED',
          },
        ],
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
      expect(repository.getGoal('v1-control-goal').roadmap).toEqual([
        {
          id: task.id,
          title: task.title,
          objective: task.objective,
          status: 'LOCKED',
        },
      ]);
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

  it('atomically applies an instruction with context and audit evidence', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'instruction-boundary-goal',
        workspace: 'D:/workspace/instruction-boundary',
        prompt: 'Apply boundary context safely.',
        provider: 'mock',
        now: 1,
      });
      const task = repository.createTask({
        id: 'instruction-boundary-task',
        goalId: 'instruction-boundary-goal',
        title: 'Boundary task',
        objective: 'Use the applied context.',
        acceptanceCriteria: ['The context is visible to the Worker.'],
        sequence: 1,
        now: 2,
      });
      const instruction = repository.createInstruction({
        id: 'instruction-boundary-1',
        goalId: 'instruction-boundary-goal',
        kind: 'constraint',
        content: 'Keep the change local and verify it.',
        now: 3,
      });
      const result = repository.applyInstructionAtBoundary({
        id: instruction.id,
        status: 'APPLIED',
        appliedRevision: 0,
        appliedTaskId: task.id,
        decisionReason: 'Applied before the first Attempt.',
        executionMemory: {
          decisions: [{ id: 'instruction-boundary-1', status: 'STABLE' }],
          notes: ['instruction-boundary-1:applied'],
        },
        workingSet: { appliedInstructions: [{ id: instruction.id, content: instruction.content }] },
        event: {
          id: 'instruction-boundary-event-1',
          goalId: 'instruction-boundary-goal',
          taskId: task.id,
          type: 'goal.instruction.applied',
          payload: { instructionId: instruction.id, boundary: 'before-attempt' },
          confidence: 1,
          timestamp: 4,
        },
        now: 4,
      });
      expect(result.instruction).toMatchObject({
        status: 'APPLIED',
        appliedRevision: 0,
        appliedTaskId: task.id,
      });
      expect(result.goal.executionMemory).toMatchObject({
        notes: ['instruction-boundary-1:applied'],
      });
      expect(repository.listEvents('instruction-boundary-goal')).toMatchObject([
        { id: 'instruction-boundary-event-1', type: 'goal.instruction.applied', seq: 1 },
      ]);
    });
  });

  it('rolls back context and instruction status when boundary audit insertion fails', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'instruction-rollback-goal',
        workspace: 'D:/workspace/instruction-rollback',
        prompt: 'Keep the boundary atomic.',
        provider: 'mock',
        now: 1,
      });
      const instruction = repository.createInstruction({
        id: 'instruction-rollback-1',
        goalId: 'instruction-rollback-goal',
        kind: 'general',
        content: 'Record this only if every write succeeds.',
        now: 2,
      });
      repository.appendEvent({
        id: 'instruction-rollback-existing-event',
        goalId: 'instruction-rollback-goal',
        type: 'existing.event',
        payload: {},
        confidence: 1,
        timestamp: 3,
      });
      expect(() =>
        repository.applyInstructionAtBoundary({
          id: instruction.id,
          status: 'APPLIED',
          appliedRevision: 0,
          decisionReason: 'This must roll back.',
          executionMemory: { notes: ['must-not-persist'] },
          workingSet: { appliedInstructions: [{ id: instruction.id }] },
          event: {
            id: 'instruction-rollback-existing-event',
            goalId: 'instruction-rollback-goal',
            type: 'duplicate.event',
            payload: {},
            confidence: 1,
            timestamp: 4,
          },
          now: 4,
        }),
      ).toThrow();
      expect(repository.getInstruction(instruction.id).status).toBe('PENDING');
      expect(repository.getGoal('instruction-rollback-goal').executionMemory).toEqual({});
      expect(repository.listEvents('instruction-rollback-goal')).toHaveLength(1);
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

  it('edits a future Task Contract atomically with a new roadmap revision', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'future-contract-goal',
        workspace: 'D:/workspace/future-contract',
        prompt: 'Edit a future contract safely.',
        provider: 'mock',
        now: 700,
      });
      const task = repository.createTask({
        id: 'future-contract-task',
        goalId: 'future-contract-goal',
        title: 'Original title',
        objective: 'Original objective',
        acceptanceCriteria: ['The original requirement remains true.'],
        verification: { checks: ['deterministic'] },
        constraints: { noRemotePush: true },
        maxAttempts: 3,
        sequence: 1,
        tentative: true,
        now: 701,
      });
      repository.createRoadmapRevision({
        id: 'future-contract-revision-1',
        goalId: 'future-contract-goal',
        source: 'planner',
        reason: 'Initial future contract.',
        roadmap: [
          { id: task.id, title: task.title, objective: task.objective, status: 'TENTATIVE' },
        ],
        items: [
          {
            taskId: task.id,
            sequence: 1,
            operation: 'added',
            tentative: true,
            snapshot: { title: task.title, objective: task.objective },
          },
        ],
        now: 702,
      });

      const changed = repository.updateFutureTaskContract({
        id: 'future-contract-revision-2',
        goalId: 'future-contract-goal',
        taskId: task.id,
        reason: 'Clarify the future validation step.',
        expectedActiveRevision: 1,
        patch: {
          title: 'Clarified title',
          objective: 'Clarified objective',
          acceptanceCriteria: [
            'The original requirement remains true.',
            'The clarified behavior is independently verified.',
          ],
          maxAttempts: 2,
        },
        now: 703,
      });
      expect(changed.task).toMatchObject({
        title: 'Clarified title',
        objective: 'Clarified objective',
        maxAttempts: 2,
        status: 'PENDING',
      });
      expect(changed.revision).toMatchObject({
        revision: 2,
        parentRevision: 1,
        source: 'user',
        items: [{ taskId: task.id, operation: 'updated', sequence: 1 }],
      });
      expect(changed.goal.activeRevision).toBe(2);
      expect(changed.goal.roadmap).toEqual([
        {
          id: task.id,
          title: 'Clarified title',
          objective: 'Clarified objective',
          status: 'TENTATIVE',
        },
      ]);
      expect(changed.event.type).toBe('goal.roadmap.task_contract_updated');

      expect(() =>
        repository.updateFutureTaskContract({
          id: 'future-contract-revision-stale',
          goalId: 'future-contract-goal',
          taskId: task.id,
          reason: 'Stale edit.',
          expectedActiveRevision: 1,
          patch: { title: 'Should not persist' },
          now: 704,
        }),
      ).toThrow(StorageConflictError);
      expect(repository.getTask(task.id).title).toBe('Clarified title');
      expect(repository.listRoadmapRevisions('future-contract-goal')).toHaveLength(2);
    });
  });

  it('rejects edits to locked or already-started Task Contracts', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'contract-boundary-goal',
        workspace: 'D:/workspace/contract-boundary',
        prompt: 'Protect contract boundaries.',
        provider: 'mock',
        now: 710,
      });
      const locked = repository.createTask({
        id: 'contract-locked-task',
        goalId: 'contract-boundary-goal',
        title: 'Locked task',
        objective: 'Do not edit this task.',
        acceptanceCriteria: ['The locked task remains unchanged.'],
        sequence: 1,
        tentative: false,
        now: 711,
      });
      repository.createRoadmapRevision({
        id: 'contract-boundary-revision-1',
        goalId: 'contract-boundary-goal',
        source: 'planner',
        reason: 'Lock the task.',
        roadmap: [
          { id: locked.id, title: locked.title, objective: locked.objective, status: 'LOCKED' },
        ],
        items: [
          {
            taskId: locked.id,
            sequence: 1,
            operation: 'added',
            tentative: false,
            snapshot: { title: locked.title, objective: locked.objective },
          },
        ],
        now: 712,
      });
      expect(() =>
        repository.updateFutureTaskContract({
          id: 'contract-boundary-revision-2',
          goalId: 'contract-boundary-goal',
          taskId: locked.id,
          reason: 'Attempt to rewrite a locked task.',
          patch: { title: 'Unsafe rewrite' },
          now: 713,
        }),
      ).toThrow('LOCKED');

      const started = repository.createTask({
        id: 'contract-started-task',
        goalId: 'contract-boundary-goal',
        title: 'Started task',
        objective: 'Already running.',
        acceptanceCriteria: ['The running task is not edited.'],
        sequence: 2,
        tentative: true,
        now: 714,
      });
      repository.transitionTask(started.id, 'RUNNING', 715);
      expect(() =>
        repository.updateFutureTaskContract({
          id: 'contract-boundary-revision-3',
          goalId: 'contract-boundary-goal',
          taskId: started.id,
          reason: 'Attempt to edit a running task.',
          patch: { objective: 'Unsafe running edit' },
          now: 716,
        }),
      ).toThrow('not a future Task');
    });
  });

  it('inserts a future Task without changing the executed boundary', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'insert-roadmap-goal',
        workspace: 'D:/workspace/insert-roadmap',
        prompt: 'Insert a future task.',
        provider: 'mock',
        now: 720,
      });
      const locked = repository.createTask({
        id: 'insert-roadmap-locked',
        goalId: 'insert-roadmap-goal',
        title: 'Locked task',
        objective: 'Already selected.',
        acceptanceCriteria: ['The locked task runs first.'],
        sequence: 1,
        tentative: false,
        now: 721,
      });
      const future = repository.createTask({
        id: 'insert-roadmap-future',
        goalId: 'insert-roadmap-goal',
        title: 'Future task',
        objective: 'Run after the locked task.',
        acceptanceCriteria: ['The future task remains pending.'],
        sequence: 2,
        tentative: true,
        now: 722,
      });
      repository.createRoadmapRevision({
        id: 'insert-roadmap-revision-1',
        goalId: 'insert-roadmap-goal',
        source: 'planner',
        reason: 'Initial roadmap.',
        roadmap: [
          { id: locked.id, title: locked.title, objective: locked.objective, status: 'LOCKED' },
          { id: future.id, title: future.title, objective: future.objective, status: 'TENTATIVE' },
        ],
        items: [
          {
            taskId: locked.id,
            sequence: 1,
            operation: 'added',
            tentative: false,
            snapshot: { title: locked.title },
          },
          {
            taskId: future.id,
            sequence: 2,
            operation: 'added',
            tentative: true,
            snapshot: { title: future.title },
          },
        ],
        now: 723,
      });

      const inserted = repository.insertRoadmapTask({
        id: 'insert-roadmap-revision-2',
        goalId: 'insert-roadmap-goal',
        taskId: 'insert-roadmap-inserted',
        title: 'Inserted task',
        objective: 'Run this before the existing future task.',
        acceptanceCriteria: ['The inserted task is independently verified.'],
        sequence: 2,
        tentative: true,
        reason: 'Add a missing validation step.',
        expectedActiveRevision: 1,
        now: 724,
      });
      expect(inserted.task).toMatchObject({ id: 'insert-roadmap-inserted', sequence: 2 });
      expect(repository.listTasks('insert-roadmap-goal')).toMatchObject([
        { id: locked.id, sequence: 1 },
        { id: 'insert-roadmap-inserted', sequence: 2 },
        { id: future.id, sequence: 3 },
      ]);
      expect(inserted.goal.roadmap).toMatchObject([
        { id: locked.id, status: 'LOCKED' },
        { id: 'insert-roadmap-inserted', status: 'TENTATIVE' },
        { id: future.id, status: 'TENTATIVE' },
      ]);
      expect(inserted.revision.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: 'insert-roadmap-inserted', operation: 'added' }),
          expect.objectContaining({ taskId: future.id, operation: 'updated', sequence: 3 }),
        ]),
      );

      repository.transitionTask(locked.id, 'RUNNING', 725);
      expect(() =>
        repository.insertRoadmapTask({
          id: 'insert-roadmap-invalid',
          goalId: 'insert-roadmap-goal',
          taskId: 'insert-roadmap-before-locked',
          title: 'Unsafe task',
          objective: 'Would change execution order.',
          acceptanceCriteria: ['Rejected.'],
          sequence: 1,
          reason: 'Try to insert before the locked boundary.',
          now: 726,
        }),
      ).toThrow('between 2 and 4');
    });
  });

  it('skips a future tentative Task with an auditable reason', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'skip-roadmap-goal',
        workspace: 'D:/workspace/skip-roadmap',
        prompt: 'Skip an optional task safely.',
        provider: 'mock',
        now: 730,
      });
      const task = repository.createTask({
        id: 'skip-roadmap-task',
        goalId: 'skip-roadmap-goal',
        title: 'Optional task',
        objective: 'This optional check can be deferred.',
        acceptanceCriteria: ['The task is optional.'],
        sequence: 1,
        tentative: true,
        now: 731,
      });
      repository.createRoadmapRevision({
        id: 'skip-roadmap-revision-1',
        goalId: 'skip-roadmap-goal',
        source: 'planner',
        reason: 'Initial roadmap.',
        roadmap: [
          { id: task.id, title: task.title, objective: task.objective, status: 'TENTATIVE' },
        ],
        items: [
          {
            taskId: task.id,
            sequence: 1,
            operation: 'added',
            tentative: true,
            snapshot: { title: task.title },
          },
        ],
        now: 732,
      });

      const skipped = repository.skipRoadmapTask({
        id: 'skip-roadmap-revision-2',
        goalId: 'skip-roadmap-goal',
        taskId: task.id,
        reason: 'The optional check is not needed for this run.',
        expectedActiveRevision: 1,
        now: 733,
      });
      expect(skipped.task).toMatchObject({ status: 'SKIPPED', endedAt: 733 });
      expect(skipped.goal.roadmap).toEqual([
        { id: task.id, title: task.title, objective: task.objective, status: 'SKIPPED' },
      ]);
      expect(skipped.revision.items).toEqual([
        expect.objectContaining({ taskId: task.id, operation: 'skipped', sequence: 1 }),
      ]);
      expect(skipped.event).toMatchObject({
        type: 'goal.roadmap.task_skipped',
        payload: expect.objectContaining({ requirementImpact: 'requires-final-verification' }),
      });
      expect(() =>
        repository.skipRoadmapTask({
          id: 'skip-roadmap-revision-3',
          goalId: 'skip-roadmap-goal',
          taskId: task.id,
          reason: 'Skip it twice.',
          now: 734,
        }),
      ).toThrow('not a future Task');
    });
  });

  it('reorders exactly the future tentative Tasks and preserves the boundary', () => {
    withRepository((repository) => {
      repository.createGoal({
        id: 'reorder-roadmap-goal',
        workspace: 'D:/workspace/reorder-roadmap',
        prompt: 'Reorder future tasks safely.',
        provider: 'mock',
        now: 740,
      });
      const locked = repository.createTask({
        id: 'reorder-locked',
        goalId: 'reorder-roadmap-goal',
        title: 'Locked first',
        objective: 'The executed boundary remains first.',
        acceptanceCriteria: ['The locked task stays first.'],
        sequence: 1,
        tentative: false,
        now: 741,
      });
      const first = repository.createTask({
        id: 'reorder-future-a',
        goalId: 'reorder-roadmap-goal',
        title: 'Future A',
        objective: 'Run A.',
        acceptanceCriteria: ['A is verified.'],
        sequence: 2,
        tentative: true,
        now: 742,
      });
      const second = repository.createTask({
        id: 'reorder-future-b',
        goalId: 'reorder-roadmap-goal',
        title: 'Future B',
        objective: 'Run B.',
        acceptanceCriteria: ['B is verified.'],
        sequence: 3,
        tentative: true,
        now: 743,
      });
      repository.createRoadmapRevision({
        id: 'reorder-roadmap-revision-1',
        goalId: 'reorder-roadmap-goal',
        source: 'planner',
        reason: 'Initial roadmap.',
        roadmap: [
          { id: locked.id, title: locked.title, objective: locked.objective, status: 'LOCKED' },
          { id: first.id, title: first.title, objective: first.objective, status: 'TENTATIVE' },
          { id: second.id, title: second.title, objective: second.objective, status: 'TENTATIVE' },
        ],
        items: [
          { taskId: locked.id, sequence: 1, operation: 'added', tentative: false, snapshot: {} },
          { taskId: first.id, sequence: 2, operation: 'added', tentative: true, snapshot: {} },
          { taskId: second.id, sequence: 3, operation: 'added', tentative: true, snapshot: {} },
        ],
        now: 744,
      });

      const reordered = repository.reorderRoadmapTasks({
        id: 'reorder-roadmap-revision-2',
        goalId: 'reorder-roadmap-goal',
        taskIds: [second.id, first.id],
        reason: 'Run the second validation before the first.',
        expectedActiveRevision: 1,
        now: 745,
      });
      expect(reordered.tasks).toMatchObject([
        { id: locked.id, sequence: 1 },
        { id: second.id, sequence: 2 },
        { id: first.id, sequence: 3 },
      ]);
      expect(reordered.goal.roadmap.map((item) => item.id)).toEqual([
        locked.id,
        second.id,
        first.id,
      ]);
      expect(reordered.revision.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: second.id, operation: 'updated', sequence: 2 }),
          expect.objectContaining({ taskId: first.id, operation: 'updated', sequence: 3 }),
        ]),
      );
      expect(reordered.event.type).toBe('goal.roadmap.reordered');

      expect(() =>
        repository.reorderRoadmapTasks({
          id: 'reorder-roadmap-invalid',
          goalId: 'reorder-roadmap-goal',
          taskIds: [second.id, second.id],
          reason: 'Duplicate task.',
          now: 746,
        }),
      ).toThrow('duplicate Task IDs');
      expect(() =>
        repository.reorderRoadmapTasks({
          id: 'reorder-roadmap-missing',
          goalId: 'reorder-roadmap-goal',
          taskIds: [second.id],
          reason: 'Omit a future task.',
          now: 747,
        }),
      ).toThrow('exactly every');
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
