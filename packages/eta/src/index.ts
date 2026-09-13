import type { EtaResult, ProgressResult, SessionState } from '@agentscope/protocol';

export interface EtaEngineInput {
  readonly state: SessionState;
  readonly progress: ProgressResult;
  readonly elapsedSeconds: number;
  readonly replanningDetected?: boolean;
  /** Completed comparable-session durations used for a conservative baseline. */
  readonly history?: EtaHistory;
}

export interface EtaHistory {
  readonly durationsSeconds: readonly number[];
  readonly scope?: string;
}

export interface EtaConfig {
  readonly minProgress: number;
  readonly lowSignalMinSeconds: number;
  readonly lowSignalMaxSeconds: number;
  readonly maxSeconds: number;
  readonly failedVerificationPenalty?: number;
  readonly blockedPenalty?: number;
  readonly lowSignalPenalty?: number;
  readonly verificationPendingPenalty?: number;
  readonly replanningPenalty?: number;
  /** Confidence multiplier when elapsed time has passed the historical p75. */
  readonly historyOverrunConfidenceFactor?: number;
  /** Minimum completed comparable sessions before history can influence ETA. */
  readonly minHistorySamples?: number;
}

export const DEFAULT_ETA_CONFIG: EtaConfig = {
  minProgress: 0.08,
  lowSignalMinSeconds: 60,
  lowSignalMaxSeconds: 3_600,
  maxSeconds: 7 * 24 * 60 * 60,
  failedVerificationPenalty: 1.5,
  blockedPenalty: 1.75,
  lowSignalPenalty: 1.5,
  verificationPendingPenalty: 1.2,
  replanningPenalty: 1.4,
  historyOverrunConfidenceFactor: 0.65,
  minHistorySamples: 3,
};

export function estimateEta(
  input: EtaEngineInput,
  config: EtaConfig = DEFAULT_ETA_CONFIG,
): EtaResult {
  validateConfig(config);
  const elapsed = Math.max(0, finiteOrZero(input.elapsedSeconds));
  if (isTerminal(input.state.status)) {
    return {
      minSeconds: 0,
      maxSeconds: 0,
      confidence: 1,
      reasons: [{ code: 'terminal', message: 'Session has reached a terminal state.' }],
    };
  }
  const history = summarizeHistory(input.history, config.minHistorySamples ?? 3);
  const historyReasons: Array<{ code: string; message: string }> = [];
  const historyOverrun = history !== undefined && elapsed > history.p75;
  if (historyOverrun) {
    historyReasons.push({
      code: 'history_overrun',
      message: `Elapsed time has exceeded the historical p75 of ${formatSeconds(history!.p75)}; ETA confidence is reduced.`,
    });
  }
  if (input.history !== undefined && history === undefined) {
    historyReasons.push({
      code: 'history_insufficient',
      message: `ETA history needs at least ${config.minHistorySamples ?? 3} comparable completed sessions.`,
    });
  }
  if (input.progress.value < config.minProgress) {
    if (history !== undefined) {
      const historyRange = historyRemainingRange(history, elapsed);
      return {
        minSeconds: historyRange.minSeconds,
        maxSeconds: historyRange.maxSeconds,
        confidence: Math.min(
          0.35,
          historyConfidence(history.count) *
            (historyOverrun
              ? (config.historyOverrunConfidenceFactor ??
                DEFAULT_ETA_CONFIG.historyOverrunConfidenceFactor!)
              : 1),
        ),
        reasons: [
          ...historyReasons,
          {
            code: 'history_baseline',
            message: `Using ${history.count} comparable completed sessions as the ETA baseline${history.scope === undefined ? '' : ` (${history.scope})`}.`,
          },
          {
            code: 'insufficient_data',
            message: `Progress is below the ${config.minProgress} estimation threshold.`,
          },
        ],
      };
    }
    return {
      minSeconds: config.lowSignalMinSeconds,
      maxSeconds: config.lowSignalMaxSeconds,
      confidence: Math.min(0.25, input.progress.confidence),
      reasons: [
        ...historyReasons,
        {
          code: 'insufficient_data',
          message: `Progress is below the ${config.minProgress} estimation threshold.`,
        },
      ],
    };
  }

  const observedRemaining =
    (elapsed / Math.max(input.progress.value, config.minProgress)) * (1 - input.progress.value);
  let base = observedRemaining;
  const reasons = [...input.progress.reasons];
  if (history !== undefined) {
    const observedTotal = elapsed / Math.max(input.progress.value, config.minProgress);
    const weight = historyWeight(history.count);
    const blendedTotal = history.median * weight + observedTotal * (1 - weight);
    base = Math.max(0, blendedTotal - elapsed);
    reasons.push({
      code: 'history_baseline',
      message: `Using ${history.count} comparable completed sessions as the ETA baseline${history.scope === undefined ? '' : ` (${history.scope})`}.`,
    });
    reasons.push({
      code: 'history_range',
      message: `Historical total duration range is ${formatSeconds(history.p25)}–${formatSeconds(history.p75)}.`,
    });
  }
  let penalty = 1;
  if (
    input.state.verification.tests === 'failed' ||
    input.state.verification.overall === 'failed'
  ) {
    penalty *= config.failedVerificationPenalty ?? DEFAULT_ETA_CONFIG.failedVerificationPenalty!;
    reasons.push({
      code: 'failed_verification_penalty',
      message: 'Recent verification failure widens the ETA.',
    });
  }
  if (input.state.status === 'blocked') {
    penalty *= config.blockedPenalty ?? DEFAULT_ETA_CONFIG.blockedPenalty!;
    reasons.push({
      code: 'blocked_penalty',
      message: 'Current blocked state increases the ETA range.',
    });
  }
  if (input.progress.confidence < 0.5) {
    penalty *= config.lowSignalPenalty ?? DEFAULT_ETA_CONFIG.lowSignalPenalty!;
    reasons.push({ code: 'low_signal_penalty', message: 'Sparse evidence widens the ETA range.' });
  }
  if (
    input.state.verification.overall === 'pending' ||
    input.state.verification.overall === 'unknown'
  ) {
    penalty *= config.verificationPendingPenalty ?? DEFAULT_ETA_CONFIG.verificationPendingPenalty!;
    reasons.push({ code: 'verification_pending', message: 'Verification is not complete.' });
  }
  if (
    input.replanningDetected === true ||
    input.state.milestones.some((milestone) => milestone.status === 'failed')
  ) {
    penalty *= config.replanningPenalty ?? DEFAULT_ETA_CONFIG.replanningPenalty!;
    reasons.push({
      code: 'replanning_penalty',
      message: 'Milestone scope changed or failed, widening the ETA range.',
    });
  }
  const center = Math.min(config.maxSeconds, Math.max(0, base * penalty));
  const uncertainty = Math.max(0.35, 1 - input.progress.confidence);
  let minSeconds = Math.max(30, Math.floor(center * Math.max(0.25, 1 - uncertainty)));
  let maxSeconds = Math.min(
    config.maxSeconds,
    Math.max(minSeconds, Math.ceil(center * (1 + uncertainty * 2))),
  );
  if (history !== undefined) {
    const historyRange = historyRemainingRange(history, elapsed);
    minSeconds = Math.max(0, Math.min(minSeconds, historyRange.minSeconds));
    maxSeconds = Math.min(config.maxSeconds, Math.max(maxSeconds, historyRange.maxSeconds));
  }
  const historyConfidenceValue = history === undefined ? 0 : historyConfidence(history.count);
  const overrunConfidenceFactor = historyOverrun
    ? (config.historyOverrunConfidenceFactor ?? DEFAULT_ETA_CONFIG.historyOverrunConfidenceFactor!)
    : 1;
  return {
    minSeconds,
    maxSeconds,
    confidence: clamp(
      Math.max(input.progress.confidence, historyConfidenceValue) *
        (input.state.verification.overall === 'passed' ? 1 : 0.8) *
        overrunConfidenceFactor,
    ),
    reasons: dedupeReasons([...historyReasons, ...reasons]),
  };
}

