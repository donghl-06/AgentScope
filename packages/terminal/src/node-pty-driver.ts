import { spawn, type IPty, type IPtyForkOptions } from 'node-pty';

import type { TerminalDriver, TerminalProcess, TerminalSpawnSpec } from './types.js';

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
    onData: (listener) => pty.onData(listener),
    onExit: (listener) => pty.onExit(listener),
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
    release: () => releasePtyResources(pty),
  };
}

function releasePtyResources(pty: IPty): void {
  // node-pty 1.1 keeps the ConPTY worker alive after the child exit event so
  // it can drain final output. Its public API exposes kill(), but calling kill
  // after exit can try AttachConsole again on Windows. Release only the
  // transport handles through guarded internals once the child is known dead.
  const agent = (
    pty as unknown as {
      _agent?: {
        _inSocket?: { destroy(): void };
        _outSocket?: { destroy(): void };
        _conoutSocketWorker?: { dispose(): void };
      };
    }
  )._agent;
  try {
    agent?._inSocket?.destroy();
    agent?._outSocket?.destroy();
    agent?._conoutSocketWorker?.dispose();
  } catch {
    // Release is best-effort; the terminal has already emitted its exit event.
  }
}

export class NodePtyDriver implements TerminalDriver {
  spawn(spec: TerminalSpawnSpec): TerminalProcess {
    return adaptPty(spawn(spec.command, spec.args, toPtyOptions(spec)));
  }
}

export const nodePtyDriver = new NodePtyDriver();
