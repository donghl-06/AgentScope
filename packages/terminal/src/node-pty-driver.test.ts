import { describe, expect, it } from 'vitest';

import { nodePtyDriver } from '@agentscope/terminal';

import { TerminalSession } from './session.js';

const canRunNativePty = process.platform === 'win32' || process.platform === 'linux';

describe('NodePtyDriver native smoke', () => {
  it.runIf(canRunNativePty)(
    'preserves output, Unicode, resize, and cleanup lifecycle',
    async () => {
      const session = TerminalSession.spawn(nodePtyDriver, {
        command: process.execPath,
        args: [
          '-e',
          "process.stdout.write('READY:你好\\x1b[2J'); setTimeout(() => process.exit(0), 30);",
        ],
        dimensions: { cols: 100, rows: 30 },
      });
      const output: string[] = [];
      const exited = new Promise<void>((resolve) => session.onExit(() => resolve()));

      session.resize({ cols: 120, rows: 40 });
      for await (const chunk of session.output()) output.push(chunk);
      await exited;
      session.kill();
      session.dispose();

      expect(output.join('')).toContain('READY:你好');
      expect(session.state).toBe('exited');
      expect(session.exit?.exitCode).toBe(0);
    },
  );
});