interface HistorySummary {
  readonly count: number;
  readonly min: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly max: number;
  readonly scope?: string;
}

function summarizeHistory(
  history: EtaHistory | undefined,
  minSamples: number,
): HistorySummary | undefined {
  if (history === undefined) return undefined;
  const durations = history.durationsSeconds
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => value)
    .sort((left, right) => left - right);
  if (durations.length < minSamples) return undefined;
  return {
    count: durations.length,
    min: durations[0] ?? 0,
    p25: percentile(durations, 0.25),
    median: percentile(durations, 0.5),
    p75: percentile(durations, 0.75),
    max: durations.at(-1) ?? 0,
    ...(history.scope === undefined ? {} : { scope: history.scope }),
  };
}

function historyWeight(sampleCount: number): number {
  return Math.min(0.75, sampleCount / (sampleCount + 3));
}

function historyConfidence(sampleCount: number): number {
  return Math.min(0.8, 0.2 + sampleCount / 20);
}

function historyRemainingRange(
  history: HistorySummary,
  elapsedSeconds: number,
): { minSeconds: number; maxSeconds: number } {
  const minSeconds = Math.max(0, Math.floor(history.p25 - elapsedSeconds));
  const maxSeconds = Math.max(minSeconds, Math.ceil(history.p75 - elapsedSeconds));
  return { minSeconds, maxSeconds };
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

function formatSeconds(value: number): string {
  return `${Math.round(value)}s`;
}

function isTerminal(status: SessionState['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function dedupeReasons(reasons: readonly { code: string; message: string }[]) {
  return [...new Map(reasons.map((reason) => [reason.code, reason])).values()];
}

function validateConfig(config: EtaConfig): void {
  if (!Number.isFinite(config.minProgress) || config.minProgress <= 0 || config.minProgress > 1) {
    throw new RangeError('minProgress must be in (0, 1].');
  }
  if (config.lowSignalMinSeconds < 0 || config.lowSignalMaxSeconds < config.lowSignalMinSeconds) {
    throw new RangeError('Low-signal ETA range is invalid.');
  }
  if (config.maxSeconds <= 0) throw new RangeError('maxSeconds must be positive.');
  if (
    config.minHistorySamples !== undefined &&
    (!Number.isInteger(config.minHistorySamples) || config.minHistorySamples < 1)
  ) {
    throw new RangeError('minHistorySamples must be a positive integer.');
  }
  for (const [name, value] of Object.entries({
    failedVerificationPenalty: config.failedVerificationPenalty,
    blockedPenalty: config.blockedPenalty,
    lowSignalPenalty: config.lowSignalPenalty,
    verificationPendingPenalty: config.verificationPendingPenalty,
    replanningPenalty: config.replanningPenalty,
  })) {
    if (value !== undefined && (!Number.isFinite(value) || value < 1 || value > 10)) {
      throw new RangeError(`${name} must be between 1 and 10.`);
    }
  }
  if (
    config.historyOverrunConfidenceFactor !== undefined &&
    (!Number.isFinite(config.historyOverrunConfidenceFactor) ||
      config.historyOverrunConfidenceFactor <= 0 ||
      config.historyOverrunConfidenceFactor > 1)
  ) {
    throw new RangeError('historyOverrunConfidenceFactor must be in (0, 1].');
  }
}
