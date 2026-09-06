import { describe, expect, it } from 'vitest';

import { runCli } from './main.js';

describe('CLI executable entry', () => {
  it('dispatches start with resolved defaults', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runCli({
      argv: ['start'],
      cwd: 'C:/workspace',
      env: {},
      write: (text) => output.push(text),
      writeError: (text) => errors.push(text),
      start: {
        run: async (options) => {
          expect(options).toMatchObject({
            cwd: 'C:/workspace',
            host: '127.0.0.1',
            port: 8787,
            dashboard: true,
            dashboardPort: 5173,
          });
          return 0;
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toEqual([]);
  });

  it('returns a user-facing error for an unknown mock fixture', async () => {
    const errors: string[] = [];
    const exitCode = await runCli({
      argv: ['run', 'mock', '--fixture', 'unknown'],
      cwd: 'C:/workspace',
      env: {},
      writeError: (text) => errors.push(text),
    });

    expect(exitCode).toBe(2);
    expect(errors).toEqual(['Unknown mock fixture: unknown\n']);
  });
});
