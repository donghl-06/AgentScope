import type { EtaResult, ProgressResult, SessionState } from '@agentscope/protocol';

export interface EtaEngineInput {
  readonly state: SessionState;
  readonly progress: ProgressResult;
  readonly elapsedSeconds: number;
  readonly replanningDetected?: boolean;
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
  if (input.progress.value < config.minProgress) {
    return {
      minSeconds: config.lowSignalMinSeconds,
      maxSeconds: config.lowSignalMaxSeconds,
      confidence: Math.min(0.25, input.progress.confidence),
      reasons: [
        {
          code: 'insufficient_data',
          message: `Progress is below the ${config.minProgress} estimation threshold.`,
        },
      ],
    };
  }

  const base =
    (elapsed / Math.max(input.progress.value, config.minProgress)) * (1 - input.progress.value);
  let penalty = 1;
  const reasons = [...input.progress.reasons];
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
  const minSeconds = Math.max(30, Math.floor(center * Math.max(0.25, 1 - uncertainty)));
  const maxSeconds = Math.min(
    config.maxSeconds,
    Math.max(minSeconds, Math.ceil(center * (1 + uncertainty * 2))),
  );
  return {
    minSeconds,
    maxSeconds,
    confidence: clamp(
      input.progress.confidence * (input.state.verification.overall === 'passed' ? 1 : 0.8),
    ),
    reasons: dedupeReasons(reasons),
  };
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
}
