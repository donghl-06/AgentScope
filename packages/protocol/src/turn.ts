import type { Activity, EtaResult, ProgressResult, VerificationState } from './session.js';

export const TURN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'blocked',
  'completed',
  'failed',
  'interrupted',
] as const;

export type TurnStatus = (typeof TURN_STATUSES)[number];

export const TERMINAL_TURN_STATUSES = ['completed', 'failed', 'interrupted'] as const;
export type TerminalTurnStatus = (typeof TERMINAL_TURN_STATUSES)[number];

export type TurnFinishReason = 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unknown';

export interface TurnState {
  readonly turnId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly status: TurnStatus;
  readonly submittedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly title?: string;
  readonly prompt?: string;
  readonly providerTurnId?: string;
  readonly currentActivity?: Activity;
  readonly progress: ProgressResult;
  readonly eta?: EtaResult;
  readonly verification: VerificationState;
}

export function isTerminalTurnStatus(status: TurnStatus): status is TerminalTurnStatus {
  return (TERMINAL_TURN_STATUSES as readonly string[]).includes(status);
}

export function createInitialTurnState(
  turnId: string,
  sessionId: string,
  sequence: number,
  submittedAt: number,
  options: { readonly title?: string; readonly prompt?: string } = {},
): TurnState {
  return {
    turnId,
    sessionId,
    sequence,
    status: 'queued',
    submittedAt,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    progress: {
      value: 0,
      confidence: 0,
      reasons: [{ code: 'no_signal', message: 'No turn activity has been observed yet.' }],
    },
    verification: {
      tests: 'unknown',
      build: 'unknown',
      typecheck: 'unknown',
      overall: 'unknown',
    },
  };
}

export function assertTurnStateInvariants(state: TurnState): void {
  if (state.turnId.length === 0 || state.sessionId.length === 0) {
    throw new Error('Turn identifiers must be non-empty.');
  }
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 1) {
    throw new Error('Turn sequence must be a positive safe integer.');
  }
  if (!Number.isFinite(state.submittedAt) || state.submittedAt < 0) {
    throw new Error('Turn submittedAt must be a non-negative finite timestamp.');
  }
  if (state.startedAt !== undefined) {
    if (!Number.isFinite(state.startedAt) || state.startedAt < state.submittedAt) {
      throw new Error('Turn startedAt must be finite and >= submittedAt.');
    }
  }
  if (state.endedAt !== undefined) {
    const lowerBound = state.startedAt ?? state.submittedAt;
    if (!Number.isFinite(state.endedAt) || state.endedAt < lowerBound) {
      throw new Error('Turn endedAt must be finite and >= its start or submission time.');
    }
  }
  if (isTerminalTurnStatus(state.status) !== (state.endedAt !== undefined)) {
    throw new Error('Only terminal turns may have endedAt.');
  }
  if (
    !Number.isFinite(state.progress.value) ||
    state.progress.value < 0 ||
    state.progress.value > 1 ||
    !Number.isFinite(state.progress.confidence) ||
    state.progress.confidence < 0 ||
    state.progress.confidence > 1
  ) {
    throw new Error('Turn progress value and confidence must be within the inclusive range 0..1.');
  }
  if (state.eta !== undefined) {
    if (!Number.isFinite(state.eta.minSeconds) || state.eta.minSeconds < 0) {
      throw new Error('Turn ETA minSeconds must be a non-negative finite number.');
    }
    if (!Number.isFinite(state.eta.maxSeconds) || state.eta.maxSeconds < state.eta.minSeconds) {
      throw new Error('Turn ETA maxSeconds must be finite and >= minSeconds.');
    }
  }
}
