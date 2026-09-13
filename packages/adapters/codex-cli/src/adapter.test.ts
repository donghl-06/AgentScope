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
      toolCalls: true,
      fileEvents: false,
      commandEvents: true,
      tokenUsage: true,
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

  it('records malformed structured output while preserving a later valid completion', async () => {
    const output = [
      'this is not JSON',
      JSON.stringify({ type: 'thread.started', thread_id: 'provider-malformed' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-codex-malformed-'));
    try {
      fs.writeFileSync(
        path.join(directory, 'exec'),
        `process.stdout.write(${JSON.stringify(`${output}\n`)});`,
      );
      const session = await new CodexCliAdapter({ executable: process.execPath }).start({
        sessionId: 'malformed',
        workspacePath: directory,
        args: ['exec'],
      });
      const events = [];
      for await (const event of session.events()) events.push(event);

      expect(events.find((event) => event.type === 'error')?.payload).toMatchObject({
        code: 'invalid_output',
      });
      expect(events.at(-1)?.payload).toMatchObject({ reason: 'completed' });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
