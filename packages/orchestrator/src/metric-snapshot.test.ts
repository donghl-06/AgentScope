import { describe, expect, it } from 'vitest';

import {
  DEFAULT_METRIC_SNAPSHOT_POLICY,
  metricSnapshotChanged,
  type MetricSnapshotCandidate,
} from './metric-snapshot.js';

const candidate = (overrides: Partial<MetricSnapshotCandidate> = {}): MetricSnapshotCandidate => ({
  goalId: 'goal-1',
  progress: 0.35,
  confidence: 0.4,
  reasons: [{ code: 'running', message: 'Task is running.' }],
  capturedAt: 1_000,
  ...overrides,
});

describe('metricSnapshotChanged', () => {
  it('persists the first snapshot and rejects identical snapshots inside the throttle window', () => {
    expect(metricSnapshotChanged(undefined, candidate())).toBe(true);
    const previous = { id: 'metric-1', ...candidate() };
    expect(metricSnapshotChanged(previous, candidate({ capturedAt: 1_001 }))).toBe(false);
  });

  it('detects progress, confidence, ETA, and reason changes', () => {
    const previous = {
      id: 'metric-1',
      ...candidate({ eta: { minSeconds: 30, maxSeconds: 60, sampleCount: 3 } }),
    };
    expect(metricSnapshotChanged(previous, candidate({ progress: 0.36 }))).toBe(true);
    expect(metricSnapshotChanged(previous, candidate({ confidence: 0.46 }))).toBe(true);
    expect(
      metricSnapshotChanged(
        previous,
        candidate({ eta: { minSeconds: 45, maxSeconds: 60, sampleCount: 3 } }),
      ),
    ).toBe(true);
    expect(
      metricSnapshotChanged(
        previous,
        candidate({ reasons: [{ code: 'waiting', message: 'Waiting for input.' }] }),
      ),
    ).toBe(true);
  });

  it('allows a bounded heartbeat when state is unchanged', () => {
    const previous = { id: 'metric-1', ...candidate() };
    expect(
      metricSnapshotChanged(
        previous,
        candidate({
          capturedAt: previous.capturedAt + DEFAULT_METRIC_SNAPSHOT_POLICY.minIntervalMs,
        }),
      ),
    ).toBe(true);
  });

  it('keeps Goal and Task scopes separate', () => {
    const previous = { id: 'metric-1', ...candidate({ taskId: 'task-1' }) };
    expect(metricSnapshotChanged(previous, candidate())).toBe(true);
  });
});
