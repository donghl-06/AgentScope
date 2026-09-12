import { describe, expect, it } from 'vitest';

import { CliUsageError, formatCliHelp, parseCliArgs } from './index.js';

describe('CLI argument parser', () => {
  it('parses top-level commands', () => {
    expect(parseCliArgs([])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['start'])).toEqual({ kind: 'start' });
    expect(
      parseCliArgs([
        'start',
        '--host',
        '0.0.0.0',
        '--port',
        '9000',
        '--db',
        'data.db',
        '--dashboard-port',
        '5174',
        '--no-dashboard',
      ]),
    ).toEqual({
      kind: 'start',
      host: '0.0.0.0',
      port: 9000,
      database: 'data.db',
      dashboard: false,
      dashboardPort: 5174,
    });
    expect(parseCliArgs(['sessions'])).toEqual({ kind: 'sessions' });
    expect(parseCliArgs(['recover'])).toEqual({ kind: 'recover' });
    expect(
      parseCliArgs([
        'orchestrate',
        '--provider',
        'claude',
        '--workspace',
        'D:/workspace',
        '--prompt',
        'Inspect the project',
        '--max-steps',
        '12',
      ]),
    ).toEqual({
      kind: 'orchestrate',
      provider: 'claude',
      workspace: 'D:/workspace',
      prompt: 'Inspect the project',
      maxSteps: 12,
    });
    expect(
      parseCliArgs(['orchestrate', '--provider', 'codex-app-server', '--', 'Inspect safely']),
    ).toEqual({
      kind: 'orchestrate',
      provider: 'codex-app-server',
      workspace: '.',
      prompt: 'Inspect safely',
    });
    expect(parseCliArgs(['claude', '--dangerously-skip-permissions', '-p', 'hello world'])).toEqual(
      {
        kind: 'interactive',
        adapter: 'claude',
        args: ['--dangerously-skip-permissions', '-p', 'hello world'],
      },
    );
    expect(
      parseCliArgs(['claude', '--agent-scope-accept-api-key', '--permission-mode', 'manual']),
    ).toEqual({
      kind: 'interactive',
      adapter: 'claude',
      args: ['--permission-mode', 'manual'],
      acceptApiKey: true,
    });
    expect(parseCliArgs(['codex', '--no-alt-screen', '-s', 'workspace-write'])).toEqual({
      kind: 'interactive',
      adapter: 'codex',
      args: ['--no-alt-screen', '-s', 'workspace-write'],
    });
    expect(parseCliArgs(['show', 'session-1'])).toEqual({
      kind: 'show',
      sessionId: 'session-1',
    });
    expect(parseCliArgs(['orchestrate', 'list', '--limit', '20'])).toEqual({
      kind: 'orchestrate-list',
      limit: 20,
    });
    expect(parseCliArgs(['orchestrate', 'show', 'goal-1'])).toEqual({
      kind: 'orchestrate-show',
      goalId: 'goal-1',
    });
    expect(
      parseCliArgs([
        'orchestrate',
        'instruct',
        'goal-1',
        '--kind',
        'constraint',
        '--content',
        'Keep tests deterministic.',
        '--base-revision',
        '2',
        '--idempotency-key',
        'instruction-1',
      ]),
    ).toEqual({
      kind: 'orchestrate-instruct',
      goalId: 'goal-1',
      instructionKind: 'constraint',
      content: 'Keep tests deterministic.',
      baseRevision: 2,
      idempotencyKey: 'instruction-1',
    });
    expect(
      parseCliArgs([
        'orchestrate',
        'continue',
        'goal-1',
        '--confirm-external-process-stopped',
        '--expected-revision',
        '2',
      ]),
    ).toEqual({
      kind: 'orchestrate-continue',
      goalId: 'goal-1',
      confirmExternalProcessStopped: true,
      expectedRevision: 2,
    });
  });

  it('preserves every argument after the run separator', () => {
    expect(parseCliArgs(['run', 'claude', '--', '--model', 'x y', '--', 'literal'])).toEqual({
      kind: 'run',
      adapter: 'claude',
      args: ['--model', 'x y', '--', 'literal'],
    });
  });

  it('parses the deterministic mock fixture shortcut', () => {
    expect(parseCliArgs(['run', 'mock', '--fixture', 'success'])).toEqual({
      kind: 'run-mock',
      fixture: 'success',
    });
  });

  it('rejects ambiguous or malformed command lines with usage errors', () => {
    for (const argv of [
      ['unknown'],
      ['show'],
      ['start', '--port'],
      ['run', 'claude'],
      ['orchestrate', '--provider', 'claude'],
      ['orchestrate', '--provider', 'unknown', '--prompt', 'x'],
      ['orchestrate', 'show'],
      ['orchestrate', 'instruct', 'goal-1', '--kind', 'unknown', '--content', 'x'],
      ['orchestrate', 'continue'],
      ['run', 'claude', '--cwd', 'workspace', '--', 'arg'],
      ['run', 'mock', '--fixture'],
    ]) {
      expect(() => parseCliArgs(argv)).toThrow(CliUsageError);
    }
  });

  it('renders stable help text', () => {
    expect(formatCliHelp()).toContain('run <adapter> -- <args...>');
    expect(formatCliHelp()).toContain('claude [--agent-scope-accept-api-key] [args...]');
    expect(formatCliHelp()).toContain('codex [args...]');
  });
});
