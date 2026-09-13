import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import {
  OrchestratorEngine,
  SerialWorkerRuntime,
  type BootstrapContext,
  type InitialPlan,
  type Planner,
  type ProjectState,
  type RollingPlan,
  type WorkingSet,
} from '../../packages/orchestrator/src/index.js';
import {
  openStorage,
  OrchestratorRepository,
  type StoredGoal,
} from '../../packages/storage/src/index.js';

const GOAL_COUNT = 180;
const TASKS_PER_GOAL = 4;
const EVENTS_PER_TASK = 6;
const PAGE_SIZE = 25;
const BROADCAST_EVENT_COUNT = 200;

describe('V1 orchestrator performance baseline', () => {
  it('keeps history pagination, detail reads, notifications, and resource use bounded', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-v1-performance-'));
    const filename = path.join(directory, 'performance.db');
    const { client } = openStorage({ filename, migrate: true });
    const repository = new OrchestratorRepository(client);
    const cpuStarted = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;
    const seedStarted = performance.now();
    const goalIds: string[] = [];

    try {
      for (let goalIndex = 0; goalIndex < GOAL_COUNT; goalIndex += 1) {
        const goalId = `perf-goal-${String(goalIndex).padStart(4, '0')}`;
        goalIds.push(goalId);
        const now = 1_000 + goalIndex;
        repository.createGoal({
          id: goalId,
          workspace: 'D:/workspace/performance',
          prompt: `Synthetic performance Goal ${goalIndex}.`,
          provider: goalIndex % 2 === 0 ? 'claude' : 'codex',
          now,
        });
        for (let taskIndex = 0; taskIndex < TASKS_PER_GOAL; taskIndex += 1) {
          const taskId = `${goalId}:task:${taskIndex + 1}`;
          repository.createTask({
            id: taskId,
            goalId,
            title: `Synthetic Task ${taskIndex + 1}`,
            objective: 'Exercise bounded history reads.',
            acceptanceCriteria: ['The synthetic event remains queryable.'],
            sequence: taskIndex + 1,
            tentative: taskIndex > 0,
            now: now + taskIndex,
          });
          for (let eventIndex = 0; eventIndex < EVENTS_PER_TASK; eventIndex += 1) {
            repository.appendEvent({
              id: `${taskId}:event:${eventIndex + 1}`,
              goalId,
              taskId,
              type: eventIndex % 2 === 0 ? 'task.progress' : 'task.evidence',
              payload: { eventIndex, synthetic: true },
              confidence: 0.9,
              timestamp: now + taskIndex * 10 + eventIndex,
            });
          }
        }
      }

      const seedElapsedMs = Math.round(performance.now() - seedStarted);
      const pageLatencies: number[] = [];
      let cursor: string | undefined;
      let pagedGoalCount = 0;
      let pageCount = 0;
      do {
        const started = performance.now();
        const page = repository.listGoalPage({
          limit: PAGE_SIZE,
          includeArchived: false,
          ...(cursor === undefined ? {} : { cursor }),
        });
        pageLatencies.push(performance.now() - started);
        pageCount += 1;
        pagedGoalCount += page.items.length;
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      const detailLatencies: number[] = [];
      let detailEventCount = 0;
      for (const goalId of goalIds.slice(0, 40)) {
        const started = performance.now();
        const loadedGoal = repository.getGoal(goalId);
        const tasks = repository.listTasks(loadedGoal.id);
        const events = repository.listEvents(loadedGoal.id, 0, 500);
        detailLatencies.push(performance.now() - started);
        expect(tasks).toHaveLength(TASKS_PER_GOAL);
        expect(events).toHaveLength(TASKS_PER_GOAL * EVENTS_PER_TASK);
        detailEventCount += events.length;
      }

      let notificationCount = 0;
      const unsubscribe = repository.subscribe((notification) => {
        if (notification.type === 'event.appended') notificationCount += 1;
      });
      const broadcastStarted = performance.now();
      try {
        const goalId = goalIds[0]!;
        for (let index = 0; index < BROADCAST_EVENT_COUNT; index += 1) {
          repository.appendEvent({
            id: `${goalId}:broadcast:${index}`,
            goalId,
            type: 'synthetic.broadcast',
            payload: { index },
            confidence: 1,
            timestamp: 10_000 + index,
          });
        }
      } finally {
        unsubscribe();
      }
      const broadcastElapsedMs = Math.round(performance.now() - broadcastStarted);
      const cpu = process.cpuUsage(cpuStarted);
      const rssAfter = process.memoryUsage().rss;
      const databaseBytes = [filename, `${filename}-wal`, `${filename}-shm`].reduce(
        (total, candidate) =>
          fs.existsSync(candidate) ? total + fs.statSync(candidate).size : total,
        0,
      );
      const baseline = {
        seedElapsedMs,
        goals: pagedGoalCount,
        tasks: GOAL_COUNT * TASKS_PER_GOAL,
        events: GOAL_COUNT * TASKS_PER_GOAL * EVENTS_PER_TASK + BROADCAST_EVENT_COUNT,
        pageCount,
        pageLatencyMs: percentileSummary(pageLatencies),
        detailCount: detailLatencies.length,
        detailEventCount,
        detailLatencyMs: percentileSummary(detailLatencies),
        broadcastEventCount: BROADCAST_EVENT_COUNT,
        notificationCount,
        broadcastElapsedMs,
        databaseBytes,
        rssDeltaBytes: rssAfter - rssBefore,
        cpuMs: { user: Math.round(cpu.user / 1_000), system: Math.round(cpu.system / 1_000) },
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      };
      console.log(`V1 performance baseline: ${JSON.stringify(baseline)}`);

      expect(pagedGoalCount).toBe(GOAL_COUNT);
      expect(pageCount).toBe(Math.ceil(GOAL_COUNT / PAGE_SIZE));
      expect(pageLatencies.every(Number.isFinite)).toBe(true);
      expect(detailLatencies.every(Number.isFinite)).toBe(true);
      expect(notificationCount).toBe(BROADCAST_EVENT_COUNT);
      expect(databaseBytes).toBeGreaterThan(0);
      // Broad safety ceilings keep this as a regression guard without making
      // the test a machine-specific performance promise.
      expect(percentileSummary(pageLatencies).p95).toBeLessThan(2_000);
      expect(percentileSummary(detailLatencies).p95).toBeLessThan(2_000);
    } finally {
      client.close();
      removeTemporaryDirectory(filename, directory);
    }
  }, 60_000);

  it('keeps a serial mock Goal soak terminal and releases engine state', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-v1-soak-'));
    const filename = path.join(directory, 'soak.db');
    const { client } = openStorage({ filename, migrate: true });
    const repository = new OrchestratorRepository(client);
    const workspace = path.join(directory, 'workspace');
    fs.mkdirSync(workspace);
    const worker = new SerialWorkerRuntime({
      launch: async (request) => ({
        attemptId: request.attemptId,
        status: 'completed' as const,
        exitCode: 0,
        summary: 'Serial synthetic worker completed.',
        changedFiles: [],
        reportedVerification: {},
      }),
    });
    const engine = new OrchestratorEngine({
      repository,
      planner: serialSoakPlanner(),
      contextProvider: async ({ workspace: requestedWorkspace }) =>
        serialSoakContext(requestedWorkspace),
      worker,
      verifyTask: async () => ({
        status: 'PASS' as const,
        criteria: [
          { criterion: 'Synthetic task completed.', status: 'PASS' as const, reason: 'soak' },
        ],
        deterministicChecks: [],
        evidence: [{ kind: 'synthetic-soak' }],
        reason: 'Synthetic verification passed.',
      }),
      verifyGoal: async () => ({
        status: 'PASS' as const,
        criteria: [
          { criterion: 'Synthetic Goal completed.', status: 'PASS' as const, reason: 'soak' },
        ],
        deterministicChecks: [],
        evidence: [{ kind: 'synthetic-final' }],
        reason: 'Synthetic final verification passed.',
      }),
    });
    const cycleCount = 120;
    const started = performance.now();

    try {
      for (let index = 0; index < cycleCount; index += 1) {
        const result = await engine.createGoalAndRun({
          id: `soak-goal-${String(index).padStart(4, '0')}`,
          workspace,
          prompt: 'Read one deterministic synthetic Goal without changing files.',
          provider: 'claude',
        });
        expect(result.status).toBe('COMPLETED');
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0]?.status).toBe('COMPLETED');
      }
      const elapsedMs = Math.round(performance.now() - started);
      const goals: StoredGoal[] = [];
      let goalCursor: string | undefined;
      do {
        const page = repository.listGoalPage({
          limit: 100,
          includeArchived: true,
          ...(goalCursor === undefined ? {} : { cursor: goalCursor }),
        });
        goals.push(...page.items);
        goalCursor = page.nextCursor;
      } while (goalCursor !== undefined);
      const unfinished = goals.filter((goal) => goal.status !== 'COMPLETED');
      const taskCount = goals.reduce(
        (total, goal) => total + repository.listTasks(goal.id).length,
        0,
      );
      const eventCount = goals.reduce(
        (total, goal) => total + repository.listEvents(goal.id).length,
        0,
      );
      console.log(
        `V1 serial mock soak: ${JSON.stringify({
          cycles: cycleCount,
          elapsedMs,
          goals: goals.length,
          unfinishedGoals: unfinished.length,
          tasks: taskCount,
          events: eventCount,
        })}`,
      );
      expect(goals).toHaveLength(cycleCount);
      expect(unfinished).toHaveLength(0);
      expect(taskCount).toBe(cycleCount);
      expect(eventCount).toBeGreaterThan(cycleCount);
      expect(engine.active).toBe(false);
      expect(worker.active).toBe(false);
    } finally {
      engine.dispose();
      client.close();
      removeTemporaryDirectory(filename, directory);
    }
  }, 60_000);
});

