import { spawn } from 'node:child_process';

export type ProcessStdio = 'inherit' | 'pipe';

export interface ProcessRunnerOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: ProcessStdio;
  readonly signal?: AbortSignal;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface ProcessRunResult {
  readonly pid?: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError?: Error;
  readonly stdout?: string;
  readonly stderr?: string;
}

export function runProcess(options: ProcessRunnerOptions): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  const stdio = options.stdio ?? 'pipe';
  const child = spawn(options.executable, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: stdio === 'inherit' ? 'inherit' : ['inherit', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let abortHandler: (() => void) | undefined;

  if (stdio === 'pipe') {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });
  }

  const cleanupAbort = () => {
    if (abortHandler !== undefined && options.signal !== undefined) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  };

  const result = new Promise<ProcessRunResult>((resolve) => {
    const finish = (value: Omit<ProcessRunResult, 'startedAt' | 'endedAt'>) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      resolve({
        ...value,
        startedAt,
        endedAt: Date.now(),
        ...(stdio === 'pipe' ? { stdout, stderr } : {}),
      });
    };

    child.once('error', (error) => {
      finish({
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        exitCode: null,
        signal: null,
        spawnError: error,
      });
    });
    child.once('close', (exitCode, signal) => {
      finish({
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        exitCode,
        signal,
      });
    });

    if (options.signal !== undefined) {
      abortHandler = () => {
        if (!settled) child.kill();
      };
      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener('abort', abortHandler, { once: true });
    }
  });

  return result;
}

export function isSpawnError(result: ProcessRunResult): result is ProcessRunResult & {
  readonly spawnError: Error;
} {
  return result.spawnError !== undefined;
}
