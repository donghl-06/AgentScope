import { describe, expect, it } from 'vitest';

import { classifyTaskRisk } from './risk.js';

const base = {
  title: '',
  objective: '',
  constraints: {},
  verification: {},
};

describe('Task risk classification', () => {
  it('classifies read-only inspection as LOW without approval', () => {
    const result = classifyTaskRisk({
      ...base,
      title: 'Inspect repository metadata',
      objective: 'Read package manifests and list files.',
    });
    expect(result.level).toBe('LOW');
    expect(result.requiresApproval).toBe(false);
    expect(result.categories).toContain('read');
  });

  it('classifies ordinary implementation and local tests as MEDIUM', () => {
    const result = classifyTaskRisk({
      ...base,
      title: 'Implement the feature',
      objective: 'Modify workspace files and run the test suite.',
      verification: { checks: [{ executable: 'pnpm', args: ['test'] }] },
    });
    expect(result.level).toBe('MEDIUM');
    expect(result.requiresApproval).toBe(false);
    expect(result.categories).toEqual(expect.arrayContaining(['workspace-write', 'process']));
  });

  it('raises network, secret, destructive and remote actions to the right levels', () => {
    expect(
      classifyTaskRisk({
        ...base,
        title: 'Install dependency',
        objective: 'Run pnpm install from the network.',
      }).level,
    ).toBe('HIGH');
    expect(
      classifyTaskRisk({
        ...base,
        title: 'Use token',
        objective: 'Read the API key from the environment.',
      }).level,
    ).toBe('HIGH');
    expect(
      classifyTaskRisk({
        ...base,
        title: 'Delete temporary files',
        objective: 'Remove the generated directory.',
      }).level,
    ).toBe('CRITICAL');
    expect(
      classifyTaskRisk({
        ...base,
        title: 'Publish release',
        objective: 'Push and deploy the release.',
      }).level,
    ).toBe('CRITICAL');
  });

  it('defaults unknown actions to HIGH and handles platform-specific shells', () => {
    const unknown = classifyTaskRisk({
      ...base,
      title: 'Run custom tool',
      objective: 'Execute the custom tool.',
      verification: { checks: [{ executable: 'mystery-cli', args: [] }] },
    });
    expect(unknown.level).toBe('HIGH');
    expect(unknown.requiresApproval).toBe(true);
    expect(unknown.signals.map((signal) => signal.code)).toContain(
      'unknown-verification-executable',
    );

    const windows = classifyTaskRisk(
      {
        ...base,
        title: 'Run PowerShell check',
        objective: 'Execute a local check.',
        verification: { checks: [{ executable: 'powershell', args: ['-NoProfile'] }] },
      },
      { platform: 'win32' },
    );
    expect(windows.signals.map((signal) => signal.code)).not.toContain(
      'unknown-verification-executable',
    );
  });
});
