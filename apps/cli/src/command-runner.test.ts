import { describe, expect, it } from 'vitest';

import { parseCliArgs } from './index.js';
import {
  executeCliCommand,
  type CliCommandRunnerOptions,
  type CliExecutionError,
} from './command-runner.js';

describe('CLI command runner', () => {
  it('executes sessions and show with stable JSON output', async () => {
    const output: string[] = [];
    const client = {
      listSessions: async () => ({ items: [{ id: 'session-1' }], nextCursor: undefined }),
      getSession: async () => ({ id: 'session-1', status: 'completed' }),
      listEvents: async () => ({ items: [{ seq: 1 }], nextCursor: undefined }),
    } as unknown as NonNullable<CliCommandRunnerOptions['client']>;

    expect(
      await executeCliCommand(parseCliArgs(['sessions']), {
        client,
        write: (text) => output.push(text),
      }),
    ).toBe(0);
    expect(
      await executeCliCommand(parseCliArgs(['show', 'session-1']), {
        client,
        write: (text) => output.push(text),
      }),
    ).toBe(0);

    expect(JSON.parse(output[0]!)).toMatchObject({ items: [{ id: 'session-1' }] });
    expect(JSON.parse(output[1]!)).toMatchObject({
      session: { status: 'completed' },
      events: { items: [{ seq: 1 }] },
    });
  });

  it('executes mock fixtures and preserves their exit code', async () => {
    const output: string[] = [];
    const exitCode = await executeCliCommand(
      parseCliArgs(['run', 'mock', '--fixture', 'test-failure']),
      {
        runMock: async (fixture) => ({
          sessionId: 'session-1',
          status: fixture === 'test-failure' ? 'failed' : 'completed',
          exitCode: 1,
          eventCount: 5,
        }),
        write: (text) => output.push(text),
      },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('runs stale-session recovery and prints a safe summary', async () => {
    const output: string[] = [];
    const exitCode = await executeCliCommand(parseCliArgs(['recover']), {
      recover: async () => ({
        count: 1,
        recovered: [{ id: 'session-1', status: 'interrupted', endedAt: 100 }],
      }),
      write: (text) => output.push(text),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual({
      count: 1,
      recovered: [{ id: 'session-1', status: 'interrupted', endedAt: 100 }],
    });
  });

  it('returns explicit execution errors for unwired commands', async () => {
    await expect(
      executeCliCommand(parseCliArgs(['start']), { write: () => {} }),
    ).rejects.toMatchObject({
      code: 'not_implemented',
      exitCode: 2,
    } satisfies Partial<CliExecutionError>);
    await expect(
      executeCliCommand(parseCliArgs(['sessions']), { write: () => {} }),
    ).rejects.toMatchObject({
      code: 'missing_runtime',
      exitCode: 2,
    } satisfies Partial<CliExecutionError>);
  });

  it('delegates start to the injected server lifecycle', async () => {
    const output: string[] = [];
    const exitCode = await executeCliCommand(parseCliArgs(['start']), {
      start: async () => {
        output.push('started');
        return 0;
      },
      write: (text) => output.push(text),
    });

    expect(exitCode).toBe(0);
    expect(output).toEqual(['started']);
  });

  it('delegates provider runs without rewriting their argument list', async () => {
    const received: { adapter: string; args: readonly string[] }[] = [];
    const exitCode = await executeCliCommand(parseCliArgs(['run', 'claude', '--', '--bare']), {
      runAdapter: async (adapter, args) => {
        received.push({ adapter, args });
        return 7;
      },
      write: () => {},
    });

    expect(exitCode).toBe(7);
    expect(received).toEqual([{ adapter: 'claude', args: ['--bare'] }]);
  });

  it('delegates interactive Claude runs without rewriting their argument list', async () => {
    const received: { adapter: 'claude'; args: readonly string[] }[] = [];
    const exitCode = await executeCliCommand(
      parseCliArgs(['claude', '--permission-mode', 'manual']),
      {
        runInteractive: async (adapter, args) => {
          received.push({ adapter, args });
          return 130;
        },
        write: () => {},
      },
    );

    expect(exitCode).toBe(130);
    expect(received).toEqual([{ adapter: 'claude', args: ['--permission-mode', 'manual'] }]);
  });
});
