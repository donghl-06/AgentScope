export type TerminalState = 'running' | 'disposing' | 'exited' | 'disposed';

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface TerminalExit {
  exitCode: number;
  signal?: number;
}

export interface TerminalSpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  dimensions?: TerminalDimensions;
  name?: string;
  encoding?: string | null;
}

export interface TerminalDisposable {
  dispose(): void;
}

export interface TerminalProcess {
  readonly pid: number;
  readonly onData: (listener: (data: string) => void) => TerminalDisposable;
  readonly onExit: (listener: (event: TerminalExit) => void) => TerminalDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Release PTY transport resources after the child has already exited. */
  release?(): void;
}

export interface TerminalDriver {
  spawn(spec: TerminalSpawnSpec): TerminalProcess;
}
