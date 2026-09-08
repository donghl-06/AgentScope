import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ObserverRuntime, type ObserverRuntimeError } from './index.js';

describe('observer runtime', () => {
  it('starts observers, fuses evidence, and stops late callbacks', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-runtime-'));
    const evidence: Array<{ source: string; kind: string; key: string }> = [];
    let emitFileEvent: ((kind: 'rename' | 'change', filename: string) => void) | undefined;
    try {
      fs.writeFileSync(path.join(rootPath, 'app.ts'), 'export const value = 1;\n', 'utf8');
      const runtime = new ObserverRuntime({
        sessionId: 'session-1',
        workspacePath: rootPath,
        now: () => 100,
        process: { pid: 42, startedAt: 90, inspect: async () => ({ state: 'running' }) },
        file: {
          debounceMs: 10,
          watchFactory: (_root, onEvent) => {
            emitFileEvent = onEvent as typeof emitFileEvent;
            return { close: () => {} };
          },
        },
        git: { run: async (_cwd, args) => gitResult(rootPath, args) },
        onEvidence: (item) =>
          evidence.push({ source: item.source, kind: item.kind, key: item.key }),
      });

      await runtime.start();
      expect(runtime.isActive).toBe(true);
      expect(evidence.map((item) => item.key)).toContain('process:42:started');
      expect(evidence.some((item) => item.key.endsWith(':baseline'))).toBe(true);

      await runtime.captureProcessSnapshot({ turnId: 'session-1:turn:1', phase: 'start' });
      await runtime.captureGitSnapshot({ turnId: 'session-1:turn:1', phase: 'start' });
      expect(evidence).toContainEqual({
        source: 'process',
        kind: 'lifecycle',
        key: 'process:42:turn:session-1:turn:1:start',
      });
      expect(evidence).toContainEqual({
        source: 'git',
        kind: 'workspace',
        key: expect.stringContaining(':turn:session-1:turn:1:start'),
      });

      emitFileEvent?.('change', 'app.ts');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(evidence).toContainEqual({ source: 'filesystem', kind: 'file', key: 'file:app.ts' });

      expect(
        runtime.observeCommandStarted({ id: 'cmd-1', commandName: 'pnpm test' }),
      ).toBeDefined();
      expect(
        runtime.observeCommandStarted({ id: 'cmd-1', commandName: 'pnpm test' }),
      ).toBeUndefined();
      expect(runtime.observeCommandFinished({ id: 'cmd-1', exitCode: 0 })).toMatchObject({
        outcome: 'passed',
        verification: 'passed',
      });
      runtime.notifyProcessExit(0, undefined, 120);
      expect(evidence.map((item) => item.key)).toContain('process:42:finished');

      const countBeforeStop = evidence.length;
      runtime.stop();
      expect(runtime.isActive).toBe(false);
      emitFileEvent?.('change', 'app.ts');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(evidence).toHaveLength(countBeforeStop);
      runtime.stop();
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('isolates observer startup failures and reports them without aborting Git capture', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscope-runtime-'));
    const errors: ObserverRuntimeError[] = [];
    const evidence: string[] = [];
    try {
      const runtime = new ObserverRuntime({
        sessionId: 'session-2',
        workspacePath: rootPath,
        file: {
          watchFactory: () => {
            throw new Error('watch unavailable');
          },
        },
        git: { run: async (_cwd, args) => gitResult(rootPath, args) },
        onEvidence: (item) => evidence.push(item.key),
        onError: (error) => errors.push(error),
      });

      await runtime.start();
      expect(runtime.isActive).toBe(true);
      expect(errors).toEqual([
        expect.objectContaining({ source: 'filesystem', message: 'watch unavailable' }),
      ]);
      expect(evidence.some((key) => key.endsWith(':baseline'))).toBe(true);
      runtime.stop();
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });
});

function gitResult(rootPath: string, args: readonly string[]) {
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel')
    return { stdout: `${rootPath}\n`, stderr: '', exitCode: 0 };
  if (args[0] === 'branch') return { stdout: 'main\n', stderr: '', exitCode: 0 };
  if (args[0] === 'rev-parse') return { stdout: 'head\n', stderr: '', exitCode: 0 };
  return { stdout: '', stderr: '', exitCode: 0 };
}
