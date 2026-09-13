import { describe, expect, it } from 'vitest';

import type { StoredGoal, StoredTask, StoredVerificationRun } from '@agentscope/storage';

import { estimateOrchestratorEta, projectGoalProgress, type EtaHistoryRecord } from './index.js';

const goalBase: Pick<StoredGoal, 'id' | 'workspace' | 'provider' | 'createdAt'> = {
  id: 'v1-calibration-goal',
  workspace: 'D:/workspace/calibration',
  provider: 'claude',
  createdAt: 0,
};

function goal(
  status: StoredGoal['status'] = 'RUNNING',
): Pick<StoredGoal, 'id' | 'status' | 'workspace' | 'provider' | 'createdAt'> {
  return { ...goalBase, status };
}

function task(status: StoredTask['status']): StoredTask {
  return {
    id: 'v1-calibration-task',
    goalId: goalBase.id,
    title: 'Calibration task',
    objective: 'Keep progress projection evidence-bounded.',
    acceptanceCriteria: ['The projection is deterministic.'],
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
  createdAt: number,
): StoredVerificationRun {
  return {
    id,
    taskId,
    attemptId: 'v1-calibration-attempt',
    status,
    criteria: [],
    deterministicChecks: [],
    evidence: [],
    reason: status,
    createdAt,
    updatedAt: createdAt,
  };
}

function history(durations: readonly number[]): readonly EtaHistoryRecord[] {
  return durations.map((durationSeconds) => ({
    durationSeconds,
    workspace: goalBase.workspace,
    provider: goalBase.provider,
    taskType: 'implementation',
    verificationProfile: 'deterministic',
    outcome: 'completed',
  }));
}

const activeProgress = {
  value: 0.5,
  confidence: 0.7,
  reasons: [{ code: 'synthetic_evidence', message: 'Synthetic calibration evidence.' }],
};

describe('V1 Progress/ETA calibration matrix', () => {
  it.each([
    {
      label: 'zero samples',
      history: undefined,
      expectedSamples: 0,
      reason: 'history_unavailable',
    },
    {
      label: 'two samples',
      history: history([90, 120]),
      expectedSamples: 2,
      reason: 'history_cold_start',
    },
    {
      label: 'ample samples',
      history: history([90, 100, 110, 120, 130, 140]),
      expectedSamples: 6,
      reason: 'history_baseline',
    },
  ])('keeps $label explicit and conservative', ({ history: samples, expectedSamples, reason }) => {
    const eta = estimateOrchestratorEta({
      goal: goal(),
      progress: activeProgress,
      now: 60_000,
      ...(samples === undefined ? {} : { history: samples }),
      taskType: 'implementation',
      verificationProfile: 'deterministic',
    });

    expect(eta.sampleCount).toBe(expectedSamples);
    expect(eta.minSeconds).toBeLessThanOrEqual(eta.maxSeconds);
    expect(eta.confidence).toBeGreaterThanOrEqual(0);
    expect(eta.confidence).toBeLessThanOrEqual(1);
    expect(eta.reasons.map((entry) => entry.code)).toContain(reason);
    if (expectedSamples < 3) expect(eta.confidence).toBeLessThanOrEqual(0.35);
    if (expectedSamples >= 3)
      expect(eta.reasons.map((entry) => entry.code)).toContain('history_range');
  });

  it('reduces confidence and refreshes the range when actual time exceeds historical p75', () => {
    const samples = history([90, 100, 110, 120, 130, 140]);
    const onTime = estimateOrchestratorEta({
      goal: goal(),
      progress: activeProgress,
      now: 100_000,
      history: samples,
      taskType: 'implementation',
      verificationProfile: 'deterministic',
    });
    const overdue = estimateOrchestratorEta({
      goal: goal(),
      progress: activeProgress,
      now: 200_000,
      history: samples,
      taskType: 'implementation',
      verificationProfile: 'deterministic',
    });

    expect(overdue.reasons.map((entry) => entry.code)).toContain('history_overrun');
    expect(overdue.confidence).toBeLessThan(onTime.confidence);
    expect(overdue.minSeconds).toBeLessThanOrEqual(overdue.maxSeconds);
  });

  it('promotes a small completed Task to 100% only after Goal final verification', () => {
    const taskState = task('COMPLETED');
    const result = projectGoalProgress({
      goal: goal('COMPLETED'),
      tasks: [taskState],
      verifications: [
        verification(`${taskState.id}:verification:1`, taskState.id, 'PASS', 10),
        verification(`${goalBase.id}:final-verification:1`, taskState.id, 'PASS', 20),
      ],
    });

    expect(result.value).toBe(1);
    expect(result.confidence).toBe(1);
    expect(result.verificationStatus).toBe('pass');
  });
});
