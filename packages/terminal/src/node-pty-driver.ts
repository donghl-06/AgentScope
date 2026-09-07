import { spawn, type IPty, type IPtyForkOptions } from 'node-pty';

import type {
  TerminalDriver,
  TerminalProcess,
  TerminalSpawnSpec,
} from './types.js';

function toPtyOptions(spec: TerminalSpawnSpec): IPtyForkOptions {
  const dimensions = spec.dimensions ?? { cols: 120, rows: 30 };
  const options: IPtyForkOptions = {
    name: spec.name ?? 'xterm-256color',
    cols: dimensions.cols,
    rows: dimensions.rows,
    env: spec.env ?? process.env,
  };

  if (spec.cwd !== undefined) options.cwd = spec.cwd;
  if (spec.encoding !== undefined) options.encoding = spec.encoding;
  return options;
}

function adaptPty(pty: IPty): TerminalProcess {
  return {
    pid: pty.pid,
    onData: listener => pty.onData(listener),
    onExit: listener => pty.onExit(listener),
    write: data => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
  };
}

export class NodePtyDriver implements TerminalDriver {
  spawn(spec: TerminalSpawnSpec): TerminalProcess {
    return adaptPty(spawn(spec.command, spec.args, toPtyOptions(spec)));
  }
}

export const nodePtyDriver = new NodePtyDriver();
