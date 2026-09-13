import type { WorkerFailure } from './worker.js';

/** Conservative defaults for transient Provider failures. */
export const DEFAULT_RETRY_BACKOFF_CONFIG = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxTotalDelayMs: 60_000,
  jitterRatio: 0.2,
  pollIntervalMs: 250,
} as const;

export interface RetryBackoffConfig {
  /** Delay for the first retryable failure. */
  readonly baseDelayMs?: number;
  /** Per-retry upper bound before jitter. */
  readonly maxDelayMs?: number;
  /** Total delay budget for one Task's retry sequence. */
  readonly maxTotalDelayMs?: number;
  /** Symmetric random jitter, constrained to [0, 1). */
  readonly jitterRatio?: number;
  /** Maximum time between cancellation checks while waiting. */
  readonly pollIntervalMs?: number;
}

export interface RetryBackoffDecision {
  readonly delayMs: number;
  readonly cumulativeDelayMs: number;
  readonly capped: boolean;
  readonly reason:
    'not_retryable' | 'budget_exhausted' | 'exponential' | 'per_retry_cap' | 'total_cap';
}

export interface RetryBackoffClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type RetryBackoffWaitResult = 'elapsed' | 'cancelled';

export interface RetryBackoffWaitOptions {
  readonly delayMs: number;
  readonly pollIntervalMs?: number;
  readonly shouldCancel?: () => boolean;
  readonly signal?: AbortSignal;
  readonly clock?: RetryBackoffClock;
}

export type RetryBackoffWaiter = (
  options: RetryBackoffWaitOptions,
) => Promise<RetryBackoffWaitResult>;

/**
 * Calculate a bounded exponential delay for the next Attempt.
 *
 * `attemptNumber` is the number of the Attempt that is about to start, so the
 * first retry (Attempt 2) receives the base delay. The caller supplies the
 * already scheduled delay so a process restart cannot reset the Task-level cap.
 */
export function computeRetryBackoff(
  attemptNumber: number,
  failure: Pick<WorkerFailure, 'retryable'>,
  cumulativeDelayMs = 0,
  config: RetryBackoffConfig = {},
  random = Math.random(),
): RetryBackoffDecision {
  assertPositiveInteger(attemptNumber, 'attemptNumber');
  assertNonNegativeFinite(cumulativeDelayMs, 'cumulativeDelayMs');
  const resolved = resolveRetryBackoffConfig(config);
  if (!failure.retryable) {
    return {
      delayMs: 0,
      cumulativeDelayMs,
      capped: false,
      reason: 'not_retryable',
    };
  }
  const remaining = Math.max(0, resolved.maxTotalDelayMs - cumulativeDelayMs);
  if (remaining === 0) {
    return {
      delayMs: 0,
      cumulativeDelayMs,
      capped: true,
      reason: 'budget_exhausted',
    };
  }
  const retryIndex = Math.max(0, attemptNumber - 2);
  const exponential = Math.min(
    resolved.maxDelayMs,
    resolved.baseDelayMs * 2 ** Math.min(retryIndex, 30),
  );
  const beforeJitter = Math.min(exponential, remaining);
  const jittered = Math.round(
    beforeJitter * (1 + (clampRandom(random) * 2 - 1) * resolved.jitterRatio),
  );
  const delayMs = Math.min(remaining, Math.max(1, jittered));
  const cumulative = cumulativeDelayMs + delayMs;
  const reason =
    cumulative >= resolved.maxTotalDelayMs
      ? 'total_cap'
      : exponential >= resolved.maxDelayMs
        ? 'per_retry_cap'
        : 'exponential';
  return {
    delayMs,
    cumulativeDelayMs: cumulative,
    capped: reason !== 'exponential',
    reason,
  };
}

/**
 * Wait without an unbounded timer. Cancellation is polled at a small bounded
 * interval so callers can stop a retry while no Provider process is active.
 * The timer is always cleared on completion, cancellation, or an AbortSignal.
 */
export const waitForRetryBackoff: RetryBackoffWaiter = async (options) => {
  assertNonNegativeFinite(options.delayMs, 'delayMs');
  const pollIntervalMs = resolvePollInterval(options.pollIntervalMs);
  const shouldCancel = options.shouldCancel ?? (() => false);
  const clock = options.clock ?? systemClock;
  if (options.signal?.aborted || shouldCancel()) return 'cancelled';
  if (options.delayMs === 0) return 'elapsed';

  return await new Promise<RetryBackoffWaitResult>((resolve) => {
    let remaining = options.delayMs;
    let timer: unknown;
    let settled = false;
    const finish = (result: RetryBackoffWaitResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish('cancelled');
    const tick = (): void => {
      if (settled) return;
      if (options.signal?.aborted || shouldCancel()) {
        finish('cancelled');
        return;
      }
      if (remaining <= 0) {
        finish('elapsed');
        return;
      }
      const slice = Math.min(remaining, pollIntervalMs);
      remaining -= slice;
      timer = clock.setTimeout(tick, slice);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    tick();
  });
};

function resolveRetryBackoffConfig(config: RetryBackoffConfig): Required<RetryBackoffConfig> {
  const baseDelayMs = config.baseDelayMs ?? DEFAULT_RETRY_BACKOFF_CONFIG.baseDelayMs;
  const maxDelayMs = config.maxDelayMs ?? DEFAULT_RETRY_BACKOFF_CONFIG.maxDelayMs;
  const maxTotalDelayMs = config.maxTotalDelayMs ?? DEFAULT_RETRY_BACKOFF_CONFIG.maxTotalDelayMs;
  const jitterRatio = config.jitterRatio ?? DEFAULT_RETRY_BACKOFF_CONFIG.jitterRatio;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_RETRY_BACKOFF_CONFIG.pollIntervalMs;
  assertPositiveFinite(baseDelayMs, 'baseDelayMs');
  assertPositiveFinite(maxDelayMs, 'maxDelayMs');
  assertPositiveFinite(maxTotalDelayMs, 'maxTotalDelayMs');
  assertNonNegativeFinite(jitterRatio, 'jitterRatio');
  if (jitterRatio >= 1) throw new RangeError('jitterRatio must be less than 1.');
  assertPositiveFinite(pollIntervalMs, 'pollIntervalMs');
  if (maxDelayMs < baseDelayMs) throw new RangeError('maxDelayMs cannot be below baseDelayMs.');
  return { baseDelayMs, maxDelayMs, maxTotalDelayMs, jitterRatio, pollIntervalMs };
}

function resolvePollInterval(value: number | undefined): number {
  const resolved = value ?? DEFAULT_RETRY_BACKOFF_CONFIG.pollIntervalMs;
  assertPositiveFinite(resolved, 'pollIntervalMs');
  return resolved;
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer.`);
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} must be finite and positive.`);
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative.`);
  }
}

const systemClock: RetryBackoffClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
