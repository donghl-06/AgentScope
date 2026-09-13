import { describe, expect, it } from 'vitest';

import { evaluateBudget, resolveBudgetPolicy } from './budget.js';

describe('execution budgets', () => {
  it('selects the strictest Goal and Task limits without widening them', () => {
    const result = resolveBudgetPolicy({
      goalConstraints: { maxWallClockMs: 10_000, maxTokens: 10_000 },
      taskConstraints: { maxWallClockMs: 5_000, maxTokens: 8_000 },
      taskMaxAttempts: 3,
    });
    expect(result.policy).toMatchObject({
      maxWallClockMs: 5_000,
      maxTokens: 8_000,
      maxTaskAttempts: 3,
    });
    expect(result.issues).toHaveLength(0);
  });

  it('emits a warning before a wall-clock hard limit', () => {
    const result = evaluateBudget({
      goalConstraints: { warningWallClockMs: 5_000, maxWallClockMs: 10_000 },
      usage: { goalAttempts: 0, taskAttempts: 0, elapsedMs: 6_000 },
    });
    expect(result.status).toBe('WARNING');
    expect(result.signals).toMatchObject([
      { metric: 'wall-clock', severity: 'warning', limit: 5_000, observed: 6_000 },
    ]);
  });

  it('stops on an observed hard limit and keeps missing usage unavailable', () => {
    const result = evaluateBudget({
      goalConstraints: { maxWallClockMs: 10_000, maxTokens: 100, maxCost: 1 },
      usage: { goalAttempts: 0, taskAttempts: 0, elapsedMs: 10_000 },
    });
    expect(result.status).toBe('EXCEEDED');
    expect(result.signals[0]).toMatchObject({ metric: 'wall-clock', severity: 'exceeded' });
    expect(result.unavailable).toEqual(['tokens', 'cost']);
  });

  it('uses provider-reported token and cost usage when available', () => {
    const result = evaluateBudget({
      goalConstraints: { warningTokens: 100, maxTokens: 200, maxCost: 2 },
      usage: {
        goalAttempts: 1,
        taskAttempts: 1,
        elapsedMs: 100,
        totalTokens: 250,
        cost: 0.5,
      },
    });
    expect(result.status).toBe('EXCEEDED');
    expect(result.signals).toMatchObject([
      { metric: 'tokens', severity: 'exceeded', observed: 250 },
    ]);
    expect(result.unavailable).toHaveLength(0);
  });

  it('reports malformed optional constraints without breaking legacy constraints', () => {
    const result = evaluateBudget({
      goalConstraints: { maxWallClockMs: 'soon' },
      taskConstraints: { warningTokens: 0 },
      usage: { goalAttempts: 0, taskAttempts: 0, elapsedMs: 0 },
    });
    expect(result.status).toBe('WARNING');
    expect(result.issues).toHaveLength(2);
    expect(result.signals).toHaveLength(0);
  });
});
