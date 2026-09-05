import type {
  ProgressReason,
  ProgressResult,
  SessionState,
  VerificationState,
} from '@agentscope/protocol';

export interface ProgressCapabilities {
  readonly structuredEvents?: boolean;
  readonly toolCalls?: boolean;
  readonly commandEvents?: boolean;
  readonly fileEvents?: boolean;
  readonly milestones?: boolean;
}

export interface ProgressEngineInput {
  readonly state: SessionState;
  readonly capabilities?: ProgressCapabilities;
  readonly config?: ProgressConfig;
  readonly now?: number;
  readonly lastSignalAt?: number;
}

export type VerificationKey = keyof Pick<VerificationState, 'tests' | 'build' | 'typecheck'>;

export interface ProgressConfig {
  /** Verification gates required before a completed session can report 100%. */
  readonly requiredVerification?: readonly VerificationKey[];
}

export const DEFAULT_REQUIRED_VERIFICATION: readonly VerificationKey[] = [
  'tests',
  'build',
  'typecheck',
] as const;

export const DEFAULT_PROGRESS_WEIGHTS = {
  planning: 0.1,
  implementation: 0.5,
  unitVerification: 0.15,
  integrationVerification: 0.15,
  finalReview: 0.1,
} as const;

export function computeProgress(input: ProgressEngineInput): ProgressResult {
  const { state } = input;
  const requiredVerification = input.config?.requiredVerification ?? DEFAULT_REQUIRED_VERIFICATION;
  const reasons: ProgressReason[] = [];
  let value = milestoneValue(state, reasons);
  if (state.milestones.length === 0) value = activityValue(state, reasons);

  const verification = verificationValue(state, reasons, requiredVerification);
  value = Math.max(value, verification.value);
  if (state.status === 'completed' && verification.requiredCount > 0 && verification.allPassed) {
    value = 1;
    reasons.push({
      code: 'verified_completion',
      message: 'Session completed with passing verification.',
    });
  } else if (state.status === 'completed') {
    value = Math.min(value, 0.6);
    reasons.push({
      code: 'completion_unverified',
      message: 'Completion is capped until verification passes.',
    });
  }
  if (state.status === 'failed') {
    value = Math.min(value, 0.6);
    reasons.push({
      code: 'failed_session_cap',
      message: 'Failed sessions cannot report full progress.',
    });
  }
  if (state.status === 'blocked') {
    value = Math.min(value, 0.5);
    reasons.push({
      code: 'blocked_cap',
      message: 'Blocked sessions are capped while waiting for action.',
    });
  }

  const confidence = computeConfidence(input, verification.known, reasons);
  return { value: clamp(value), confidence, reasons: dedupeReasons(reasons) };
}

function milestoneValue(state: SessionState, reasons: ProgressReason[]): number {
  if (state.milestones.length === 0) return 0;
  const completed = state.milestones.filter((milestone) => milestone.status === 'completed').length;
  const active = state.milestones.some((milestone) => milestone.status === 'active');
  const value = completed / state.milestones.length + (active ? 0.1 : 0);
  reasons.push({
    code: 'milestone_progress',
    message: `${completed} of ${state.milestones.length} milestones completed.`,
  });
  return Math.min(0.9, value);
}

function activityValue(state: SessionState, reasons: ProgressReason[]): number {
  const kind = state.currentActivity?.kind;
  const value =
    kind === 'planning'
      ? DEFAULT_PROGRESS_WEIGHTS.planning
      : kind === 'implementation' || kind === 'file'
        ? 0.35
        : kind === 'command' || kind === 'test'
          ? 0.55
          : kind === 'review'
            ? 0.8
            : kind === 'blocked'
              ? 0.35
              : 0;
  reasons.push(
    kind === undefined
      ? { code: 'no_activity', message: 'No agent activity has been observed yet.' }
      : { code: 'activity_signal', message: `Current activity is ${kind}.` },
  );
  return value;
}

function verificationValue(
  state: SessionState,
  reasons: ProgressReason[],
  required: readonly VerificationKey[],
): { value: number; known: number; requiredCount: number; allPassed: boolean } {
  const values = required.map((key) => state.verification[key]);
  const passed = values.filter((value) => value === 'passed').length;
  const failed = values.filter((value) => value === 'failed').length;
  const known = values.filter((value) => value !== 'unknown').length;
  if (passed > 0)
    reasons.push({ code: 'verification_passed', message: `${passed} verification checks passed.` });
  if (failed > 0)
    reasons.push({ code: 'verification_failed', message: `${failed} verification checks failed.` });
  if (known < values.length)
    reasons.push({
      code: 'verification_pending',
      message: 'Some verification checks are still unknown.',
    });
  return {
    value: values.length === 0 ? 0 : (passed / values.length) * 0.2,
    known,
    requiredCount: values.length,
    allPassed: values.length > 0 && passed === values.length,
  };
}

function computeConfidence(
  input: ProgressEngineInput,
  knownVerification: number,
  reasons: ProgressReason[],
): number {
  const capabilities = input.capabilities ?? {};
  let confidence = 0.2;
  if (capabilities.structuredEvents) confidence += 0.2;
  if (capabilities.commandEvents || capabilities.fileEvents || capabilities.toolCalls)
    confidence += 0.15;
  if (input.state.milestones.length > 0 || capabilities.milestones) confidence += 0.15;
  confidence += (knownVerification / 3) * 0.2;
  if (input.lastSignalAt !== undefined && input.now !== undefined) {
    const age = Math.max(0, input.now - input.lastSignalAt);
    if (age > 5 * 60_000) confidence -= 0.2;
    else if (age > 60_000) confidence -= 0.1;
  }
  if (confidence < 0.45)
    reasons.push({
      code: 'low_signal',
      message: 'Progress confidence is limited by sparse evidence.',
    });
  return clamp(confidence);
}

function dedupeReasons(reasons: readonly ProgressReason[]): readonly ProgressReason[] {
  return [...new Map(reasons.map((reason) => [reason.code, reason])).values()];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
