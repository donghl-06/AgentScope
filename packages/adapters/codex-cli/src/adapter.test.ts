import { describe, expect, it } from 'vitest';

import { CodexCliAdapter } from './adapter.js';

describe('Codex CLI adapter', () => {
  it('detects an executable without calling a provider API', async () => {
    const result = await new CodexCliAdapter({ executable: process.execPath }).detect({
      workspacePath: process.cwd(),
      executablePath: process.execPath,
      environment: 'windows',
    });

    expect(result.available).toBe(true);
    expect(result.version).toContain('v');
  });

  it('exposes only the capabilities supported by the observed JSONL path', () => {
    expect(new CodexCliAdapter().capabilities()).toEqual({
      structuredEvents: true,
      toolCalls: false,
      fileEvents: false,
      commandEvents: true,
      tokenUsage: false,
      sessionInfo: true,
      milestones: false,
    });
  });
});
