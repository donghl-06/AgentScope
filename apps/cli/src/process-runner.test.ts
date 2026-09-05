import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { isSpawnError, runProcess } from './process-runner.js';

describe('process runner', () => {
  it('spawns without a shell and preserves spaced arguments', async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
        'x y',
        '--flag',
        '$(not-a-command)',
        'a&b',
      ],
    });

    expect(result.spawnError).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? '')).toEqual(['x y', '--flag', '$(not-a-command)', 'a&b']);
    expect(result.pid).toBeTypeOf('number');
  });

  it('captures stderr and non-zero exit codes', async () => {
    const result = await runProcess({
      executable: process.execPath,
      args: ['-e', "process.stderr.write('failure'); process.exit(7)"],
    });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe('failure');
  });

  it('returns spawn errors instead of throwing', async () => {
    const result = await runProcess({ executable: 'agentscope-command-that-does-not-exist' });

    expect(isSpawnError(result)).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('terminates an aborted child and resolves its lifecycle result', async () => {
    const controller = new AbortController();
    const running = runProcess({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      signal: controller.signal,
    });
    controller.abort();

    const result = await running;
    expect(result.endedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });
});
