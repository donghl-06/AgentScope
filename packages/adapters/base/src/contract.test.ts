import { describe, expect, it } from 'vitest';

import type { AgentAdapter, AgentCapabilities } from './contract.js';

describe('AgentAdapter contract', () => {
  it('keeps capability fields explicit and boolean', () => {
    const capabilities: AgentCapabilities = {
      structuredEvents: true,
      toolCalls: false,
      fileEvents: false,
      commandEvents: true,
      tokenUsage: false,
      sessionInfo: true,
      milestones: false,
    };

    expect(Object.values(capabilities).every((value) => typeof value === 'boolean')).toBe(true);
  });

  it('allows adapters with optional start and attach implementations', () => {
    const adapter: AgentAdapter = {
      id: 'example',
      detect: async () => ({ available: false, confidence: 0, reason: 'not installed' }),
      capabilities: () => ({
        structuredEvents: false,
        toolCalls: false,
        fileEvents: false,
        commandEvents: false,
        tokenUsage: false,
        sessionInfo: false,
        milestones: false,
      }),
    };

    expect(adapter.id).toBe('example');
    expect(adapter.start).toBeUndefined();
  });
});
