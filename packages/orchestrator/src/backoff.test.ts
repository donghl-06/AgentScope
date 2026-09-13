import { describe, expect, it, vi } from 'vitest';

import { computeRetryBackoff, waitForRetryBackoff, type RetryBackoffClock } from './backoff.js';

const retryable = { retryable: true } as const;
const permanent = { retryable: false } as const;

describe('computeRetryBackoff', () => {
  it('uses exponential delays with a deterministic jitter boundary', () => {
    const config = {
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
      maxTotalDelayMs: 30_000,
      jitterRatio: 0.2,
    };
    expect(computeRetryBackoff(2, retryable, 0, config, 0.5)).toMatchObject({
      delayMs: 1_000,
      cumulativeDelayMs: 1_000,
      capped: false,
      reason: 'exponential',
    });
    expect(computeRetryBackoff(3, retryable, 1_000, config, 0.5)).toMatchObject({
      delayMs: 2_000,
      cumulativeDelayMs: 3_000,
    });
  });

  it('never delays non-retryable failures and respects the total cap', () => {
    expect(computeRetryBackoff(2, permanent, 12_000)).toMatchObject({
      delayMs: 0,
      cumulativeDelayMs: 12_000,
      reason: 'not_retryable',
    });
    expect(
      computeRetryBackoff(
        2,
        retryable,
        9,
        { baseDelayMs: 10, maxDelayMs: 100, maxTotalDelayMs: 10, jitterRatio: 0 },
        0.5,
      ),
    ).toMatchObject({ delayMs: 1, cumulativeDelayMs: 10, capped: true, reason: 'total_cap' });
    expect(
      computeRetryBackoff(2, retryable, 10, {
        baseDelayMs: 10,
        maxDelayMs: 100,
        maxTotalDelayMs: 10,
        jitterRatio: 0,
      }),
    ).toMatchObject({ delayMs: 0, reason: 'budget_exhausted' });
  });

  it('clamps invalid random values instead of producing an invalid delay', () => {
    expect(
      computeRetryBackoff(
        2,
        retryable,
        0,
        { baseDelayMs: 10, maxDelayMs: 10, maxTotalDelayMs: 10, jitterRatio: 0.5 },
        Number.NaN,
      ).delayMs,
    ).toBe(10);
  });
});

describe('waitForRetryBackoff', () => {
  it('resolves after the bounded delay and clears the timer', async () => {
    vi.useFakeTimers();
    try {
      const result = waitForRetryBackoff({ delayMs: 500, pollIntervalMs: 100 });
      await vi.advanceTimersByTimeAsync(499);
      expect(await Promise.race([result, Promise.resolve('pending')])).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe('elapsed');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops when a cancellation predicate or AbortSignal fires', async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const predicate = waitForRetryBackoff({
        delayMs: 1_000,
        pollIntervalMs: 100,
        shouldCancel: () => cancelled,
      });
      cancelled = true;
      await vi.advanceTimersByTimeAsync(100);
      await expect(predicate).resolves.toBe('cancelled');
      expect(vi.getTimerCount()).toBe(0);

      const controller = new AbortController();
      const signal = waitForRetryBackoff({ delayMs: 1_000, signal: controller.signal });
      controller.abort();
      await expect(signal).resolves.toBe('cancelled');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports an injected clock without leaving duplicate timers', async () => {
    const callbacks: Array<{ readonly callback: () => void; readonly delayMs: number }> = [];
    const clock: RetryBackoffClock = {
      setTimeout: (callback, delayMs) => {
        callbacks.push({ callback, delayMs });
        return callback;
      },
      clearTimeout: () => undefined,
    };
    const pending = waitForRetryBackoff({ delayMs: 300, pollIntervalMs: 100, clock });
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!.callback();
    callbacks.shift()!.callback();
    callbacks.shift()!.callback();
    await expect(pending).resolves.toBe('elapsed');
    expect(callbacks).toHaveLength(0);
  });
});
