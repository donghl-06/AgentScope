import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { openStorage } from '@agentscope/storage';
import { OrchestratorRepository } from '@agentscope/storage';

import {
  OrchestratorEngine,
  SerialWorkerRuntime,
  type BootstrapContext,
  type Planner,
  type ProjectState,
  type InitialPlan,
  type RollingPlan,
  type WorkingSet,
} from './index.js';
import type { WorkerLaunchRequest } from './worker.js';

const projectState = {
  workspace: 'D:/workspace/engine',
  capturedAt: 1,
  git: {
    rootPath: 'D:/workspace/engine',
    isRepository: true,
    files: [],
    trackedFiles: [],
    diffStat: [],
    capturedAt: 1,
  },
  packageManager: 'unknown',
  manifests: [],
  techStack: [],
  topLevelDirectories: [],
  discoverableVerification: [],
  recentCommits: [],
  relevantFiles: [],
} as ProjectState;
const workingSet: WorkingSet = {
  files: [],
  directories: [],
  rationale: 'test',
  updatedAt: 1,
};
const context: BootstrapContext = {
  projectState,
  workingSet,
  executionMemory: {
    decisions: [],
    completedTaskIds: [],
    failedApproaches: [],
    notes: [],
  },
};

class SingleTaskPlanner implements Planner {
  planInitial(input: Parameters<Planner['planInitial']>[0]): InitialPlan {
    const task = {
      id: `${input.goal.id}:task:1`,
      title: 'Implement one task',
      objective: input.goal.prompt,
      acceptanceCriteria: ['The task is independently verified.'],
      verification: { checks: [{ id: 'test', executable: 'pnpm', args: ['run', 'test'] }] },
      constraints: { singleWorker: true },
      maxAttempts: 3,
      sequence: 1,
      tentative: false,
    } as const;
    return {
      goalId: input.goal.id,
      roadmap: [{ id: task.id, title: task.title, objective: task.objective, status: 'LOCKED' }],
      firstTask: task,
      tentativeTasks: [],
      rationale: 'test planner',
    };
  }

  planRolling(input: Parameters<Planner['planRolling']>[0]): RollingPlan {
    const pending = input.tasks.find((task) => task.status === 'PENDING');
    if (pending !== undefined) {
      return {
        goalId: input.goal.id,
        action: 'NEXT_TASK',
        nextTask: {
          id: pending.id,
          title: pending.title,
          objective: pending.objective,
          acceptanceCriteria: pending.acceptanceCriteria,
          verification: pending.verification,
          constraints: pending.constraints,
          maxAttempts: pending.maxAttempts,
          sequence: pending.sequence,
          tentative: pending.tentative,
          ...(pending.parentTaskId === undefined ? {} : { parentTaskId: pending.parentTaskId }),
        },
        rationale: 'test next task',
      };
    }
    return {
      goalId: input.goal.id,
      action: 'GOAL_READY_FOR_FINAL_VERIFICATION',
      rationale: 'test final',
    };
  }
}

