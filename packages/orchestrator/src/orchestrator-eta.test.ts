import { describe, expect, it } from 'vitest';

import type { StoredGoal } from '@agentscope/storage';

import { estimateOrchestratorEta, type EtaHistoryRecord } from './orchestrator-eta.js';

function goal(
  status: StoredGoal['status'] = 'RUNNING',
): Pick<StoredGoal, 'id' | 'status' | 'workspace' | 'provider' | 'createdAt'> {
  return {
    id: 'goal-eta',
    status,
    workspace: 'D:/workspace',
    provider: 'claude',
    createdAt: 0,
  };
}

const progress = {
  value: 0.5,
  confidence: 0.7,
  reasons: [{ code: 'task_evidence_observed', message: 'Evidence observed.' }],
};

function history(durations: readonly number[]): readonly EtaHistoryRecord[] {
  return durations.map((durationSeconds) => ({
    durationSeconds,
    workspace: 'D:/workspace',
    provider: 'claude',
    taskType: 'implementation',
    verificationProfile: 'deterministic',
    outcome: 'completed',
  }));
}

describe('Orchestrator ETA', () => {
  it('returns an explicit cold-start range with no history', () => {
    const eta = estimateOrchestratorEta({ goal: goal(), progress, now: 60_000 });

    expect(eta.sampleCount).toBe(0);
    expect(eta.confidence).toBeLessThan(0.5);
    expect(eta.minSeconds).toBeLessThanOrEqual(eta.maxSeconds);
    expect(eta.reasons.map((reason) => reason.code)).toContain('history_unavailable');
  });

  it('keeps one or two samples low confidence', () => {
    const eta = estimateOrchestratorEta({
      goal: goal(),
      progress,
      now: 60_000,
      history: history([90, 120]),
      taskType: 'implementation',
      verificationProfile: 'deterministic',
    });

    expect(eta.sampleCount).toBe(2);
    expect(eta.reasons.map((reason) => reason.code)).toContain('history_cold_start');
    expect(eta.reasons.map((reason) => reason.code)).not.toContain('history_baseline');
  });

  it('uses only comparable completed history and isolates an extreme outlier', () => {
    const records = [
      ...history([90, 100, 110, 120, 1_000]),
      {
        durationSeconds: 80,
        workspace: 'D:/workspace',
        provider: 'codex',
        outcome: 'completed' as const,
      },
      {
        durationSeconds: 70,
        workspace: 'D:/workspace',
        provider: 'claude',
        outcome: 'failed' as const,
      },
    ];
    const eta = estimateOrchestratorEta({
      goal: goal(),
      progress,
      now: 60_000,
      history: records,
      taskType: 'implementation',
      verificationProfile: 'deterministic',
    });

    expect(eta.sampleCount).toBe(4);
    expect(eta.excludedOutlierCount).toBe(1);
    expect(eta.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['history_baseline', 'history_outliers_excluded']),
    );
  });

  it('does not estimate remaining time for terminal Goals', () => {
    const eta = estimateOrchestratorEta({
      goal: goal('COMPLETED'),
      progress: { value: 1, confidence: 1, reasons: [] },
      now: 60_000,
      history: history([90, 100, 110]),
      taskType: 'implementation',
      verificationProfile: 'deterministic',
    });

    expect(eta).toMatchObject({ minSeconds: 0, maxSeconds: 0, confidence: 1, sampleCount: 3 });
    expect(eta.reasons.map((reason) => reason.code)).toContain('terminal');
  });

  it('widens a blocked or replanned Goal and keeps the scope explicit', () => {
    const normal = estimateOrchestratorEta({
      goal: goal(),
      progress,
      now: 60_000,
      history: history([90, 100, 110]),
      taskType: 'implementation',
      verificationProfile: 'deterministic',
    });
    const blocked = estimateOrchestratorEta({
      goal: goal('NEEDS_HUMAN'),
      progress,
      now: 60_000,
      history: history([90, 100, 110]),
      taskType: 'implementation',
      verificationProfile: 'deterministic',
      replanningDetected: true,
    });

    expect(blocked.maxSeconds).toBeGreaterThan(normal.maxSeconds);
    expect(blocked.scope).toContain('claude');
    expect(blocked.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['blocked_penalty', 'replanning_penalty']),
    );
  });
});
