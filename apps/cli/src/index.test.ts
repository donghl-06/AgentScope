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
    expect(parseCliArgs(['show', 'session-1'])).toEqual({
      kind: 'show',
      sessionId: 'session-1',
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
      ['run', 'claude', '--cwd', 'workspace', '--', 'arg'],
      ['run', 'mock', '--fixture'],
    ]) {
      expect(() => parseCliArgs(argv)).toThrow(CliUsageError);
    }
  });

  it('renders stable help text', () => {
    expect(formatCliHelp()).toContain('run <adapter> -- <args...>');
    expect(formatCliHelp()).toContain('claude [--agent-scope-accept-api-key] [args...]');
  });
});