async function withEngine(
  verify: ((attempt: number) => 'PASS' | 'FAIL' | 'UNCERTAIN') | 'PASS' | 'FAIL' | 'UNCERTAIN',
  test: (engine: OrchestratorEngine, repository: OrchestratorRepository) => Promise<void>,
  finalStatus: 'PASS' | 'FAIL' = 'PASS',
  contextProvider: () => Promise<BootstrapContext> = async () => context,
  onEngine?: (engine: OrchestratorEngine) => void,
  onWorker?: (request: WorkerLaunchRequest) => void,
): Promise<void> {
  const filename = path.join(os.tmpdir(), `agentscope-engine-${Date.now()}-${Math.random()}.db`);
  const { client } = openStorage({ filename, migrate: true });
  try {
    const repository = new OrchestratorRepository(client);
    let attemptCount = 0;
    const worker = new SerialWorkerRuntime({
      launch: async (request) => {
        onWorker?.(request);
        return {
          attemptId: request.attemptId,
          status: 'completed' as const,
          exitCode: 0,
          summary: 'worker completed',
          changedFiles: ['src/feature.ts'],
          reportedVerification: {},
        };
      },
    });
    const engine = new OrchestratorEngine({
      repository,
      planner: new SingleTaskPlanner(),
      worker,
      contextProvider,
      verifyTask: async () => {
        attemptCount += 1;
        const status = typeof verify === 'function' ? verify(attemptCount) : verify;
        return {
          status,
          criteria: [{ criterion: 'The task is independently verified.', status, reason: 'test' }],
          deterministicChecks: [],
          evidence: [{ kind: 'test', attempt: attemptCount }],
          reason: status === 'PASS' ? 'passed' : status === 'FAIL' ? 'failed' : 'uncertain',
        };
      },
      verifyGoal: async () => ({
        status: finalStatus,
        criteria: [{ criterion: 'Goal verified.', status: finalStatus, reason: 'test' }],
        deterministicChecks: [],
        evidence: [{ kind: 'final' }],
        reason: finalStatus === 'PASS' ? 'final pass' : 'final gap',
      }),
      now: (() => {
        let value = 100;
        return () => (value += 1);
      })(),
    });
    onEngine?.(engine);
    await test(engine, repository);
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

describe('OrchestratorEngine', () => {
  it('refreshes Project State after an Attempt boundary before final planning', async () => {
    let contextCalls = 0;
    const refreshedContext: BootstrapContext = {
      ...context,
      projectState: {
        ...projectState,
        capturedAt: 2,
        relevantFiles: ['src/changed.ts'],
      },
      workingSet: {
        ...workingSet,
        files: ['src/changed.ts'],
        updatedAt: 2,
      },
    };
    await withEngine(
      'PASS',
      async (engine, repository) => {
        const result = await engine.createGoalAndRun({
          id: 'goal-context-refresh',
          workspace: projectState.workspace,
          prompt: 'Refresh project state between boundaries.',
          provider: 'mock',
        });
        expect(result.status).toBe('COMPLETED');
        expect(contextCalls).toBeGreaterThan(1);
        expect(repository.getGoal('goal-context-refresh').projectState).toMatchObject({
          capturedAt: 2,
          relevantFiles: ['src/changed.ts'],
        });
        expect(repository.getGoal('goal-context-refresh').workingSet).toMatchObject({
          files: expect.arrayContaining(['src/changed.ts']),
        });
        expect(
          repository
            .listEvents('goal-context-refresh')
            .filter((event) => event.type === 'goal.project_state.refreshed'),
        ).not.toHaveLength(0);
      },
      'PASS',
      async () => {
        contextCalls += 1;
        return contextCalls === 1 ? context : refreshedContext;
      },
    );
  });

  it('gates high-risk Tasks on an exact approval before starting a Worker', async () => {
    await withEngine('PASS', async (engine, repository) => {
      const goal = repository.createGoal({
        id: 'goal-approval-gate',
        workspace: projectState.workspace,
        prompt: 'Safely remove generated data.',
        provider: 'mock',
      });
      const task = repository.createTask({
        id: 'goal-approval-gate:task:1',
        goalId: goal.id,
        title: 'Delete generated data',
        objective: 'Remove the generated directory.',
        acceptanceCriteria: ['Only the generated directory is removed.'],
        sequence: 1,
        tentative: false,
      });
      repository.createRoadmapRevision({
        id: 'goal-approval-gate:roadmap:1',
        goalId: goal.id,
        source: 'planner',
        reason: 'Initial locked destructive task.',
        roadmap: [{ id: task.id, title: task.title, objective: task.objective, status: 'LOCKED' }],
        items: [
          {
            taskId: task.id,
            sequence: 1,
            operation: 'added',
            tentative: false,
            snapshot: { title: task.title, objective: task.objective },
          },
        ],
      });

      const blocked = await engine.runGoal(goal.id);
      expect(blocked.status).toBe('NEEDS_HUMAN');
      expect(repository.listAttempts(task.id)).toHaveLength(0);
      const approval = repository.listApprovalRequests(goal.id)[0];
      expect(approval).toMatchObject({
        action: 'execute-task',
        riskLevel: 'CRITICAL',
        status: 'PENDING',
        scope: { taskId: task.id, activeRevision: 1 },
      });

      engine.approveApproval(goal.id, approval!.id, 'Approved for this exact test scope.');
      const resumed = await engine.resumeGoal(goal.id, { confirmExternalProcessStopped: true });
      expect(resumed.status).toBe('COMPLETED');
      expect(repository.listAttempts(task.id)).toHaveLength(1);
      expect(repository.getApprovalRequest(approval!.id).status).toBe('APPROVED');
      expect(
        repository.listEvents(goal.id).some((event) => event.type === 'goal.approval.requested'),
      ).toBe(true);
    });
  });

  it('runs one serial Task and completes only after final verification', async () => {
    await withEngine('PASS', async (engine, repository) => {
      const result = await engine.createGoalAndRun({
        id: 'goal-pass',
        workspace: projectState.workspace,
        prompt: 'Implement the feature.',
        provider: 'claude',
      });
      expect(result.status).toBe('COMPLETED');
      expect(result.tasks).toMatchObject([{ status: 'COMPLETED' }]);
      expect(repository.listAttempts('goal-pass:task:1')).toHaveLength(1);
      expect(repository.listEvents('goal-pass')).not.toHaveLength(0);
      const revisions = repository.listRoadmapRevisions('goal-pass');
      expect(revisions).toHaveLength(2);
      expect(revisions[0]).toMatchObject({
        revision: 1,
        source: 'planner',
        items: [{ taskId: 'goal-pass:task:1', operation: 'added', sequence: 1 }],
      });
      expect(revisions[1]).toMatchObject({
        revision: 2,
        parentRevision: 1,
        source: 'planner',
        reason: 'test final',
        items: [{ taskId: 'goal-pass:task:1', operation: 'updated', sequence: 1 }],
      });
      expect(repository.getGoal('goal-pass').roadmap).toMatchObject([
        { id: 'goal-pass:task:1', status: 'COMPLETED' },
      ]);
      expect(
        repository.listEvents('goal-pass').find((event) => event.type === 'goal.rolling_plan'),
      ).toMatchObject({
        payload: {
          auditVersion: 1,
          input: { schemaVersion: 1, goal: { id: 'goal-pass' } },
          output: { schemaVersion: 1, action: expect.any(String) },
        },
      });
    });
  });

  it('retries a failed verification within the task budget', async () => {
    await withEngine(
      (attempt) => (attempt === 1 ? 'FAIL' : 'PASS'),
      async (engine, repository) => {
        const result = await engine.createGoalAndRun({
          id: 'goal-retry',
          workspace: projectState.workspace,
          prompt: 'Repair the feature.',
          provider: 'claude',
        });
        expect(result.status).toBe('COMPLETED');
        expect(repository.listAttempts('goal-retry:task:1')).toHaveLength(2);
      },
    );
  });

  it('edits a future Task Contract through the idempotent engine command', async () => {
    await withEngine('PASS', async (engine, repository) => {
      repository.createGoal({
        id: 'engine-future-edit',
        workspace: projectState.workspace,
        prompt: 'Edit a future task.',
        provider: 'claude',
        now: 400,
      });
      const task = repository.createTask({
        id: 'engine-future-edit:task:1',
        goalId: 'engine-future-edit',
        title: 'Future task',
        objective: 'Original objective',
        acceptanceCriteria: ['The task is verified.'],
        verification: { checks: ['test'] },
        constraints: { noRemotePush: true },
        sequence: 1,
        tentative: true,
        now: 401,
      });
      repository.createRoadmapRevision({
        id: 'engine-future-edit:roadmap:1',
        goalId: 'engine-future-edit',
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
            snapshot: { title: task.title, objective: task.objective },
          },
        ],
        now: 402,
      });
      const result = engine.editFutureTaskContract('engine-future-edit', task.id, {
        reason: 'Clarify the objective.',
        patch: { objective: 'Clarified objective' },
        expectedRevision: 1,
        idempotencyKey: 'engine-future-edit-command',
      });
      expect(result.task.objective).toBe('Clarified objective');
      expect(result.goal.activeRevision).toBe(2);
      const replay = engine.editFutureTaskContract('engine-future-edit', task.id, {
        reason: 'Clarify the objective.',
        patch: { objective: 'Clarified objective' },
        expectedRevision: 1,
        idempotencyKey: 'engine-future-edit-command',
      });
      expect(replay.revision.id).toBe(result.revision.id);
      expect(repository.listOrchestratorCommands('engine-future-edit')).toHaveLength(1);
    });
  });

  it('keeps a Goal in NEEDS_HUMAN when a skipped Task leaves final coverage uncertain', async () => {
    await withEngine('PASS', async (engine, repository) => {
      repository.createGoal({
        id: 'engine-skip-guard',
        workspace: projectState.workspace,
        prompt: 'Require explicit review after a skip.',
        provider: 'claude',
        now: 410,
      });
      const task = repository.createTask({
        id: 'engine-skip-guard:task:1',
        goalId: 'engine-skip-guard',
        title: 'Optional task',
        objective: 'Optional coverage.',
        acceptanceCriteria: ['The optional task is reviewed.'],
        sequence: 1,
        tentative: true,
        now: 411,
      });
      repository.createRoadmapRevision({
        id: 'engine-skip-guard:roadmap:1',
        goalId: 'engine-skip-guard',
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
        now: 412,
      });
      const skipped = engine.skipFutureTask('engine-skip-guard', task.id, {
        reason: 'Defer optional coverage for human review.',
        expectedRevision: 1,
        idempotencyKey: 'engine-skip-guard-skip',
      });
      expect(skipped.task.status).toBe('SKIPPED');
      const result = await engine.runGoal('engine-skip-guard');
      expect(result.status).toBe('NEEDS_HUMAN');
      expect(result.lastVerification?.status).toBe('UNCERTAIN');
    });
  });

  it('pauses at NEEDS_HUMAN when verification is uncertain', async () => {
    await withEngine('UNCERTAIN', async (engine, repository) => {
      const result = await engine.createGoalAndRun({
        id: 'goal-uncertain',
        workspace: projectState.workspace,
        prompt: 'Need human review.',
        provider: 'claude',
      });
      expect(result.status).toBe('NEEDS_HUMAN');
      expect(repository.listTasks('goal-uncertain')).toMatchObject([{ status: 'NEEDS_HUMAN' }]);
    });
  });

  it('supports a persisted pause and explicit resume at a safe boundary', async () => {
    await withEngine('PASS', async (engine, repository) => {
      repository.createGoal({
        id: 'goal-pause',
        workspace: projectState.workspace,
        prompt: 'Pause before running.',
        provider: 'claude',
      });
      expect(engine.requestPause('goal-pause').status).toBe('PAUSED');
      const result = await engine.resumeGoal('goal-pause');
      expect(result.status).toBe('COMPLETED');
      expect(repository.getGoal('goal-pause').status).toBe('COMPLETED');
    });
  });

  it('applies pending instructions before Continue resumes a paused Goal', async () => {
    let workerPrompt = '';
    await withEngine(
      'PASS',
      async (engine, repository) => {
        repository.createGoal({
          id: 'goal-continue-instruction',
          workspace: projectState.workspace,
          prompt: 'Resume with boundary context.',
          provider: 'claude',
        });
        engine.requestPause('goal-continue-instruction');
        engine.submitInstruction(
          'goal-continue-instruction',
          { kind: 'priority', content: 'Keep deterministic checks first.' },
          { idempotencyKey: 'continue-instruction-1' },
        );
        const result = await engine.resumeGoal('goal-continue-instruction');
        expect(result.status).toBe('COMPLETED');
        expect(workerPrompt).toContain('Keep deterministic checks first.');
        expect(repository.listInstructions('goal-continue-instruction')).toMatchObject([
          { status: 'APPLIED' },
        ]);
      },
      'PASS',
      async () => context,
      undefined,
      (request) => {
        workerPrompt = request.prompt;
      },
    );
  });

  it('does not resume a NEEDS_HUMAN Goal while an instruction still needs approval', async () => {
    await withEngine('PASS', async (engine, repository) => {
      repository.createGoal({
        id: 'goal-continue-approval',
        workspace: projectState.workspace,
        prompt: 'Require approval before continuing.',
        provider: 'claude',
      });
      const task = repository.createTask({
        id: 'goal-continue-approval:task:1',
        goalId: 'goal-continue-approval',
        title: 'Human review task',
        objective: 'Wait for approval.',
        acceptanceCriteria: ['Approval is recorded.'],
        sequence: 1,
      });
      repository.transitionTask(task.id, 'NEEDS_HUMAN');
      repository.transitionGoal('goal-continue-approval', 'NEEDS_HUMAN');
      engine.submitInstruction(
        'goal-continue-approval',
        { kind: 'general', content: 'Deploy this change to production.' },
        { idempotencyKey: 'continue-approval-1' },
      );
      const result = await engine.resumeGoal('goal-continue-approval', {
        confirmExternalProcessStopped: true,
      });
      expect(result.status).toBe('NEEDS_HUMAN');
      expect(repository.getTask(task.id).status).toBe('NEEDS_HUMAN');
      expect(repository.listAttempts(task.id)).toHaveLength(0);
      expect(repository.listInstructions('goal-continue-approval')).toMatchObject([
        { status: 'NEEDS_APPROVAL' },
      ]);
    });
  });

  it('replays idempotent control commands without repeating their side effects', async () => {
    await withEngine('PASS', async (engine, repository) => {
      repository.createGoal({
        id: 'goal-idempotent-control',
        workspace: projectState.workspace,
        prompt: 'Exercise idempotent controls.',
        provider: 'claude',
      });
      const firstPause = engine.requestPause('goal-idempotent-control', {
        idempotencyKey: 'pause-command-1',
      });
      const replayedPause = engine.requestPause('goal-idempotent-control', {
        idempotencyKey: 'pause-command-1',
      });
      expect(replayedPause).toEqual(firstPause);
      expect(repository.listOrchestratorCommands('goal-idempotent-control')).toHaveLength(1);

      const firstResume = await engine.resumeGoal('goal-idempotent-control', {
        idempotencyKey: 'resume-command-1',
      });
      const replayedResume = await engine.resumeGoal('goal-idempotent-control', {
        idempotencyKey: 'resume-command-1',
      });
      expect(replayedResume).toMatchObject({ status: firstResume.status });
      expect(repository.listAttempts('goal-idempotent-control:task:1')).toHaveLength(1);
      expect(repository.listOrchestratorCommands('goal-idempotent-control')).toHaveLength(2);
    });
  });

  it('replays an idempotent start without creating a second Goal or Attempt', async () => {
    await withEngine('PASS', async (engine, repository) => {
      const input = {
        id: 'goal-idempotent-start',
        workspace: projectState.workspace,
        prompt: 'Start exactly once.',
        provider: 'claude',
      } as const;
      const first = await engine.createGoalAndRun(input, { idempotencyKey: 'start-command-1' });
      const replayed = await engine.createGoalAndRun(input, { idempotencyKey: 'start-command-1' });
      expect(replayed).toEqual(first);
      expect(repository.listGoals()).toHaveLength(1);
      expect(repository.listAttempts('goal-idempotent-start:task:1')).toHaveLength(1);
      expect(repository.listOrchestratorCommands('goal-idempotent-start')).toMatchObject([
        { commandKind: 'start', status: 'APPLIED', idempotencyKey: 'start-command-1' },
      ]);
    });
  });

  it('persists and replays a human instruction without duplicating its audit event', async () => {
    await withEngine('PASS', async (engine, repository) => {
      repository.createGoal({
        id: 'goal-instruction-submit',
        workspace: projectState.workspace,
        prompt: 'Accept a human instruction.',
        provider: 'claude',
      });
      const draft = {
        kind: 'priority' as const,
        content: 'Prioritize the deterministic test before polishing the UI.',
      };
      const first = engine.submitInstruction('goal-instruction-submit', draft, {
        idempotencyKey: 'instruction-1',
      });
      const replayed = engine.submitInstruction('goal-instruction-submit', draft, {
        idempotencyKey: 'instruction-1',
      });
      expect(replayed).toEqual(first);
      expect(repository.listInstructions('goal-instruction-submit')).toMatchObject([
        { kind: 'priority', status: 'PENDING', source: 'user' },
      ]);
      expect(
        repository
          .listEvents('goal-instruction-submit')
          .filter((event) => event.type === 'goal.instruction.received'),
      ).toHaveLength(1);
      expect(repository.listOrchestratorCommands('goal-instruction-submit')).toMatchObject([
        { commandKind: 'instruction', status: 'APPLIED' },
      ]);
    });
  });

  it('queues a running instruction and applies it only after the Attempt boundary', async () => {
    let activeEngine: OrchestratorEngine | undefined;
    const workerPrompts: string[] = [];
    await withEngine(
      (attempt) => (attempt === 1 ? 'FAIL' : 'PASS'),
      async (engine, repository) => {
        activeEngine = engine;
        const result = await engine.createGoalAndRun({
          id: 'goal-boundary-instruction',
          workspace: projectState.workspace,
          prompt: 'Apply a boundary instruction.',
          provider: 'claude',
        });
        expect(result.status).toBe('COMPLETED');
        expect(workerPrompts).toHaveLength(2);
        expect(workerPrompts[0]).not.toContain('Keep the next attempt deterministic.');
        expect(workerPrompts[1]).toContain('Applied instructions for this Task boundary');
        expect(workerPrompts[1]).toContain('Keep the next attempt deterministic.');
        expect(repository.listInstructions('goal-boundary-instruction')).toMatchObject([
          { status: 'APPLIED', appliedTaskId: 'goal-boundary-instruction:task:1' },
        ]);
        expect(repository.getGoal('goal-boundary-instruction').workingSet).toMatchObject({
          appliedInstructions: [
            { id: 'boundary-instruction-1', content: 'Keep the next attempt deterministic.' },
          ],
        });
        expect(
          repository
            .listEvents('goal-boundary-instruction')
            .filter((event) => event.type === 'goal.instruction.applied'),
        ).toHaveLength(1);
      },
      'PASS',
      async () => context,
      (engine) => {
        activeEngine = engine;
      },
      (request) => {
        workerPrompts.push(request.prompt);
        if (activeEngine !== undefined) {
          activeEngine.submitInstruction(
            'goal-boundary-instruction',
            {
              id: 'boundary-instruction-1',
              kind: 'constraint',
              content: 'Keep the next attempt deterministic.',
            },
            { idempotencyKey: 'boundary-instruction-command-1' },
          );
        }
      },
    );
  });

  it('blocks before starting a Worker when a pending instruction needs approval', async () => {
    await withEngine('PASS', async (engine, repository) => {
      repository.createGoal({
        id: 'goal-approval-instruction',
        workspace: projectState.workspace,
        prompt: 'Require approval before work.',
        provider: 'claude',
      });
      engine.submitInstruction(
        'goal-approval-instruction',
        { kind: 'general', content: 'Deploy this change to production.' },
        { idempotencyKey: 'approval-instruction-command-1' },
      );
      const result = await engine.runGoal('goal-approval-instruction');
      expect(result.status).toBe('NEEDS_HUMAN');
      expect(repository.listTasks('goal-approval-instruction')).toHaveLength(0);
      expect(repository.listInstructions('goal-approval-instruction')).toMatchObject([
        {
          status: 'NEEDS_APPROVAL',
          decisionReason: expect.stringContaining('requires explicit approval'),
        },
      ]);
    });
  });

  it('rejects a reused start key when the command payload changes', async () => {
    await withEngine('PASS', async (engine) => {
      const input = {
        id: 'goal-idempotent-start-conflict',
        workspace: projectState.workspace,
        prompt: 'Start exactly once.',
        provider: 'claude',
      } as const;
      await engine.createGoalAndRun(input, { idempotencyKey: 'start-command-conflict' });
      expect(() =>
        engine.createGoalAndRun(
          { ...input, prompt: 'Do something else.' },
          { idempotencyKey: 'start-command-conflict' },
        ),
      ).toThrow('different command input');
    });
  });

  it('completes a queued active pause command only after the safe boundary is applied', async () => {
    let activeEngine: OrchestratorEngine | undefined;
    await withEngine(
      'PASS',
      async (engine, repository) => {
        const result = await engine.createGoalAndRun({
          id: 'goal-active-pause-command',
          workspace: projectState.workspace,
          prompt: 'Pause at the next safe boundary.',
          provider: 'claude',
        });
        expect(result.status).toBe('PAUSED');
        expect(
          repository
            .listOrchestratorCommands('goal-active-pause-command')
            .find((command) => command.commandKind === 'pause'),
        ).toMatchObject({
          commandKind: 'pause',
          status: 'APPLIED',
          result: { goal: { status: 'PAUSED' } },
        });
      },
      'PASS',
      async () => {
        activeEngine?.requestPause('goal-active-pause-command', {
          idempotencyKey: 'active-pause-1',
        });
        return context;
      },
      (engine) => {
        activeEngine = engine;
      },
    );
  });

  it('requires stopped-process confirmation before resuming NEEDS_HUMAN recovery', async () => {
    await withEngine('PASS', async (engine, repository) => {
      repository.createGoal({
        id: 'goal-recovery-resume',
        workspace: projectState.workspace,
        prompt: 'Resume after a host restart.',
        provider: 'claude',
      });
      repository.transitionGoal('goal-recovery-resume', 'PLANNING', 10);
      repository.transitionGoal('goal-recovery-resume', 'NEEDS_HUMAN', 11);

      await expect(engine.resumeGoal('goal-recovery-resume')).rejects.toThrow(
        'requires confirmation that its external Provider process is stopped',
      );
      const result = await engine.resumeGoal('goal-recovery-resume', {
        confirmExternalProcessStopped: true,
      });
      expect(result.status).toBe('COMPLETED');
      expect(repository.listEvents('goal-recovery-resume').map((event) => event.type)).toContain(
        'goal.recovery.resumed',
      );
    });
  });

  it('runs an explicit retry as a new Attempt and preserves the prior evidence', async () => {
    await withEngine('UNCERTAIN', async (engine, repository) => {
      const initial = await engine.createGoalAndRun({
        id: 'goal-explicit-retry',
        workspace: projectState.workspace,
        prompt: 'Retry after uncertain verification.',
        provider: 'claude',
      });
      expect(initial.status).toBe('NEEDS_HUMAN');

      const result = await engine.retryTask('goal-explicit-retry', 'goal-explicit-retry:task:1', {
        confirmExternalProcessStopped: true,
        reason: 'The external process was inspected and is stopped.',
      });
      expect(result.retry).toMatchObject({
        attemptNumber: 2,
        reasonCode: 'verification_uncertain',
      });
      expect(repository.listAttempts('goal-explicit-retry:task:1')).toHaveLength(2);
      expect(repository.listEvents('goal-explicit-retry').map((event) => event.type)).toContain(
        'task.retry.requested',
      );
    });
  });

  it('does not resume an explicitly aborted Goal', async () => {
    await withEngine('PASS', async (engine, repository) => {
      repository.createGoal({
        id: 'goal-abort',
        workspace: projectState.workspace,
        prompt: 'Abort before running.',
        provider: 'claude',
      });
      expect(engine.requestAbort('goal-abort').status).toBe('ABORTED');
      await expect(engine.resumeGoal('goal-abort')).rejects.toThrow('Only a PAUSED Goal');
      expect(repository.getGoal('goal-abort').status).toBe('ABORTED');
    });
  });

  it('persists a Gap Task when final verification fails', async () => {
    await withEngine(
      'PASS',
      async (engine, repository) => {
        const result = await engine.createGoalAndRun({
          id: 'goal-final-gap',
          workspace: projectState.workspace,
          prompt: 'Detect a final verification gap.',
          provider: 'claude',
        });
        expect(result.status).toBe('NEEDS_HUMAN');
        expect(repository.listTasks('goal-final-gap')).toMatchObject([
          { id: 'goal-final-gap:task:1', status: 'COMPLETED' },
          { id: 'goal-final-gap:gap:2', status: 'PENDING' },
        ]);
        expect(repository.listEvents('goal-final-gap').map((event) => event.type)).toContain(
          'goal.gap_task.created',
        );
      },
      'FAIL',
    );
  });

  it('persists an intervention state when runtime setup fails', async () => {
    await withEngine(
      'PASS',
      async (engine, repository) => {
        await expect(
          engine.createGoalAndRun({
            id: 'goal-runtime-failure',
            workspace: projectState.workspace,
            prompt: 'The context provider will fail.',
            provider: 'claude',
          }),
        ).rejects.toThrow('context unavailable');
        expect(repository.getGoal('goal-runtime-failure').status).toBe('NEEDS_HUMAN');
        expect(repository.listEvents('goal-runtime-failure').map((event) => event.type)).toContain(
          'goal.run_failed',
        );
      },
      'PASS',
      async () => {
        throw new Error('context unavailable');
      },
    );
  });
});
