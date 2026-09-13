import type { JsonObject, StoredTask } from '@agentscope/storage';

import {
  classifyTaskRisk,
  RISK_CATEGORIES,
  type RiskAssessment,
  type RiskCategory,
} from './risk.js';

export interface ProviderTelemetryCapabilities {
  readonly structuredEvents: boolean;
  readonly toolCalls: boolean;
  readonly fileEvents: boolean;
  readonly commandEvents: boolean;
  readonly tokenUsage: boolean;
  readonly sessionInfo: boolean;
  readonly milestones: boolean;
}

export type RiskControl = 'none' | 'agentscope-approval' | 'provider-native' | 'unavailable';

export interface ProviderCapabilityProfile {
  readonly provider: string;
  readonly adapter: string;
  readonly available: boolean;
  readonly confidence: number;
  readonly telemetry: ProviderTelemetryCapabilities;
  readonly riskControls: Readonly<Record<RiskCategory, RiskControl>>;
  readonly safeLaunchPolicy: 'no-global-bypass' | 'unknown';
  readonly limitations: readonly string[];
}

export type ProviderPreflightDecision = 'PROCEED' | 'REQUIRES_APPROVAL' | 'NEEDS_HUMAN';

export interface ProviderPreflightResult {
  readonly provider: string;
  readonly profile: ProviderCapabilityProfile;
  readonly risk: RiskAssessment;
  readonly decision: ProviderPreflightDecision;
  readonly unsupportedCategories: readonly RiskCategory[];
  readonly reasons: readonly string[];
}

const AGENTSCOPE_GATED_CONTROLS: Readonly<Record<RiskCategory, RiskControl>> = {
  read: 'none',
  'workspace-write': 'agentscope-approval',
  process: 'agentscope-approval',
  network: 'agentscope-approval',
  secret: 'agentscope-approval',
  destructive: 'agentscope-approval',
  'remote-side-effect': 'agentscope-approval',
};

const KNOWN_PROFILES: Readonly<Record<string, ProviderCapabilityProfile>> = {
  claude: {
    provider: 'claude',
    adapter: 'claude-code',
    available: true,
    confidence: 0.9,
    telemetry: {
      structuredEvents: true,
      toolCalls: true,
      fileEvents: false,
      commandEvents: true,
      tokenUsage: true,
      sessionInfo: true,
      milestones: true,
    },
    riskControls: AGENTSCOPE_GATED_CONTROLS,
    safeLaunchPolicy: 'no-global-bypass',
    limitations: [
      'File changes are observed through the workspace observer rather than a native file-event stream.',
      'Approval is enforced at the AgentScope Task boundary; no global permission bypass is enabled.',
    ],
  },
  codex: {
    provider: 'codex',
    adapter: 'codex-cli',
    available: true,
    confidence: 0.9,
    telemetry: {
      structuredEvents: true,
      toolCalls: true,
      fileEvents: false,
      commandEvents: true,
      tokenUsage: true,
      sessionInfo: true,
      milestones: false,
    },
    riskControls: AGENTSCOPE_GATED_CONTROLS,
    safeLaunchPolicy: 'no-global-bypass',
    limitations: [
      'Native file events and milestones are not reported by the observed Codex CLI JSONL path.',
      'Approval is enforced at the AgentScope Task boundary; no global permission bypass is enabled.',
    ],
  },
  'codex-app-server': {
    provider: 'codex-app-server',
    adapter: 'codex-app-server',
    available: true,
    confidence: 0.85,
    telemetry: {
      structuredEvents: true,
      toolCalls: true,
      fileEvents: true,
      commandEvents: true,
      tokenUsage: true,
      sessionInfo: true,
      milestones: true,
    },
    riskControls: AGENTSCOPE_GATED_CONTROLS,
    safeLaunchPolicy: 'no-global-bypass',
    limitations: [
      'The local adapter conservatively rejects provider approval requests when no interactive approval UI is attached.',
      'Provider cost and precise ETA remain unavailable unless the provider reports a stable field.',
    ],
  },
};

/** Return a versioned capability assertion derived from the observed adapters. */
export function getProviderCapabilityProfile(provider: string): ProviderCapabilityProfile {
  const known = KNOWN_PROFILES[provider];
  if (known !== undefined) return cloneProfile(known);
  return {
    provider,
    adapter: 'unknown',
    available: false,
    confidence: 0,
    telemetry: {
      structuredEvents: false,
      toolCalls: false,
      fileEvents: false,
      commandEvents: false,
      tokenUsage: false,
      sessionInfo: false,
      milestones: false,
    },
    riskControls: Object.fromEntries(
      RISK_CATEGORIES.map((category) => [category, 'unavailable']),
    ) as Record<RiskCategory, RiskControl>,
    safeLaunchPolicy: 'unknown',
    limitations: [
      'Provider is not in the observed capability matrix; native controls are unavailable.',
    ],
  };
}

/**
 * Check whether a Task can be launched with the provider's known controls.
 * AgentScope approval remains the authoritative gate for high-risk work.
 */
export function preflightProviderTask(input: {
  readonly provider: string;
  readonly task: Pick<StoredTask, 'title' | 'objective' | 'constraints' | 'verification'>;
}): ProviderPreflightResult {
  const profile = getProviderCapabilityProfile(input.provider);
  const risk = classifyTaskRisk(input.task);
  const unsupportedCategories = risk.categories.filter(
    (category) => profile.riskControls[category] === 'unavailable',
  );
  const reasons = [...profile.limitations, ...risk.reasons];
  let decision: ProviderPreflightDecision;
  if (risk.requiresApproval) {
    decision = 'REQUIRES_APPROVAL';
  } else if (unsupportedCategories.length > 0 && risk.level !== 'LOW') {
    decision = 'NEEDS_HUMAN';
    reasons.push(
      `Provider ${input.provider} has no verified control for ${unsupportedCategories.join(', ')}.`,
    );
  } else {
    decision = 'PROCEED';
  }
  return {
    provider: input.provider,
    profile,
    risk,
    decision,
    unsupportedCategories,
    reasons,
  };
}

/** Convert the result into an event-safe object without provider secrets. */
export function providerPreflightJson(result: ProviderPreflightResult): JsonObject {
  return {
    provider: result.provider,
    adapter: result.profile.adapter,
    available: result.profile.available,
    confidence: result.profile.confidence,
    decision: result.decision,
    unsupportedCategories: result.unsupportedCategories,
    telemetry: result.profile.telemetry,
    safeLaunchPolicy: result.profile.safeLaunchPolicy,
    limitations: result.profile.limitations,
  };
}

function cloneProfile(profile: ProviderCapabilityProfile): ProviderCapabilityProfile {
  return {
    ...profile,
    telemetry: { ...profile.telemetry },
    riskControls: { ...profile.riskControls },
    limitations: [...profile.limitations],
  };
}
