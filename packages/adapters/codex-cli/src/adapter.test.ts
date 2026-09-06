import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  it('resolves an npm Node-plus-JavaScript Windows shim without shell execution', async () => {
    if (process.platform !== 'win32') return;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-codex-shim-'));
    const originalPath = process.env.PATH;
    try {
      fs.writeFileSync(
        path.join(directory, 'codex.cmd'),
        '@echo off\r\n"%dp0%\\node.exe" "%dp0%\\codex.js" %*\r\n',
      );
      fs.writeFileSync(
        path.join(directory, 'codex.js'),
        "process.stdout.write('codex-shim 1.0\\n');",
      );
      process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ''}`;

      const result = await new CodexCliAdapter().detect({
        workspacePath: process.cwd(),
        executablePath: 'codex',
        environment: 'windows',
      });

      expect(result).toMatchObject({ available: true, version: 'codex-shim 1.0' });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
