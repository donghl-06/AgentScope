import { estimateEta, type EtaHistory } from '@agentscope/eta';
import type { StoredGoal } from '@agentscope/storage';

import type { GoalProgressValue } from './goal-progress.js';

export interface EtaHistoryRecord {
  readonly durationSeconds: number;
  readonly workspace: string;
  readonly provider: string;
  readonly taskType?: string;
  readonly verificationProfile?: string;
  readonly outcome?: 'completed' | 'failed' | 'aborted';
}

export interface OrchestratorEtaInput {
  readonly goal: Pick<StoredGoal, 'id' | 'status' | 'workspace' | 'provider' | 'createdAt'>;
  readonly progress: GoalProgressValue;
  readonly now: number;
  readonly history?: readonly EtaHistoryRecord[];
  readonly taskType?: string;
  readonly verificationProfile?: string;
  readonly replanningDetected?: boolean;
}

export interface OrchestratorEtaSnapshot {
  readonly minSeconds: number;
  readonly maxSeconds: number;
  readonly confidence: number;
  readonly reasons: readonly { readonly code: string; readonly message: string }[];
  readonly sampleCount: number;
  readonly excludedOutlierCount: number;
  readonly scope?: string;
}

/**
 * Estimate remaining Goal time with a deliberately conservative local baseline.
 * Failed/aborted runs and incomparable Provider/workspace profiles never enter
 * the baseline, and a small sample remains explicitly low confidence.
 */
export function estimateOrchestratorEta(input: OrchestratorEtaInput): OrchestratorEtaSnapshot {
  const scope = historyScope(input);
  const comparable = selectComparableHistory(input);
  const history: EtaHistory | undefined =
    comparable.durations.length === 0
      ? undefined
      : scope === undefined
        ? { durationsSeconds: comparable.durations }
        : { durationsSeconds: comparable.durations, scope };
  const elapsedSeconds = Math.max(0, (input.now - input.goal.createdAt) / 1_000);
  const state: Parameters<typeof estimateEta>[0]['state'] = {
    sessionId: input.goal.id,
    status: sessionStatus(input.goal.status),
    startedAt: input.goal.createdAt,
    milestones: [],
    progress: {
      value: input.progress.value,
      confidence: input.progress.confidence,
      reasons: input.progress.reasons,
    },
    verification: verificationState(input.progress),
  };
  const eta = estimateEta({
    state,
    progress: state.progress,
    elapsedSeconds,
    ...(input.replanningDetected === undefined
      ? {}
      : { replanningDetected: input.replanningDetected }),
    ...(history === undefined ? {} : { history }),
  });
  const reasons = [...eta.reasons];
  if (input.history === undefined) {
    reasons.push({
      code: 'history_unavailable',
      message: 'No completed comparable Goal history is available for ETA calibration.',
    });
  } else if (comparable.durations.length < 3) {
    reasons.push({
      code: 'history_cold_start',
      message: `Only ${comparable.durations.length} comparable completed sample(s) are available; ETA remains low confidence.`,
    });
  }
  if (comparable.excludedOutlierCount > 0) {
    reasons.push({
      code: 'history_outliers_excluded',
      message: `${comparable.excludedOutlierCount} unusually long historical run(s) were excluded from the baseline.`,
    });
  }
  const confidence = isTerminalGoal(input.goal.status)
    ? eta.confidence
    : comparable.durations.length < 3
      ? Math.min(0.35, eta.confidence)
      : eta.confidence;
  return {
    minSeconds: eta.minSeconds,
    maxSeconds: eta.maxSeconds,
    confidence,
    reasons: dedupeReasons(reasons),
    sampleCount: comparable.durations.length,
    excludedOutlierCount: comparable.excludedOutlierCount,
    ...(scope === undefined ? {} : { scope }),
  };
}

function isTerminalGoal(status: StoredGoal['status']): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'ABORTED';
}

function selectComparableHistory(input: OrchestratorEtaInput): {
  readonly durations: readonly number[];
  readonly excludedOutlierCount: number;
} {
  if (input.history === undefined) return { durations: [], excludedOutlierCount: 0 };
  const candidates = input.history.filter((record) => {
    if (!Number.isFinite(record.durationSeconds) || record.durationSeconds <= 0) return false;
    if (record.outcome !== undefined && record.outcome !== 'completed') return false;
    return (
      record.workspace === input.goal.workspace &&
      record.provider === input.goal.provider &&
      matchesOptional(record.taskType, input.taskType) &&
      matchesOptional(record.verificationProfile, input.verificationProfile)
    );
  });
  const durations = candidates
    .map((record) => record.durationSeconds)
    .sort((left, right) => left - right);
  if (durations.length < 3) return { durations, excludedOutlierCount: 0 };
  const median = percentile(durations, 0.5);
  const upperBound = Math.max(median * 4, percentile(durations, 0.75) * 2);
  const filtered = durations.filter((duration) => duration <= upperBound);
  return {
    durations: filtered,
    excludedOutlierCount: durations.length - filtered.length,
  };
}

function matchesOptional(value: string | undefined, expected: string | undefined): boolean {
  return value === undefined || expected === undefined || value === expected;
}

function historyScope(input: OrchestratorEtaInput): string | undefined {
  if (input.history === undefined) return undefined;
  return [
    input.goal.workspace,
    input.goal.provider,
    input.taskType ?? '*',
    input.verificationProfile ?? '*',
  ].join('|');
}

function sessionStatus(
  status: StoredGoal['status'],
): Parameters<typeof estimateEta>[0]['state']['status'] {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'ABORTED':
      return 'interrupted';
    case 'PAUSED':
    case 'NEEDS_HUMAN':
      return 'blocked';
    case 'CREATED':
    case 'PLANNING':
    case 'RUNNING':
    case 'VERIFYING':
      return 'running';
  }
}

function verificationState(
  progress: GoalProgressValue,
): Parameters<typeof estimateEta>[0]['state']['verification'] {
  const codes = new Set(progress.reasons.map((reason) => reason.code));
  if (codes.has('final_verification_passed') || codes.has('goal_final_verification_passed')) {
    return { tests: 'passed', build: 'passed', typecheck: 'passed', overall: 'passed' };
  }
  if (codes.has('final_verification_failed')) {
    return { tests: 'failed', build: 'unknown', typecheck: 'unknown', overall: 'failed' };
  }
  if (codes.has('final_verification_uncertain')) {
    return { tests: 'unknown', build: 'unknown', typecheck: 'unknown', overall: 'unknown' };
  }
  return { tests: 'unknown', build: 'unknown', typecheck: 'unknown', overall: 'pending' };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const index = (values.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower] ?? 0;
  const lowerValue = values[lower] ?? 0;
  const upperValue = values[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function dedupeReasons(
  reasons: readonly { readonly code: string; readonly message: string }[],
): readonly { readonly code: string; readonly message: string }[] {
  return [...new Map(reasons.map((reason) => [reason.code, reason])).values()];
}
