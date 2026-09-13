import type { JsonObject, StoredGoalMetricSnapshot } from '@agentscope/storage';

/**
 * Controls when a new durable metric projection is worth writing.
 *
 * Metric snapshots are intentionally coarser than lifecycle events: a small
 * change is retained once it crosses the configured delta, while unchanged
 * state is sampled at a bounded interval so a long-running Goal remains
 * observable without creating an event storm.
 */
export interface MetricSnapshotPolicy {
  readonly minIntervalMs: number;
  readonly progressDelta: number;
  readonly confidenceDelta: number;
  readonly etaDeltaSeconds: number;
}

export const DEFAULT_METRIC_SNAPSHOT_POLICY: MetricSnapshotPolicy = {
  minIntervalMs: 5_000,
  progressDelta: 0.01,
  confidenceDelta: 0.05,
  etaDeltaSeconds: 15,
};

export interface MetricSnapshotCandidate {
  readonly goalId: string;
  readonly taskId?: string;
  readonly progress: number;
  readonly eta?: JsonObject;
  readonly confidence: number;
  readonly reasons: readonly JsonObject[];
  readonly capturedAt: number;
}

/**
 * Return true when a candidate should be persisted after the latest snapshot.
 * The caller is responsible for selecting the latest snapshot for the same
 * Goal/Task; the identity check below protects against accidental cross-scope
 * comparisons as an additional safety boundary.
 */
export function metricSnapshotChanged(
  previous: StoredGoalMetricSnapshot | undefined,
  next: MetricSnapshotCandidate,
  policy: MetricSnapshotPolicy = DEFAULT_METRIC_SNAPSHOT_POLICY,
): boolean {
  validatePolicy(policy);
  if (previous === undefined) return true;
  if (previous.goalId !== next.goalId || previous.taskId !== next.taskId) return true;

  const elapsedMs = Math.max(0, next.capturedAt - previous.capturedAt);
  if (elapsedMs >= policy.minIntervalMs) return true;
  if (Math.abs(previous.progress - next.progress) >= policy.progressDelta) return true;
  if (Math.abs(previous.confidence - next.confidence) >= policy.confidenceDelta) return true;
  if (etaChanged(previous.eta, next.eta, policy.etaDeltaSeconds)) return true;
  return reasonsChanged(previous.reasons, next.reasons);
}

function etaChanged(
  previous: JsonObject | undefined,
  next: JsonObject | undefined,
  deltaSeconds: number,
): boolean {
  if (previous === undefined || next === undefined) return previous !== next;
  for (const key of ['minSeconds', 'maxSeconds']) {
    const left = numericField(previous, key);
    const right = numericField(next, key);
    if (left === undefined || right === undefined) {
      if (left !== right) return true;
      continue;
    }
    if (Math.abs(left - right) >= deltaSeconds) return true;
  }
  for (const key of ['sampleCount', 'excludedOutlierCount', 'scope']) {
    if (previous[key] !== next[key]) return true;
  }
  return false;
}

function reasonsChanged(previous: readonly JsonObject[], next: readonly JsonObject[]): boolean {
  if (previous.length !== next.length) return true;
  for (let index = 0; index < next.length; index += 1) {
    if (JSON.stringify(previous[index]) !== JSON.stringify(next[index])) return true;
  }
  return false;
}

function numericField(value: JsonObject, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function validatePolicy(policy: MetricSnapshotPolicy): void {
  if (!Number.isFinite(policy.minIntervalMs) || policy.minIntervalMs < 0) {
    throw new RangeError('Metric snapshot minIntervalMs must be non-negative.');
  }
  if (!Number.isFinite(policy.progressDelta) || policy.progressDelta < 0) {
    throw new RangeError('Metric snapshot progressDelta must be non-negative.');
  }
  if (!Number.isFinite(policy.confidenceDelta) || policy.confidenceDelta < 0) {
    throw new RangeError('Metric snapshot confidenceDelta must be non-negative.');
  }
  if (!Number.isFinite(policy.etaDeltaSeconds) || policy.etaDeltaSeconds < 0) {
    throw new RangeError('Metric snapshot etaDeltaSeconds must be non-negative.');
  }
}
