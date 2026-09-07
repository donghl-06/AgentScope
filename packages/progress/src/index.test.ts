import { describe, expect, it } from 'vitest';

import { createInitialSessionState, type SessionState } from '@agentscope/protocol';

import { computeProgress } from './index.js';

function state(overrides: Partial<SessionState> = {}): SessionState {
  return { ...createInitialSessionState('session-1', 0), ...overrides };
}

describe('progress engine', () => {
  it('keeps low-signal implementation below full completion', () => {
    const result = computeProgress({
      state: state({ currentActivity: { kind: 'implementation', label: 'editing', startedAt: 1 } }),
    });
    expect(result.value).toBeLessThan(1);
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.reasons.map((reason) => reason.code)).toContain('low_signal');
    expect(result.reasons.map((reason) => reason.code)).toContain('implicit_phase');
    expect(result.reasons.map((reason) => reason.code)).toContain('milestone_missing');
  });

  it('reports verified completion as 100%', () => {
    const result = computeProgress({
      state: state({
        status: 'completed',
        endedAt: 100,
        verification: { tests: 'passed', build: 'passed', typecheck: 'passed', overall: 'passed' },
      }),
      capabilities: { structuredEvents: true, commandEvents: true },
    });
    expect(result.value).toBe(1);
    expect(result.reasons.map((reason) => reason.code)).toContain('verified_completion');
  });

  it('projects an unverified interactive completion to the guarded completion cap', () => {
    const result = computeProgress({
      state: state({
        status: 'completed',
        endedAt: 100,
        currentActivity: { kind: 'implementation', label: 'task completed', startedAt: 90 },
      }),
      capabilities: { fileEvents: true },
    });
    expect(result.value).toBe(0.6);
    expect(result.reasons.map((reason) => reason.code)).toContain('interactive_completion');
    expect(result.reasons.map((reason) => reason.code)).toContain('completion_unverified');
  });

  it('caps blocked and failed sessions and preserves deterministic reasons', () => {
    const blocked = computeProgress({
      state: state({
        status: 'blocked',
        currentActivity: { kind: 'implementation', label: 'waiting', startedAt: 1 },
      }),
    });
    const failed = computeProgress({
      state: state({
        status: 'failed',
        endedAt: 100,
        verification: {
          tests: 'failed',
          build: 'unknown',
          typecheck: 'unknown',
          overall: 'failed',
        },
      }),
    });
    expect(blocked.value).toBeLessThanOrEqual(0.5);
    expect(failed.value).toBeLessThanOrEqual(0.6);
    expect(failed.reasons.map((reason) => reason.code)).toContain('verification_failed');
  });

  it('supports projects that explicitly require only the validations they use', () => {
    const result = computeProgress({
      state: state({
        status: 'completed',
        endedAt: 100,
        verification: {
          tests: 'passed',
          build: 'unknown',
          typecheck: 'unknown',
          overall: 'pending',
        },
      }),
      config: { requiredVerification: ['tests'] },
      capabilities: { structuredEvents: true, commandEvents: true },
    });

    expect(result.value).toBe(1);
    expect(result.reasons.map((reason) => reason.code)).toContain('verified_completion');
    expect(result.reasons.map((reason) => reason.code)).not.toContain('verification_pending');
  });

  it('keeps explicit no-verification projects below full confidence', () => {
    const result = computeProgress({
      state: state({ status: 'completed', endedAt: 100 }),
      config: { requiredVerification: [] },
    });
    expect(result.value).toBeLessThanOrEqual(0.6);
    expect(result.reasons.map((reason) => reason.code)).toContain('completion_unverified');
  });

  it('covers the basic success path only as fully complete after required verification', () => {
    const result = computeProgress({
      state: state({
        status: 'completed',
        endedAt: 500,
        milestones: [
          { id: 'plan', title: 'Plan', status: 'completed' },
          { id: 'implementation', title: 'Implementation', status: 'completed' },
        ],
        verification: { tests: 'passed', build: 'passed', typecheck: 'passed', overall: 'passed' },
      }),
      capabilities: { structuredEvents: true, commandEvents: true, milestones: true },
    });
    expect(result.value).toBe(1);
  });

  it('keeps implementation-only work below the implementation ceiling', () => {
    const result = computeProgress({
      state: state({ currentActivity: { kind: 'implementation', label: 'editing', startedAt: 1 } }),
      capabilities: { structuredEvents: true, toolCalls: true },
    });
    expect(result.value).toBeLessThanOrEqual(0.5);
  });

  it('stalls failed verification and allows progress after unblocking', () => {
    const failed = computeProgress({
      state: state({
        currentActivity: { kind: 'test', label: 'unit', startedAt: 1 },
        verification: {
          tests: 'failed',
          build: 'unknown',
          typecheck: 'unknown',
          overall: 'failed',
        },
      }),
    });
    const blocked = computeProgress({
      state: state({
        status: 'blocked',
        currentActivity: { kind: 'blocked', label: 'waiting', startedAt: 1 },
      }),
    });
    const resumed = computeProgress({
      state: state({
        status: 'running',
        currentActivity: { kind: 'implementation', label: 'resumed', startedAt: 2 },
      }),
    });
    expect(failed.value).toBeLessThanOrEqual(0.6);
    expect(failed.reasons.map((reason) => reason.code)).toContain('verification_failed');
    expect(blocked.value).toBeLessThanOrEqual(0.5);
    expect(resumed.value).toBeGreaterThanOrEqual(blocked.value);
    expect(resumed.reasons.map((reason) => reason.code)).not.toContain('blocked_cap');
  });

  it('naturally rolls back the ratio when a new milestone expands scope', () => {
    const before = computeProgress({
      state: state({
        milestones: [{ id: 'm1', title: 'Initial scope', status: 'completed' }],
      }),
    });
    const after = computeProgress({
      state: state({
        milestones: [
          { id: 'm1', title: 'Initial scope', status: 'completed' },
          { id: 'm2', title: 'Expanded scope', status: 'pending' },
        ],
      }),
    });
    expect(after.value).toBeLessThan(before.value);
  });

  it('normalizes explicit milestone weights and rejects invalid entries as a group', () => {
    const weighted = computeProgress({
      state: state({
        milestones: [
          { id: 'small', title: 'Small', status: 'completed' },
          { id: 'large', title: 'Large', status: 'pending' },
        ],
      }),
      config: { milestoneWeights: { small: 1, large: 3 } },
    });
    expect(weighted.value).toBeCloseTo(0.25);
    expect(weighted.reasons.map((reason) => reason.code)).toContain('weighted_milestones');

    const invalid = computeProgress({
      state: state({
        milestones: [
          { id: 'small', title: 'Small', status: 'completed' },
          { id: 'large', title: 'Large', status: 'pending' },
        ],
      }),
      config: { milestoneWeights: { small: -1, unknown: 2 } },
    });
    expect(invalid.value).toBeCloseTo(0.5);
    expect(invalid.reasons.map((reason) => reason.code)).toContain('invalid_milestone_weights');
  });

  it('is deterministic for the same replayed state and configuration', () => {
    const input = {
      state: state({ currentActivity: { kind: 'review', label: 'review', startedAt: 10 } }),
      capabilities: { structuredEvents: true, milestones: false },
      now: 20,
      lastSignalAt: 10,
    };
    expect(computeProgress(input)).toEqual(computeProgress(input));
  });
});
