import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_STATUSES,
  GOAL_STATUSES,
  TASK_STATUSES,
  type StoredGoal,
  type StoredTask,
  type StoredVerificationRun,
} from '@agentscope/storage';

import {
  computeRetryBackoff,
  estimateOrchestratorEta,
  projectGoalProgress,
  projectTaskProgress,
  type EtaHistoryRecord,
} from './index.js';

const goalBase: Pick<StoredGoal, 'id' | 'workspace' | 'provider' | 'createdAt'> = {
  id: 'v1-invariant-goal',
  workspace: 'D:/workspace/invariants',
  provider: 'claude',
  createdAt: 0,
};

function task(status: StoredTask['status'], id = 'v1-invariant-task'): StoredTask {
  return {
    id,
    goalId: goalBase.id,
    title: id,
    objective: 'Keep the invariant test bounded.',
    acceptanceCriteria: ['The invariant remains true.'],
    verification: {},
    constraints: {},
    maxAttempts: 3,
    status,
    sequence: 1,
    tentative: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function verification(
  id: string,
  taskId: string,
  status: StoredVerificationRun['status'],
  createdAt = 2,
): StoredVerificationRun {
  return {
    id,
    taskId,
    attemptId: `${taskId}:attempt:1`,
    status,
    criteria: [],
    deterministicChecks: [],
    evidence: [],
    reason: status,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('V1 projection and failure invariants', () => {
  it.each(TASK_STATUSES)('keeps Task progress bounded for %s', (status) => {
    const projection = projectTaskProgress({ task: { id: 'task', status }, evidenceCount: -10 });
    expect(projection.value).toBeGreaterThanOrEqual(0);
    expect(projection.value).toBeLessThanOrEqual(1);
    expect(projection.confidence).toBeGreaterThanOrEqual(0);
    expect(projection.confidence).toBeLessThanOrEqual(1);
    expect(projection.evidenceCount).toBe(0);
    expect(new Set(projection.reasons.map((reason) => reason.code)).size).toBe(
      projection.reasons.length,
    );
    if (status === 'COMPLETED') expect(projection.value).toBe(1);
  });

  it.each(GOAL_STATUSES)('never overstates Goal progress while in %s', (status) => {
    const taskValue = task('COMPLETED');
    const finalVerification =
      status === 'COMPLETED'
        ? [verification(`${goalBase.id}:final-verification:1`, taskValue.id, 'PASS', 3)]
        : [];
    const projection = projectGoalProgress({
      goal: { id: goalBase.id, status },
      tasks: [taskValue],
      verifications: [
        verification(`${taskValue.id}:verification:1`, taskValue.id, 'PASS'),
        ...finalVerification,
      ],
    });
    expect(projection.value).toBeGreaterThanOrEqual(0);
    expect(projection.value).toBeLessThanOrEqual(1);
    expect(projection.confidence).toBeGreaterThanOrEqual(0);
    expect(projection.confidence).toBeLessThanOrEqual(1);
    expect(new Set(projection.reasons.map((reason) => reason.code)).size).toBe(
      projection.reasons.length,
    );
    if (status === 'COMPLETED') expect(projection.value).toBe(1);
    else expect(projection.value).toBeLessThan(1);
  });

  it('keeps retry backoff finite and monotonic across a range of attempts and jitter values', () => {
    const config = {
      baseDelayMs: 25,
      maxDelayMs: 200,
      maxTotalDelayMs: 500,
      jitterRatio: 0.25,
    };
    let cumulative = 0;
    for (let attemptNumber = 2; attemptNumber <= 20; attemptNumber += 1) {
      const decision = computeRetryBackoff(
        attemptNumber,
        { retryable: true },
        cumulative,
        config,
        (attemptNumber % 5) / 5,
      );
      expect(Number.isFinite(decision.delayMs)).toBe(true);
      expect(decision.delayMs).toBeGreaterThanOrEqual(0);
      expect(decision.cumulativeDelayMs).toBeGreaterThanOrEqual(cumulative);
      expect(decision.cumulativeDelayMs).toBeLessThanOrEqual(config.maxTotalDelayMs);
      cumulative = decision.cumulativeDelayMs;
      if (cumulative === config.maxTotalDelayMs) break;
    }
    expect(cumulative).toBe(config.maxTotalDelayMs);
    expect(computeRetryBackoff(2, { retryable: false }, cumulative)).toMatchObject({
      delayMs: 0,
      cumulativeDelayMs: cumulative,
    });
  });

  it('keeps ETA cold-start conservative and filters malformed history', () => {
    const history: readonly EtaHistoryRecord[] = [
      { ...goalBase, durationSeconds: Number.NaN, outcome: 'completed' },
      { ...goalBase, durationSeconds: 0, outcome: 'completed' },
      { ...goalBase, durationSeconds: 30, outcome: 'failed' },
      { ...goalBase, durationSeconds: 45, outcome: 'completed' },
    ];
    const eta = estimateOrchestratorEta({
      goal: { ...goalBase, status: 'RUNNING' },
      progress: { value: 0.25, confidence: 0.2, reasons: [] },
      now: 10_000,
      history,
    });
    expect(eta.sampleCount).toBe(1);
    expect(eta.confidence).toBeLessThanOrEqual(0.35);
    expect(eta.minSeconds).toBeLessThanOrEqual(eta.maxSeconds);
    expect(eta.reasons.map((reason) => reason.code)).toContain('history_cold_start');
  });

  it('keeps status vocabularies explicit so unknown persisted states cannot enter projections', () => {
    expect(new Set(GOAL_STATUSES).size).toBe(GOAL_STATUSES.length);
    expect(new Set(TASK_STATUSES).size).toBe(TASK_STATUSES.length);
    expect(new Set(ATTEMPT_STATUSES).size).toBe(ATTEMPT_STATUSES.length);
    expect(GOAL_STATUSES).toContain('NEEDS_HUMAN');
    expect(TASK_STATUSES).toContain('REPAIRING');
    expect(ATTEMPT_STATUSES).toContain('INTERRUPTED');
  });
});
