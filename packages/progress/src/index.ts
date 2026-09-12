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
  /** Observer-derived activity is useful but weaker than provider-native data. */
  readonly observerSignals?: boolean;
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
  /** Verification gates used to distinguish verified from unverified completion. */
  readonly requiredVerification?: readonly VerificationKey[];
  /** Optional per-milestone weights. Omitted milestone ids use the default weight of 1. */
  readonly milestoneWeights?: Readonly<Record<string, number>>;
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
  let value = milestoneValue(state, reasons, input.config?.milestoneWeights);
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
    // A terminal completion is authoritative for execution progress. A task
    // may legitimately have no verification phase (for example a short
    // question/answer or a read-only inspection), so missing verification
    // evidence must not leave the projection stuck at the old 60% cap.
    value = 1;
    reasons.push({
      code: 'completion_unverified',
      message: 'Session completed; verification evidence is unavailable or not required.',
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

function milestoneValue(
  state: SessionState,
  reasons: ProgressReason[],
  explicitWeights: Readonly<Record<string, number>> | undefined,
): number {
  if (state.milestones.length === 0) return 0;
  const weights = normalizeMilestoneWeights(state, explicitWeights, reasons);
  const totalWeight = state.milestones.reduce(
    (total, milestone) => total + (weights.get(milestone.id) ?? 1),
    0,
  );
  const completedWeight = state.milestones.reduce(
    (total, milestone) =>
      total + (milestone.status === 'completed' ? (weights.get(milestone.id) ?? 1) : 0),
    0,
  );
  const active = state.milestones.some((milestone) => milestone.status === 'active');
  const value = completedWeight / totalWeight + (active ? 0.1 : 0);
  const completed = state.milestones.filter((milestone) => milestone.status === 'completed').length;
  reasons.push({
    code: 'milestone_progress',
    message: `${completed} of ${state.milestones.length} milestones completed.`,
  });
  return Math.min(0.9, value);
}

function normalizeMilestoneWeights(
  state: SessionState,
  explicitWeights: Readonly<Record<string, number>> | undefined,
  reasons: ProgressReason[],
): Map<string, number> {
  const weights = new Map(state.milestones.map((milestone) => [milestone.id, 1]));
  if (explicitWeights === undefined) return weights;

  const milestoneIds = new Set(weights.keys());
  const valid = Object.entries(explicitWeights).every(
    ([id, weight]) => milestoneIds.has(id) && Number.isFinite(weight) && weight > 0,
  );
  if (!valid) {
    reasons.push({
      code: 'invalid_milestone_weights',
      message: 'Invalid milestone weights were ignored; equal weights were used.',
    });
    return weights;
  }
  for (const [id, weight] of Object.entries(explicitWeights)) weights.set(id, weight);
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total) || total <= 0) {
    reasons.push({
      code: 'invalid_milestone_weights',
      message: 'Milestone weights could not be normalized; equal weights were used.',
    });
    return new Map(state.milestones.map((milestone) => [milestone.id, 1]));
  }
  for (const [id, weight] of weights) weights.set(id, weight / total);
  reasons.push({
    code: 'weighted_milestones',
    message: 'Milestone progress uses normalized explicit weights.',
  });
  return weights;
}

function activityValue(state: SessionState, reasons: ProgressReason[]): number {
  const kind = state.currentActivity?.kind;
  const completedInteractiveTask =
    state.status === 'completed' && state.currentActivity?.label === 'task completed';
  if (completedInteractiveTask) {
    reasons.push({
      code: 'interactive_completion',
      message: 'Interactive task completed; verification evidence is still unavailable.',
    });
    return 0.6;
  }
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
      : {
          code: state.milestones.length === 0 ? 'implicit_phase' : 'activity_signal',
          message:
            state.milestones.length === 0
              ? `No milestones are available; using current activity ${kind} as an implicit phase.`
              : `Current activity is ${kind}.`,
        },
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
  if (capabilities.observerSignals) confidence += 0.1;
  if (input.state.milestones.length > 0 || capabilities.milestones) confidence += 0.15;
  if (input.state.milestones.length === 0 && !capabilities.milestones) {
    confidence -= 0.1;
    reasons.push({
      code: 'milestone_missing',
      message: 'Confidence is reduced because no explicit milestones are available.',
    });
  }
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
