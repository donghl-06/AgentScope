export const SESSION_STATUSES = [
  'starting',
  'running',
  'blocked',
  'completed',
  'failed',
  'interrupted',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const TERMINAL_SESSION_STATUSES = ['completed', 'failed', 'interrupted'] as const;
export type TerminalSessionStatus = (typeof TERMINAL_SESSION_STATUSES)[number];

export const VERIFICATION_STATUSES = ['unknown', 'pending', 'passed', 'failed'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export type ActivityKind =
  'planning' | 'implementation' | 'command' | 'test' | 'file' | 'review' | 'blocked';

export interface Activity {
  readonly kind: ActivityKind;
  readonly label: string;
  readonly startedAt: number;
  readonly source?: string;
}

export type MilestoneStatus = 'pending' | 'active' | 'completed' | 'failed';

export interface Milestone {
  readonly id: string;
  readonly title: string;
  readonly status: MilestoneStatus;
  readonly startedAt?: number;
  readonly completedAt?: number;
}

export interface WorkspaceState {
  readonly rootPath: string;
  readonly gitBranch?: string;
  readonly changedFiles?: number;
  readonly lastActivityAt?: number;
}

export interface VerificationState {
  readonly tests: VerificationStatus;
  readonly build: VerificationStatus;
  readonly typecheck: VerificationStatus;
  readonly overall: VerificationStatus;
}

/** Provider metadata that is safe to expose without retaining the transcript. */
export interface ProviderInfo {
  readonly providerSessionId?: string;
  readonly model?: string;
  readonly cliVersion?: string;
  readonly permissionMode?: string;
  readonly outputFormat?: string;
  readonly capabilityLabels?: readonly string[];
  /** Counts from the provider's advertised capability catalog, not transcripts. */
  readonly toolCount?: number;
  readonly mcpServerCount?: number;
  readonly slashCommandCount?: number;
  readonly agentCount?: number;
  readonly skillCount?: number;
  readonly pluginCount?: number;
}

/** Normalized provider usage and timing telemetry. Values are cumulative snapshots. */
export interface UsageSnapshot {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreation5mInputTokens?: number;
  readonly cacheCreation1hInputTokens?: number;
  readonly thinkingTokens?: number;
  readonly thinkingTokensDelta?: number;
  readonly reasoningTokens?: number;
  readonly serverToolUseRequests?: number;
  readonly permissionDenialCount?: number;
  readonly turnCount?: number;
  readonly totalTokens?: number;
  readonly totalCostUsd?: number;
  readonly durationMs?: number;
  readonly durationApiMs?: number;
  readonly ttftMs?: number;
  readonly ttftStreamMs?: number;
  readonly timeToRequestMs?: number;
  readonly firstContentFrameMs?: number;
  readonly queuedTurnCount?: number;
  readonly iterations?: number;
  readonly inferenceGeo?: string;
  readonly speed?: string;
  readonly terminalReason?: string;
  readonly fastModeState?: string;
  readonly apiErrorStatus?: number;
  readonly model?: string;
  readonly serviceTier?: string;
}

export interface ProviderTelemetry {
  readonly providerInfo?: ProviderInfo;
  readonly usage?: UsageSnapshot;
  readonly nativeEventCounts?: Readonly<Record<string, number>>;
  readonly toolCallCount?: number;
  readonly toolCallFinishedCount?: number;
  readonly toolCallErrorCount?: number;
}

export interface ProgressReason {
  readonly code: string;
  readonly message: string;
}

export interface ProgressResult {
  readonly value: number;
  readonly confidence: number;
  readonly reasons: readonly ProgressReason[];
}

export interface EtaResult {
  readonly minSeconds: number;
  readonly maxSeconds: number;
  readonly confidence: number;
  readonly reasons: readonly ProgressReason[];
}

export interface SessionState {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly currentActivity?: Activity;
  readonly milestones: readonly Milestone[];
  readonly progress: ProgressResult;
  readonly eta?: EtaResult;
  readonly workspace?: WorkspaceState;
  readonly verification: VerificationState;
  readonly telemetry?: ProviderTelemetry;
}

export function isTerminalSessionStatus(status: SessionStatus): status is TerminalSessionStatus {
  return (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status);
}

export function createInitialSessionState(sessionId: string, startedAt: number): SessionState {
  return {
    sessionId,
    status: 'starting',
    startedAt,
    milestones: [],
    progress: {
      value: 0,
      confidence: 0,
      reasons: [{ code: 'no_signal', message: 'No agent activity has been observed yet.' }],
    },
    verification: {
      tests: 'unknown',
      build: 'unknown',
      typecheck: 'unknown',
      overall: 'unknown',
    },
  };
}

export function assertSessionStateInvariants(state: SessionState): void {
  if (!Number.isFinite(state.startedAt) || state.startedAt < 0) {
    throw new Error('Session startedAt must be a non-negative finite timestamp.');
  }

  if (isTerminalSessionStatus(state.status) !== (state.endedAt !== undefined)) {
    throw new Error('Only terminal sessions may have endedAt.');
  }

  if (state.endedAt !== undefined && state.endedAt < state.startedAt) {
    throw new Error('Session endedAt cannot precede startedAt.');
  }

  if (
    !Number.isFinite(state.progress.value) ||
    state.progress.value < 0 ||
    state.progress.value > 1
  ) {
    throw new Error('Progress value must be within the inclusive range 0..1.');
  }

  if (
    !Number.isFinite(state.progress.confidence) ||
    state.progress.confidence < 0 ||
    state.progress.confidence > 1
  ) {
    throw new Error('Progress confidence must be within the inclusive range 0..1.');
  }

  if (state.eta !== undefined) {
    if (!Number.isFinite(state.eta.minSeconds) || state.eta.minSeconds < 0) {
      throw new Error('ETA minSeconds must be a non-negative finite number.');
    }
    if (!Number.isFinite(state.eta.maxSeconds) || state.eta.maxSeconds < state.eta.minSeconds) {
      throw new Error('ETA maxSeconds must be finite and >= minSeconds.');
    }
  }
}