function serialSoakContext(workspace: string): BootstrapContext {
  const projectState: ProjectState = {
    workspace,
    capturedAt: 1,
    git: {
      rootPath: workspace,
      isRepository: false,
      files: [],
      trackedFiles: [],
      diffStat: [],
      capturedAt: 1,
      reason: 'Synthetic performance workspace.',
    },
    packageManager: 'unknown',
    manifests: [],
    techStack: ['Node.js'],
    topLevelDirectories: [],
    discoverableVerification: [],
    recentCommits: [],
    relevantFiles: [],
  };
  const workingSet: WorkingSet = {
    files: [],
    directories: [],
    rationale: 'Synthetic performance working set.',
    updatedAt: 1,
  };
  return {
    projectState,
    workingSet,
    executionMemory: {
      decisions: [],
      completedTaskIds: [],
      failedApproaches: [],
      notes: [],
    },
  };
}

function serialSoakPlanner(): Planner {
  return {
    planInitial(input): InitialPlan {
      const task = {
        id: `${input.goal.id}:task:1`,
        title: 'Synthetic serial task',
        objective: 'Read synthetic state without changing files.',
        acceptanceCriteria: ['The synthetic task is verified.'],
        verification: {},
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
        rationale: 'Synthetic serial performance plan.',
      };
    },
    planRolling(input): RollingPlan {
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
          rationale: 'Synthetic task is ready to run.',
        };
      }
      return {
        goalId: input.goal.id,
        action: 'GOAL_READY_FOR_FINAL_VERIFICATION',
        rationale: input.tasks.every((task) => task.status === 'COMPLETED')
          ? 'Synthetic task is terminal.'
          : 'Synthetic planner remains conservative.',
      };
    },
  };
}

function percentileSummary(values: readonly number[]): {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly samples: number;
} {
  const ordered = [...values].sort((left, right) => left - right);
  return {
    p50: Math.round(percentile(ordered, 0.5)),
    p95: Math.round(percentile(ordered, 0.95)),
    max: Math.round(ordered.at(-1) ?? 0),
    samples: ordered.length,
  };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1);
  return values[index] ?? 0;
}

function removeTemporaryDirectory(filename: string, directory: string): void {
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    try {
      fs.rmSync(candidate, { force: true });
    } catch {
      // Best effort; the directory removal below is the final cleanup attempt.
    }
  }
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Windows may release a SQLite handle just after the test closes it.
  }
}
