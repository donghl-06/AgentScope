import { describe, expect, it } from 'vitest';

import {
  getProviderCapabilityProfile,
  preflightProviderTask,
  providerPreflightJson,
} from './provider-capabilities.js';

const readTask = {
  title: 'Inspect the repository',
  objective: 'Read project metadata and report findings.',
  constraints: {},
  verification: {},
};

describe('provider capability preflight', () => {
  it('matches the observed Claude and Codex adapter capability differences', () => {
    expect(getProviderCapabilityProfile('claude')).toMatchObject({
      adapter: 'claude-code',
      telemetry: { fileEvents: false, milestones: true },
      safeLaunchPolicy: 'no-global-bypass',
    });
    expect(getProviderCapabilityProfile('codex')).toMatchObject({
      adapter: 'codex-cli',
      telemetry: { fileEvents: false, milestones: false, tokenUsage: true },
    });
    expect(getProviderCapabilityProfile('codex-app-server')).toMatchObject({
      adapter: 'codex-app-server',
      telemetry: { fileEvents: true, milestones: true },
    });
  });

  it('requires AgentScope approval for destructive work without global bypass flags', () => {
    const result = preflightProviderTask({
      provider: 'claude',
      task: {
        ...readTask,
        title: 'Delete generated files',
        objective: 'Remove the generated directory.',
      },
    });
    expect(result.decision).toBe('REQUIRES_APPROVAL');
    expect(result.risk.level).toBe('CRITICAL');
    expect(result.profile.safeLaunchPolicy).toBe('no-global-bypass');
    expect(result.unsupportedCategories).toHaveLength(0);
  });

  it('does not invent native controls for an unknown provider', () => {
    const result = preflightProviderTask({ provider: 'other', task: readTask });
    expect(result.decision).toBe('PROCEED');
    expect(result.profile.available).toBe(false);
    expect(result.profile.telemetry.tokenUsage).toBe(false);
    expect(result.unsupportedCategories).toEqual(['read']);
    expect(providerPreflightJson(result)).not.toHaveProperty('risk');
  });

  it('keeps unknown medium-risk work conservative and explicit', () => {
    const result = preflightProviderTask({
      provider: 'other',
      task: { ...readTask, title: 'Modify files', objective: 'Edit a source file.' },
    });
    expect(result.decision).toBe('NEEDS_HUMAN');
    expect(result.unsupportedCategories).toEqual(['workspace-write']);
    expect(result.reasons.join(' ')).toContain('no verified control');
  });
});
