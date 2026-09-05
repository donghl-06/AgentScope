import { describe, expect, it } from 'vitest';

import { runProvider } from './provider-runner.js';

const workspacePath = process.cwd();

function script(result: string, exitCode: number): string {
  return `process.stdout.write(${JSON.stringify(`${result}\n`)}); process.exit(${exitCode});`;
}

describe('provider runner', () => {
  it('persists a Claude session from structured process output', async () => {
    const stdout: string[] = [];
    const result = await runProvider({
      adapter: 'claude',
      executable: process.execPath,
      args: [
        '-e',
        script(
          '{"type":"system","subtype":"init","session_id":"provider-1"}\n{"type":"result","subtype":"success","is_error":false}',
          0,
        ),
      ],
      filename: ':memory:',
      workspacePath,
      sessionId: 'session-1',
      writeStdout: (chunk) => stdout.push(chunk),
    });

    expect(result).toMatchObject({ sessionId: 'session-1', status: 'completed', exitCode: 0 });
    expect(result.eventCount).toBe(2);
    expect(stdout.join('')).toContain('provider-1');
  });

  it('uses the process exit code when provider result claims success', async () => {
    const result = await runProvider({
      adapter: 'claude',
      executable: process.execPath,
      args: ['-e', script('{"type":"result","subtype":"success","is_error":false}', 3)],
      filename: ':memory:',
      workspacePath,
      sessionId: 'session-failed',
    });

    expect(result).toMatchObject({ status: 'failed', exitCode: 1 });
  });
});
